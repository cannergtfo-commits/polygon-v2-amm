// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {BlazarMultiRewardStaking as M} from "../../src/BlazarMultiRewardStaking.sol";
import {MockERC20, TaxToken} from "../Mocks.sol";

contract MultiRewardHandler is Test {
    uint256 internal constant MIN = 1e15;
    M public s;
    MockERC20 public bzb;
    address public owner;
    address[] public actors;
    address[] public tokens; // reward tokens (includes bzb)
    mapping(address => uint256) public principal;
    mapping(address => uint256) public funded; // received by the contract for runs
    mapping(address => uint256) public paid; // credited amounts paid out
    uint256 public calls;

    constructor(M s_, MockERC20 bzb_, address owner_, address[] memory tokens_) {
        s = s_;
        bzb = bzb_;
        owner = owner_;
        tokens = tokens_;
        for (uint256 i; i < 4; ++i) {
            actors.push(makeAddr(string(abi.encodePacked("actor", vm.toString(i)))));
        }
    }

    function _warpBy(uint256 dt) internal {
        vm.warp(vm.getBlockTimestamp() + dt);
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _token(uint256 seed) internal view returns (address) {
        return tokens[seed % tokens.length];
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function tokensLength() external view returns (uint256) {
        return tokens.length;
    }

    function stake(uint256 seed, uint256 amount) external {
        calls++;
        if (s.paused()) return;
        amount = bound(amount, MIN, 1e27);
        address a = _actor(seed);
        bzb.mint(a, amount);
        vm.startPrank(a);
        bzb.approve(address(s), amount);
        s.stake(amount);
        vm.stopPrank();
        principal[a] += amount;
    }

    function withdraw(uint256 seed, uint256 amount) external {
        calls++;
        address a = _actor(seed);
        uint256 bal = s.balanceOf(a);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        if (bal - amount != 0 && bal - amount < MIN) amount = bal; // dust positions are not allowed
        uint256 before = bzb.balanceOf(a);
        vm.prank(a);
        s.withdraw(amount);
        assertEq(bzb.balanceOf(a) - before, amount, "withdraw exact");
        principal[a] -= amount;
    }

    function emergencyWithdraw(uint256 seed) external {
        calls++;
        address a = _actor(seed);
        uint256 bal = s.balanceOf(a);
        if (bal == 0) return;
        vm.prank(a);
        s.emergencyWithdraw();
        principal[a] = 0;
    }

    function claim(uint256 seed, uint256 tseed) external {
        calls++;
        address a = _actor(seed);
        address t = _token(tseed);
        uint256 e = s.earned(a, t);
        uint256 balBefore = MockERC20(t).balanceOf(address(s));
        vm.prank(a);
        s.claim(t);
        assertEq(balBefore - MockERC20(t).balanceOf(address(s)), e, "claim pays earned");
        paid[t] += e;
        assertEq(s.earned(a, t), 0);
    }

    function claimAll(uint256 seed) external {
        calls++;
        address a = _actor(seed);
        uint256[] memory e = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            e[i] = s.earned(a, tokens[i]);
        }
        vm.prank(a);
        s.claimAll();
        for (uint256 i; i < tokens.length; ++i) {
            paid[tokens[i]] += e[i];
        }
    }

    function notify(uint256 tseed, uint256 amount, uint256 duration, uint256 wS, uint256 wE, uint256 delay) external {
        calls++;
        address t = _token(tseed);
        amount = bound(amount, 1, 1e30);
        duration = bound(duration, 1 days, 365 days);
        wS = bound(wS, 0, 10_000);
        wE = bound(wE, 0, 10_000);
        if (wS + wE == 0) wE = 1;
        delay = bound(delay, 0, 30 days);
        if (s.paused() || s.activeRunCount(t) == s.MAX_RUNS_PER_TOKEN()) return;
        uint256 start = delay == 0 ? 0 : vm.getBlockTimestamp() + delay;
        MockERC20(t).mint(owner, amount);
        uint256 before = MockERC20(t).balanceOf(address(s));
        vm.startPrank(owner);
        MockERC20(t).approve(address(s), amount);
        s.notifyRewardAmount(
            M.RunConfig({
                token: t,
                amount: amount,
                duration: uint64(duration),
                startTime: uint64(start),
                startWeight: uint16(wS),
                endWeight: uint16(wE)
            })
        );
        vm.stopPrank();
        funded[t] += MockERC20(t).balanceOf(address(s)) - before;
    }

    function warp(uint256 dt) external {
        calls++;
        _warpBy(bound(dt, 1, 20 days));
    }

    function donate(uint256 tseed, uint256 amount) external {
        calls++;
        address t = _token(tseed);
        amount = bound(amount, 1, 1e24);
        MockERC20(t).mint(address(this), amount);
        MockERC20(t).transfer(address(s), amount);
    }

    function recover(uint256 tseed, uint256 amount) external {
        calls++;
        address t = _token(tseed);
        uint256 free = s.recoverable(t);
        if (free == 0) return;
        amount = bound(amount, 1, free);
        vm.prank(owner);
        s.recover(t, amount, owner);
    }

    /// Owner toggles pause. Withdraw/emergencyWithdraw/claim handlers do not skip when paused, so any
    /// pause-induced revert would surface as a failed call (fail_on_revert is set for this suite).
    function ownerTogglePause() external {
        calls++;
        vm.startPrank(owner);
        if (s.paused()) s.unpause();
        else s.pause();
        vm.stopPrank();
    }

    /// Owner tries to take more than the surplus of any token, including BZB. Must always revert.
    function ownerTryOverRecover(uint256 tseed, uint256 extra) external {
        calls++;
        address t = tseed % 2 == 0 ? address(bzb) : _token(tseed);
        uint256 bal = MockERC20(t).balanceOf(address(s));
        uint256 free = s.recoverable(t);
        if (free >= bal) return;
        uint256 amount = free + bound(extra, 1, bal - free);
        vm.prank(owner);
        try s.recover(t, amount, owner) {
            revert("owner over-recovered");
        } catch {}
    }

    /// Snapshot, withdraw an actor's full principal, check exact amount, roll back. Proves principal is
    /// withdrawable at every step of every sequence.
    function probeWithdrawAll(uint256 seed, bool emergency) external {
        calls++;
        address a = _actor(seed);
        uint256 bal = s.balanceOf(a);
        if (bal == 0) return;
        uint256 snap = vm.snapshotState();
        uint256 before = bzb.balanceOf(a);
        vm.prank(a);
        if (emergency) s.emergencyWithdraw();
        else s.withdraw(bal);
        assertEq(bzb.balanceOf(a) - before, bal, "probe: principal withdrawable");
        vm.revertToState(snap);
    }

    // ---- views for invariants

    function sumPrincipal() external view returns (uint256 sum) {
        for (uint256 i; i < actors.length; ++i) {
            sum += principal[actors[i]];
        }
    }

    function sumEarned(address t) public view returns (uint256 sum) {
        for (uint256 i; i < actors.length; ++i) {
            sum += s.earned(actors[i], t);
        }
    }

    function future(address t) public view returns (uint256) {
        return s.unemitted(t);
    }

    /// Withdraw every actor's principal and claim every token; used by afterInvariant.
    function drainAll() external {
        for (uint256 i; i < actors.length; ++i) {
            address a = actors[i];
            uint256 bal = s.balanceOf(a);
            uint256 before = bzb.balanceOf(a);
            vm.startPrank(a);
            if (bal > 0) s.withdraw(bal);
            vm.stopPrank();
            assertEq(bzb.balanceOf(a) - before, bal, "principal withdrawable");
            principal[a] = 0;
            for (uint256 j; j < tokens.length; ++j) {
                uint256 e = s.earned(a, tokens[j]);
                vm.prank(a);
                s.claim(tokens[j]);
                paid[tokens[j]] += e;
            }
        }
    }
}

/// forge-config: default.invariant.runs = 128
/// forge-config: default.invariant.depth = 60
/// forge-config: default.invariant.fail_on_revert = true
contract MultiRewardSolvencyInvariant is Test {
    uint256 internal constant MIN = 1e15;
    MultiRewardHandler internal h;
    M internal s;
    MockERC20 internal bzb;
    address[] internal tokens;

    function setUp() public {
        vm.warp(1_700_000_000);
        address owner = makeAddr("owner");
        bzb = new MockERC20("BlazarBits", "BZB", 18);
        s = new M(owner, address(bzb), MIN);
        tokens.push(address(bzb));
        tokens.push(address(new MockERC20("USD Coin", "USDC", 6)));
        tokens.push(address(new MockERC20("Wrapped POL", "WPOL", 18)));
        tokens.push(address(new TaxToken(300, makeAddr("sink"))));
        vm.startPrank(owner);
        s.addRewardTokens(tokens);
        vm.stopPrank();
        h = new MultiRewardHandler(s, bzb, owner, tokens);
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](13);
        sel[0] = h.stake.selector;
        sel[1] = h.withdraw.selector;
        sel[2] = h.emergencyWithdraw.selector;
        sel[3] = h.claim.selector;
        sel[4] = h.claimAll.selector;
        sel[5] = h.notify.selector;
        sel[6] = h.warp.selector;
        sel[7] = h.donate.selector;
        sel[8] = h.recover.selector;
        sel[9] = h.warp.selector;
        sel[10] = h.ownerTogglePause.selector;
        sel[11] = h.ownerTryOverRecover.selector;
        sel[12] = h.probeWithdrawAll.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    function invariant_principalAccounting() public view {
        assertEq(h.sumPrincipal(), s.totalStaked(), "sum principal");
        uint256 sum;
        for (uint256 i; i < h.actorsLength(); ++i) {
            sum += s.balanceOf(h.actors(i));
        }
        assertEq(sum, s.totalStaked(), "sum balances");
    }

    function invariant_perTokenSolvency() public view {
        for (uint256 i; i < tokens.length; ++i) {
            address t = tokens[i];
            assertGe(MockERC20(t).balanceOf(address(s)), s.reserved(t), "balance >= reserved");
        }
        assertGe(
            bzb.balanceOf(address(s)), s.totalStaked() + h.sumEarned(address(bzb)), "bzb covers principal + earned"
        );
    }

    function invariant_earnedNeverExceedsFunded() public view {
        for (uint256 i; i < tokens.length; ++i) {
            address t = tokens[i];
            assertLe(h.paid(t) + h.sumEarned(t) + h.future(t), h.funded(t), "paid + earned + future <= funded");
        }
    }

    function invariant_earnedCoveredByOwed() public view {
        for (uint256 i; i < tokens.length; ++i) {
            address t = tokens[i];
            uint256 principalPart = t == address(bzb) ? s.totalStaked() : 0;
            assertLe(h.sumEarned(t) + h.future(t) + principalPart, s.reserved(t), "earned + future <= reserved");
        }
    }

    /// Owner actions (pause, recover attempts, new runs) can never push BZB below principal + owed + unemitted.
    function invariant_principalUndrainable() public view {
        assertGe(
            bzb.balanceOf(address(s)),
            s.totalStaked() + s.owedStored(address(bzb)) + s.unemitted(address(bzb)),
            "bzb >= principal + owed + unemitted"
        );
        assertLe(
            s.recoverable(address(bzb)) + s.totalStaked(), bzb.balanceOf(address(s)), "recoverable excludes principal"
        );
    }

    /// P-1 guard: `owed` (incl. pending while staked) tracks Σ earned up to rounding dust. Catches
    /// over-reservation (rewards stranded in `owed`), which the <= invariants cannot.
    function invariant_owedMatchesEarned() public view {
        for (uint256 i; i < tokens.length; ++i) {
            address t = tokens[i];
            uint256 principalPart = t == address(bzb) ? s.totalStaked() : 0;
            uint256 owedNow = s.reserved(t) - s.unemitted(t) - principalPart;
            uint256 sum = h.sumEarned(t);
            assertLe(sum, owedNow, "earned <= owed");
            assertLe(owedNow - sum, 8 * h.calls() + 8, "owed - earned is only dust");
        }
    }

    /// Drains while possibly paused: proves pause never blocks exits or claims.
    function afterInvariant() public {
        h.drainAll();
        assertEq(s.totalStaked(), 0);
        for (uint256 i; i < tokens.length; ++i) {
            assertGe(MockERC20(tokens[i]).balanceOf(address(s)), s.reserved(tokens[i]), "post-drain solvency");
        }
    }
}
