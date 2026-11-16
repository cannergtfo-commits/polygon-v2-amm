// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {BlazarMultiRewardStaking as M} from "../../../src/BlazarMultiRewardStaking.sol";
import {MockERC20, TaxToken} from "../../Mocks.sol";
import {BlacklistToken} from "../../MultiRewardMocks.sol";
import {LyingToken} from "./Pass1Mocks.sol";

/// Adversarial handler: hostile owner (incl. ownership handoff), hostile / blacklisting / lying / taxed reward
/// tokens, BZB listed as a reward, partial claims, claimTo, exit, emergencyWithdraw. Withdraw paths are
/// NEVER wrapped in try/catch, so with fail_on_revert any principal freeze fails the campaign.
contract P1Handler is Test {
    uint256 internal constant MIN = 1e15;
    M public s;
    MockERC20 public bzb;
    MockERC20 public usdc;
    TaxToken public tax;
    BlacklistToken public blk;
    LyingToken public lie;
    address public owner;
    address[] public actors;
    address[] public toks;
    mapping(address => uint256) public principal;
    uint256 public calls;
    uint256 public ownerRecoverOk;
    uint256 public notifyOk;
    uint256 public claimFails;

    constructor(
        M s_,
        MockERC20 bzb_,
        MockERC20 usdc_,
        TaxToken tax_,
        BlacklistToken blk_,
        LyingToken lie_,
        address owner_
    ) {
        s = s_;
        bzb = bzb_;
        usdc = usdc_;
        tax = tax_;
        blk = blk_;
        lie = lie_;
        owner = owner_;
        toks.push(address(bzb));
        toks.push(address(usdc));
        toks.push(address(tax));
        toks.push(address(blk));
        toks.push(address(lie));
        for (uint256 i; i < 4; ++i) {
            actors.push(makeAddr(string(abi.encodePacked("p1actor", vm.toString(i)))));
        }
        actors.push(owner_); // the owner is also a staker
    }

    function _a(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _t(uint256 seed) internal view returns (address) {
        return toks[seed % toks.length];
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function toksLength() external view returns (uint256) {
        return toks.length;
    }

    function stake(uint256 seed, uint256 amt) external {
        calls++;
        if (s.paused()) return;
        address a = _a(seed);
        amt = bound(amt, MIN, 1e27);
        bzb.mint(a, amt);
        vm.startPrank(a);
        bzb.approve(address(s), amt);
        s.stake(amt);
        vm.stopPrank();
        principal[a] += amt;
    }

    function withdraw(uint256 seed, uint256 amt) external {
        calls++;
        address a = _a(seed);
        uint256 bal = s.balanceOf(a);
        if (bal == 0) return;
        amt = bound(amt, 1, bal);
        if (bal - amt != 0 && bal - amt < MIN) amt = bal;
        uint256 b0 = bzb.balanceOf(a);
        vm.prank(a);
        s.withdraw(amt);
        assertEq(bzb.balanceOf(a) - b0, amt, "withdraw exact");
        principal[a] -= amt;
    }

    function emergency(uint256 seed) external {
        calls++;
        address a = _a(seed);
        uint256 bal = s.balanceOf(a);
        if (bal == 0) return;
        uint256 b0 = bzb.balanceOf(a);
        vm.prank(a);
        s.emergencyWithdraw();
        assertEq(bzb.balanceOf(a) - b0, bal, "emergency exact");
        principal[a] = 0;
    }

    function exitOrWithdraw(uint256 seed) external {
        calls++;
        address a = _a(seed);
        uint256 bal = s.balanceOf(a);
        uint256 b0 = bzb.balanceOf(a);
        vm.prank(a);
        try s.exit() {}
        catch {
            if (bal > 0) {
                vm.prank(a);
                s.withdraw(bal);
            }
        }
        assertGe(bzb.balanceOf(a) - b0, bal, "exit returns principal");
        principal[a] = 0;
    }

    function claim(uint256 seed, uint256 tseed) external {
        calls++;
        address a = _a(seed);
        address t = _t(tseed);
        vm.prank(a);
        try s.claim(t) {}
        catch {
            claimFails++;
            require(t == address(blk) || t == address(lie), "honest claim failed");
        }
    }

    function claimTo(uint256 seed, uint256 tseed, uint256 toSeed) external {
        calls++;
        address a = _a(seed);
        address to = _a(toSeed % 1000 + 1);
        vm.prank(a);
        try s.claimTo(_t(tseed), to) {}
        catch {
            claimFails++;
        }
    }

    function claimManySubset(uint256 seed, uint8 mask) external {
        calls++;
        address a = _a(seed);
        uint256 n;
        for (uint256 i; i < toks.length; ++i) {
            if (mask & (1 << i) != 0) n++;
        }
        address[] memory list = new address[](n);
        n = 0;
        for (uint256 i; i < toks.length; ++i) {
            if (mask & (1 << i) != 0) list[n++] = toks[i];
        }
        vm.prank(a);
        try s.claimMany(list) {}
        catch {
            claimFails++;
        }
    }

    function ownerNotify(uint256 tseed, uint256 amt, uint256 dur, uint256 wS, uint256 wE, uint256 delay) external {
        calls++;
        address t = _t(tseed);
        dur = bound(dur, 1 days, 365 days);
        wS = bound(wS, 0, 10_000);
        wE = bound(wE, 0, 10_000);
        if (wS + wE == 0) wS = 1;
        delay = bound(delay, 0, 30 days);
        uint256 st = delay == 0 ? 0 : vm.getBlockTimestamp() + delay;
        if (t == address(lie)) {
            amt = bound(amt, 1, type(uint128).max);
        } else {
            amt = bound(amt, 1, 1e30);
            if (t == address(blk) && blk.frozen()) return; // token-level freeze: funding impossible, not a staking bug
            if (t == address(blk)) {
                try blk.mint(owner, amt) {}
                catch {
                    return;
                }
            } else if (t == address(tax)) {
                tax.mint(owner, amt);
            } else {
                MockERC20(t).mint(owner, amt);
            }
            vm.prank(owner);
            MockERC20(t).approve(address(s), amt);
        }
        vm.prank(owner);
        try s.notifyRewardAmount(
            M.RunConfig({
                token: t,
                amount: amt,
                duration: uint64(dur),
                startTime: uint64(st),
                startWeight: uint16(wS),
                endWeight: uint16(wE)
            })
        ) {
            notifyOk++;
        } catch {}
    }

    /// Owner tries to pull an arbitrary amount of any token (incl. BZB) to itself.
    function ownerRecover(uint256 tseed, uint256 amt, bool max) external {
        calls++;
        address t = _t(tseed);
        if (max) amt = bzb.balanceOf(address(s));
        amt = bound(amt, 1, type(uint128).max);
        vm.prank(owner);
        try s.recover(t, amt, owner) {
            ownerRecoverOk++;
        } catch {}
    }

    function ownerAddToken(uint256 tseed) external {
        calls++;
        vm.prank(owner);
        try s.addRewardToken(address(uint160(tseed))) {} catch {}
    }

    function ownerPause() external {
        calls++;
        vm.startPrank(owner);
        if (s.paused()) s.unpause();
        else s.pause();
        vm.stopPrank();
    }

    function ownerHandoff(uint256 seed) external {
        calls++;
        address n = makeAddr(string(abi.encodePacked("owner", vm.toString(seed % 3))));
        if (n == owner) return;
        vm.prank(owner);
        s.transferOwnership(n);
        vm.prank(n);
        s.acceptOwnership();
        owner = n;
    }

    function tokenBlacklist(uint256 seed, bool on, bool contractToo, bool freeze) external {
        calls++;
        blk.setBlocked(_a(seed), on);
        if (contractToo) blk.setBlocked(address(s), on);
        blk.setFrozen(freeze && on);
    }

    function donate(uint256 tseed, uint256 amt) external {
        calls++;
        address t = _t(tseed);
        amt = bound(amt, 1, 1e24);
        if (t == address(lie)) {
            lie.bump(amt);
            return;
        }
        if (t == address(blk) && (blk.frozen() || blk.blocked(address(s)))) return;
        if (t == address(tax)) tax.mint(address(s), amt);
        else if (t == address(blk)) blk.mint(address(s), amt);
        else MockERC20(t).mint(address(s), amt);
    }

    function warp(uint256 dt) external {
        calls++;
        vm.warp(vm.getBlockTimestamp() + bound(dt, 1, 25 days));
    }

    /// Every staker can withdraw (and separately emergencyWithdraw) its exact principal right now.
    function probeAll() external {
        calls++;
        for (uint256 i; i < actors.length; ++i) {
            address a = actors[i];
            uint256 bal = s.balanceOf(a);
            if (bal == 0) continue;
            uint256 snap = vm.snapshotState();
            uint256 b0 = bzb.balanceOf(a);
            vm.prank(a);
            s.withdraw(bal);
            assertEq(bzb.balanceOf(a) - b0, bal, "probe withdraw");
            vm.revertToState(snap);
            snap = vm.snapshotState();
            vm.prank(a);
            s.emergencyWithdraw();
            assertEq(bzb.balanceOf(a) - b0, bal, "probe emergency");
            vm.revertToState(snap);
        }
    }

    function sumEarned(address t) external view returns (uint256 sum) {
        for (uint256 i; i < actors.length; ++i) {
            sum += s.earned(actors[i], t);
        }
    }

    function sumPrincipal() external view returns (uint256 sum) {
        for (uint256 i; i < actors.length; ++i) {
            sum += principal[actors[i]];
        }
    }

    function drainAllPrincipal() external {
        for (uint256 i; i < actors.length; ++i) {
            address a = actors[i];
            uint256 bal = s.balanceOf(a);
            if (bal == 0) continue;
            uint256 b0 = bzb.balanceOf(a);
            vm.prank(a);
            s.withdraw(bal);
            assertEq(bzb.balanceOf(a) - b0, bal, "drain exact");
            principal[a] = 0;
        }
    }
}

/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 128
/// forge-config: default.invariant.fail_on_revert = true
contract Pass1PrincipalInvariant is Test {
    uint256 internal constant MIN = 1e15;
    P1Handler internal h;
    M internal s;
    MockERC20 internal bzb;
    MockERC20 internal usdc;
    TaxToken internal tax;
    BlacklistToken internal blk;
    LyingToken internal lie;

    function setUp() public {
        vm.warp(1_700_000_000);
        address owner = makeAddr("owner0");
        bzb = new MockERC20("BlazarBits", "BZB", 18);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        tax = new TaxToken(300, makeAddr("sink"));
        blk = new BlacklistToken();
        lie = new LyingToken();
        s = new M(owner, address(bzb), MIN);
        lie.setVictim(address(s));
        address[] memory list = new address[](5);
        list[0] = address(bzb);
        list[1] = address(usdc);
        list[2] = address(tax);
        list[3] = address(blk);
        list[4] = address(lie);
        vm.prank(owner);
        s.addRewardTokens(list);
        h = new P1Handler(s, bzb, usdc, tax, blk, lie, owner);
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](19);
        sel[0] = h.stake.selector;
        sel[1] = h.withdraw.selector;
        sel[2] = h.emergency.selector;
        sel[3] = h.exitOrWithdraw.selector;
        sel[4] = h.claim.selector;
        sel[5] = h.claimTo.selector;
        sel[6] = h.claimManySubset.selector;
        sel[7] = h.ownerNotify.selector;
        sel[8] = h.ownerRecover.selector;
        sel[9] = h.ownerAddToken.selector;
        sel[10] = h.ownerPause.selector;
        sel[11] = h.ownerHandoff.selector;
        sel[12] = h.tokenBlacklist.selector;
        sel[13] = h.donate.selector;
        sel[14] = h.warp.selector;
        sel[15] = h.probeAll.selector;
        sel[16] = h.stake.selector;
        sel[17] = h.ownerNotify.selector;
        sel[18] = h.warp.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    function invariant_P1_principalNeverDrained() public view {
        assertGe(
            bzb.balanceOf(address(s)),
            s.totalStaked() + s.owedStored(address(bzb)) + s.unemitted(address(bzb)),
            "bzb covers principal+owed+unemitted"
        );
        assertGe(bzb.balanceOf(address(s)), s.totalStaked() + h.sumEarned(address(bzb)), "bzb covers principal+earned");
    }

    function invariant_P1_principalAccounting() public view {
        uint256 sum;
        for (uint256 i; i < h.actorsLength(); ++i) {
            sum += s.balanceOf(h.actors(i));
        }
        assertEq(sum, s.totalStaked());
        assertEq(h.sumPrincipal(), s.totalStaked());
    }

    function invariant_P1_honestTokenSolvencyAndOwed() public view {
        address[4] memory honest = [address(bzb), address(usdc), address(tax), address(blk)];
        for (uint256 i; i < 4; ++i) {
            address t = honest[i];
            assertGe(MockERC20(t).balanceOf(address(s)), s.reserved(t), "balance >= reserved");
            uint256 pp = t == address(bzb) ? s.totalStaked() : 0;
            uint256 owedNow = s.reserved(t) - s.unemitted(t) - pp;
            uint256 sum = h.sumEarned(t);
            assertLe(sum, owedNow, "earned <= owed");
            assertLe(owedNow - sum, 10 * h.calls() + 10, "owed-earned dust");
        }
    }

    function invariant_P1_runSlotsWellFormed() public view {
        for (uint256 i; i < h.toksLength(); ++i) {
            address t = h.toks(i);
            for (uint256 j; j < 5; ++j) {
                M.Run memory r = s.getRun(t, j);
                if (r.amount == 0) {
                    assertEq(r.emitted, 0);
                    continue;
                }
                assertLt(r.emitted, r.amount, "stored emitted < amount");
                assertGe(r.duration, 1 days);
                assertLe(r.duration, 365 days);
            }
        }
    }

    function afterInvariant() public {
        h.drainAllPrincipal();
        assertEq(s.totalStaked(), 0);
    }
}
