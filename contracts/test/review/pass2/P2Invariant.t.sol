// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {BlazarMultiRewardStaking as M} from "../../../src/BlazarMultiRewardStaking.sol";
import {MockERC20, TaxToken} from "../../Mocks.sol";

/// Independent pass-2 handler: partial claims, claimManyTo, exit, emergency exits, BZB-as-reward, fee-on-transfer
/// reward, delayed runs, long zero-stake gaps, donations, owner max-recover and over-recover attempts, pausing,
/// and a liveness probe that every staker can always withdraw AND emergencyWithdraw exact principal.
contract P2Handler is Test {
    uint256 internal constant MIN = 1e15;
    M public s;
    MockERC20 public bzb;
    address public owner;
    address[] public actors;
    address[] public toks;
    mapping(address => mapping(address => uint256)) public lastSeen; // actor => token => paid+earned baseline
    mapping(address => mapping(address => uint256)) public paidGhost;
    mapping(address => uint256) public funded;
    uint256 public monotonicViolations;
    uint256 public livenessFailures;
    uint256 public overRecoverSuccesses;

    constructor(M s_, MockERC20 bzb_, address owner_, address[] memory toks_) {
        s = s_;
        bzb = bzb_;
        owner = owner_;
        toks = toks_;
        for (uint256 i; i < 4; ++i) {
            address a = makeAddr(string(abi.encodePacked("p2actor", vm.toString(i))));
            actors.push(a);
            vm.prank(a);
            bzb.approve(address(s_), type(uint256).max);
        }
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function nActors() external view returns (uint256) {
        return actors.length;
    }

    function nToks() external view returns (uint256) {
        return toks.length;
    }

    function _total(address a, address t) internal view returns (uint256) {
        return paidGhost[a][t] + s.earned(a, t);
    }

    /// Earned+paid per user/token must never decrease (except the user's own emergency exit, which re-baselines).
    function _checkMonotone(address skip) internal {
        for (uint256 i; i < actors.length; ++i) {
            address a = actors[i];
            for (uint256 j; j < toks.length; ++j) {
                uint256 v = _total(a, toks[j]);
                if (a != skip && v + 2 < lastSeen[a][toks[j]]) ++monotonicViolations;
                lastSeen[a][toks[j]] = v;
            }
        }
    }

    function _claimTrack(address a, address t) internal view returns (uint256) {
        return s.earned(a, t);
    }

    function stake(uint256 seed, uint256 amt) external {
        if (s.paused()) return;
        address a = actors[seed % actors.length];
        amt = bound(amt, MIN, 1e27);
        bzb.mint(a, amt);
        vm.prank(a);
        s.stake(amt);
        _checkMonotone(address(0));
    }

    function withdraw(uint256 seed, uint256 amt) external {
        address a = actors[seed % actors.length];
        uint256 bal = s.balanceOf(a);
        if (bal == 0) return;
        amt = bound(amt, 1, bal);
        if (bal - amt != 0 && bal - amt < MIN) amt = bal;
        vm.prank(a);
        s.withdraw(amt);
        _checkMonotone(address(0));
    }

    function emergency(uint256 seed) external {
        address a = actors[seed % actors.length];
        if (s.balanceOf(a) == 0) return;
        vm.prank(a);
        s.emergencyWithdraw();
        _checkMonotone(a);
    }

    function claimOne(uint256 seed, uint256 ts) external {
        address a = actors[seed % actors.length];
        address t = toks[ts % toks.length];
        uint256 e = s.earned(a, t);
        vm.prank(a);
        s.claim(t);
        paidGhost[a][t] += e;
        _checkMonotone(address(0));
    }

    function claimSubsetTo(uint256 seed, uint256 mask) external {
        address a = actors[seed % actors.length];
        uint256 n;
        for (uint256 j; j < toks.length; ++j) {
            if ((mask >> j) & 1 == 1) ++n;
        }
        address[] memory sub = new address[](n);
        n = 0;
        for (uint256 j; j < toks.length; ++j) {
            if ((mask >> j) & 1 == 1) {
                sub[n++] = toks[j];
                paidGhost[a][toks[j]] += s.earned(a, toks[j]);
            }
        }
        vm.prank(a);
        s.claimManyTo(sub, makeAddr("sink2"));
        _checkMonotone(address(0));
    }

    function exitAll(uint256 seed) external {
        address a = actors[seed % actors.length];
        for (uint256 j; j < toks.length; ++j) {
            paidGhost[a][toks[j]] += s.earned(a, toks[j]);
        }
        vm.prank(a);
        s.exit();
        _checkMonotone(address(0));
    }

    function notify(uint256 ts, uint256 amt, uint256 dur, uint256 wS, uint256 wE, uint256 delay) external {
        if (s.paused()) return;
        address t = toks[ts % toks.length];
        if (s.activeRunCount(t) == 5) return;
        amt = bound(amt, 1e6, 1e27);
        dur = bound(dur, 1 days, 365 days);
        wS = bound(wS, 0, 10_000);
        wE = bound(wE, wS == 0 ? 1 : 0, 10_000);
        delay = bound(delay, 0, 30 days);
        MockERC20(t).mint(owner, amt);
        uint256 before = MockERC20(t).balanceOf(address(s));
        vm.startPrank(owner);
        MockERC20(t).approve(address(s), amt);
        s.notifyRewardAmount(
            M.RunConfig(t, amt, uint64(dur), uint64(delay == 0 ? 0 : _now() + delay), uint16(wS), uint16(wE))
        );
        vm.stopPrank();
        funded[t] += MockERC20(t).balanceOf(address(s)) - before;
        _checkMonotone(address(0));
    }

    function warp(uint256 dt) external {
        vm.warp(_now() + bound(dt, 1, 40 days));
        _checkMonotone(address(0));
    }

    function donate(uint256 ts, uint256 amt) external {
        address t = toks[ts % toks.length];
        MockERC20(t).mint(address(s), bound(amt, 1, 1e24));
    }

    function recoverMax(uint256 ts) external {
        address t = toks[ts % toks.length];
        uint256 r = s.recoverable(t);
        if (r == 0) return;
        vm.prank(owner);
        s.recover(t, r, owner);
        _checkMonotone(address(0));
    }

    function overRecover(uint256 ts, uint256 extra) external {
        address t = toks[ts % toks.length];
        uint256 r = s.recoverable(t) + bound(extra, 1, 1e30);
        vm.prank(owner);
        try s.recover(t, r, owner) {
            ++overRecoverSuccesses;
        } catch {}
    }

    function togglePause() external {
        vm.startPrank(owner);
        if (s.paused()) s.unpause();
        else s.pause();
        vm.stopPrank();
    }

    /// Liveness: from the current state, every staker can withdraw AND (separately) emergencyWithdraw exactly.
    function probe() external {
        uint256 snap = vm.snapshotState();
        for (uint256 i; i < actors.length; ++i) {
            address a = actors[i];
            uint256 bal = s.balanceOf(a);
            if (bal == 0) continue;
            uint256 b0 = bzb.balanceOf(a);
            vm.prank(a);
            try s.withdraw(bal) {
                if (bzb.balanceOf(a) - b0 != bal) ++livenessFailures;
            } catch {
                ++livenessFailures;
            }
        }
        vm.revertToState(snap);
        snap = vm.snapshotState();
        for (uint256 i; i < actors.length; ++i) {
            address a = actors[i];
            uint256 bal = s.balanceOf(a);
            if (bal == 0) continue;
            uint256 b0 = bzb.balanceOf(a);
            vm.prank(a);
            try s.emergencyWithdraw() {
                if (bzb.balanceOf(a) - b0 != bal) ++livenessFailures;
            } catch {
                ++livenessFailures;
            }
        }
        vm.revertToState(snap);
    }
}

/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 128
/// forge-config: default.invariant.fail_on_revert = true
contract P2Invariant is Test {
    P2Handler internal h;
    M internal s;
    MockERC20 internal bzb;
    address[] internal toks;

    function setUp() public {
        vm.warp(1_700_000_000);
        address owner = makeAddr("owner");
        bzb = new MockERC20("BZB", "BZB", 18);
        s = new M(owner, address(bzb), 1e15);
        toks.push(address(bzb));
        toks.push(address(new MockERC20("USDC", "USDC", 6)));
        toks.push(address(new MockERC20("WPOL", "WPOL", 18)));
        toks.push(address(new TaxToken(500, makeAddr("taxsink"))));
        toks.push(address(new MockERC20("WBTC", "WBTC", 8)));
        vm.prank(owner);
        s.addRewardTokens(toks);
        h = new P2Handler(s, bzb, owner, toks);
        targetContract(address(h));
    }

    function invariant_P2_solvencyAndPrincipal() public view {
        uint256 sum;
        for (uint256 i; i < h.nActors(); ++i) {
            sum += s.balanceOf(h.actors(i));
        }
        assertEq(sum, s.totalStaked(), "sum balances");
        assertTrue(s.totalStaked() == 0 || s.totalStaked() >= 1e15, "ts bound");
        for (uint256 j; j < toks.length; ++j) {
            address t = toks[j];
            uint256 res = s.reserved(t);
            assertGe(MockERC20(t).balanceOf(address(s)), res, "bal >= reserved");
            uint256 sumE;
            for (uint256 i; i < h.nActors(); ++i) {
                sumE += s.earned(h.actors(i), t);
            }
            uint256 owedNow = res - s.unemitted(t) - (t == address(bzb) ? s.totalStaked() : 0);
            assertLe(sumE, owedNow, "earned <= owed");
            assertLe(owedNow - sumE, 1e4, "owed - earned dust bounded");
            assertLe(s.activeRunCount(t), 5, "runs");
        }
        assertGe(bzb.balanceOf(address(s)), s.totalStaked(), "principal backed");
    }

    function invariant_P2_ghosts() public view {
        assertEq(h.monotonicViolations(), 0, "earned+paid decreased");
        assertEq(h.livenessFailures(), 0, "withdraw/emergency liveness");
        assertEq(h.overRecoverSuccesses(), 0, "over-recover");
    }

    function invariant_P2_paidNeverExceedsFunded() public view {
        for (uint256 j; j < toks.length; ++j) {
            address t = toks[j];
            uint256 tot;
            for (uint256 i; i < h.nActors(); ++i) {
                tot += h.paidGhost(h.actors(i), t) + s.earned(h.actors(i), t);
            }
            assertLe(tot, h.funded(t), "paid+earned <= funded");
        }
    }
}
