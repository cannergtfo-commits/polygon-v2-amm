// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {BlazarMultiRewardStaking as M} from "../../../src/BlazarMultiRewardStaking.sol";
import {MockERC20, TaxToken} from "../../Mocks.sol";
import {HostileToken, SlashableToken} from "./P2Mocks.sol";

/// Pass-2 independent review tests (local only; defensive regression/proof tests, no exploit tooling).
contract P2ReviewTest is Test {
    uint256 internal constant MIN = 1e15;
    M internal s;
    MockERC20 internal bzb;
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public {
        vm.warp(1_700_000_000);
        bzb = new MockERC20("BlazarBits", "BZB", 18);
        s = new M(owner, address(bzb), MIN);
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _warp(uint256 dt) internal {
        vm.warp(vm.getBlockTimestamp() + dt);
    }

    function _list(address t) internal {
        vm.prank(owner);
        s.addRewardToken(t);
    }

    function _fund(address token, uint256 amount, uint64 duration, uint64 startTime) internal {
        MockERC20(token).mint(owner, amount);
        vm.startPrank(owner);
        MockERC20(token).approve(address(s), amount);
        s.notifyRewardAmount(
            M.RunConfig({
                token: token,
                amount: amount,
                duration: duration,
                startTime: startTime,
                startWeight: 10_000,
                endWeight: 10_000
            })
        );
        vm.stopPrank();
    }

    function _stake(address who, uint256 amount) internal {
        bzb.mint(who, amount);
        vm.startPrank(who);
        bzb.approve(address(s), amount);
        s.stake(amount);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ (e) withdraw / emergencyWithdraw liveness

    /// Five listed reward tokens that revert on EVERY call (incl. balanceOf) cannot block stake/withdraw/emergency.
    function test_P2_hostileRewardTokensCannotBlockPrincipal() public {
        HostileToken[5] memory h;
        for (uint256 i; i < 5; ++i) {
            h[i] = new HostileToken();
            _list(address(h[i]));
            for (uint256 j; j < 5; ++j) {
                _fund(address(h[i]), 1e24, uint64(10 days + j), 0);
            }
        }
        _stake(alice, 10 ether);
        _stake(bob, 10 ether);
        _warp(3 days);
        for (uint256 i; i < 5; ++i) {
            h[i].setMode(1); // revert everything
        }
        _stake(carol, 1 ether); // stake still works
        vm.prank(alice);
        s.withdraw(10 ether);
        assertEq(bzb.balanceOf(alice), 10 ether);
        for (uint256 i; i < 5; ++i) {
            h[i].setMode(2); // infinite loop / gas burn
        }
        vm.prank(bob);
        s.emergencyWithdraw();
        assertEq(bzb.balanceOf(bob), 10 ether);
        vm.prank(carol);
        s.withdraw(1 ether);
        assertEq(s.totalStaked(), 0);
        // Rewards are still credited and claimable once the token behaves again.
        for (uint256 i; i < 5; ++i) {
            h[i].setMode(0);
        }
        vm.prank(alice);
        s.claim(address(h[0]));
        assertGt(h[0].balanceOf(alice), 0);
    }

    // ------------------------------------------------------------ (a) emergencyWithdraw stale-window forfeiture

    /// L-1 regression (was P2-01): a lone staker who only uses emergencyWithdraw after a long untouched window
    /// is now credited the full window (emergencyWithdraw checkpoints every listed token), and nothing is
    /// owner-recoverable.
    function test_P2_emergencyStaleWindowForfeitedToOwner() public {
        MockERC20 usdc = new MockERC20("USDC", "USDC", 6);
        _list(address(usdc));
        _stake(alice, 10 ether); // checkpoint at t0 (nothing emitted yet)
        _fund(address(usdc), 30_000e6, 30 days, 0);
        _warp(29 days); // nobody touches usdc for 29 days
        uint256 earnedBefore = s.earned(alice, address(usdc));
        assertApproxEqRel(earnedBefore, 29_000e6, 1e15);
        vm.prank(alice);
        s.emergencyWithdraw();
        uint256 credited = s.rewards(alice, address(usdc));
        emit log_named_uint("earned() before emergencyWithdraw", earnedBefore);
        emit log_named_uint("credited by emergencyWithdraw", credited);
        assertEq(credited, earnedBefore, "full window credited");
        assertLe(s.recoverable(address(usdc)), 1, "nothing forfeited to owner");
        vm.prank(alice);
        s.claim(address(usdc));
        assertEq(usdc.balanceOf(alice), earnedBefore);
    }

    /// Same window, but a mere claim() by ANY user on that token before the emergency exit would have saved it:
    /// shows the forfeiture comes only from skipping a pure-storage checkpoint.
    function test_P2_emergencyAfterAnyCheckpointKeepsShare() public {
        MockERC20 usdc = new MockERC20("USDC", "USDC", 6);
        _list(address(usdc));
        _stake(alice, 10 ether);
        _fund(address(usdc), 30_000e6, 30 days, 0);
        _warp(29 days);
        vm.prank(bob);
        s.claim(address(usdc)); // bob has no stake; this only checkpoints usdc
        vm.prank(alice);
        s.emergencyWithdraw();
        assertApproxEqRel(s.rewards(alice, address(usdc)), 29_000e6, 1e15);
        assertLe(s.recoverable(address(usdc)), 1);
    }

    // ------------------------------------------------------------ (a) partial-claim drift (differential)

    /// Twin contracts, same stake/withdraw schedule. In `a` users additionally claim single tokens at random
    /// times; in `b` they never claim until the end. Final (paid + earned) per user per token must match up to
    /// rounding dust. Proves partial per-token settlement does not drift vs stake changes.
    function testFuzz_P2_partialClaimNoDrift(uint256 seed) public {
        M a = new M(owner, address(bzb), MIN);
        M b = new M(owner, address(bzb), MIN);
        MockERC20[3] memory t;
        for (uint256 i; i < 3; ++i) {
            t[i] = new MockERC20("R", "R", uint8(i == 0 ? 6 : 18));
            vm.startPrank(owner);
            a.addRewardToken(address(t[i]));
            b.addRewardToken(address(t[i]));
            vm.stopPrank();
        }
        address[3] memory u = [alice, bob, carol];
        for (uint256 k; k < 3; ++k) {
            bzb.mint(u[k], 1e30);
            vm.startPrank(u[k]);
            bzb.approve(address(a), type(uint256).max);
            bzb.approve(address(b), type(uint256).max);
            vm.stopPrank();
        }
        for (uint256 i; i < 3; ++i) {
            for (uint256 j; j < 3; ++j) {
                uint256 amt = bound(uint256(keccak256(abi.encode(seed, i, j))), 1e6, 1e27);
                uint64 dur = uint64(bound(uint256(keccak256(abi.encode(seed, i, j, 1))), 1 days, 60 days));
                uint64 st = uint64(_now() + bound(uint256(keccak256(abi.encode(seed, i, j, 2))), 0, 10 days));
                t[i].mint(owner, 2 * amt);
                vm.startPrank(owner);
                t[i].approve(address(a), amt);
                t[i].approve(address(b), amt);
                M.RunConfig memory c =
                    M.RunConfig(address(t[i]), amt, dur, st, uint16(1 + j * 3000), uint16(9000 - j * 2000));
                a.notifyRewardAmount(c);
                b.notifyRewardAmount(c);
                vm.stopPrank();
            }
        }
        uint256[3][3] memory paidA;
        for (uint256 step; step < 40; ++step) {
            uint256 r = uint256(keccak256(abi.encode(seed, "step", step)));
            _warp(bound(r, 1, 3 days));
            address who = u[(r >> 8) % 3];
            uint256 op = (r >> 16) % 4;
            if (op == 0) {
                uint256 amt = bound(r >> 32, MIN, 1e24);
                vm.startPrank(who);
                a.stake(amt);
                b.stake(amt);
                vm.stopPrank();
            } else if (op == 1) {
                uint256 bal = a.balanceOf(who);
                if (bal == 0) continue;
                vm.startPrank(who);
                a.withdraw(bal);
                b.withdraw(bal);
                vm.stopPrank();
            } else {
                uint256 ti = (r >> 40) % 3;
                uint256 before = t[ti].balanceOf(who);
                vm.prank(who);
                a.claim(address(t[ti]));
                paidA[(r >> 8) % 3][ti] += t[ti].balanceOf(who) - before;
            }
        }
        _warp(80 days);
        for (uint256 k; k < 3; ++k) {
            for (uint256 i; i < 3; ++i) {
                uint256 totA = paidA[k][i] + a.earned(u[k], address(t[i]));
                uint256 totB = b.earned(u[k], address(t[i]));
                assertApproxEqAbs(totA, totB, 50, "partial-claim drift");
            }
        }
    }

    // ------------------------------------------------------------ (c) overflow bounds under max owner pressure

    /// Worst case the owner can force: 5 tokens x 5 runs of MAX_RUN_AMOUNT, 1-day runs, re-funded every day,
    /// totalStaked == minStake. Checkpoints / withdraw / emergency never revert; extrapolate headroom.
    function test_P2_accumulatorHeadroomAtMaxPressure() public {
        MockERC20[5] memory t;
        for (uint256 i; i < 5; ++i) {
            t[i] = new MockERC20("X", "X", 18);
            _list(address(t[i]));
        }
        _stake(alice, MIN);
        uint256 maxAmt = s.MAX_RUN_AMOUNT();
        for (uint256 day; day < 20; ++day) {
            for (uint256 i; i < 5; ++i) {
                for (uint256 j; j < 5; ++j) {
                    _fund(address(t[i]), maxAmt, 1 days, 0);
                }
            }
            _warp(1 days);
            vm.prank(alice);
            s.claimAll();
            for (uint256 i; i < 5; ++i) {
                uint256 b_ = t[i].balanceOf(alice);
                vm.prank(alice);
                t[i].transfer(address(0xdead), b_);
            }
        }
        uint256 rpt = s.rewardPerToken(address(t[0]));
        emit log_named_uint("rpt after 20 max-pressure days (log2 approx)", _log2(rpt));
        emit log_named_uint("days to overflow at this pace (log2 approx)", 256 - _log2(rpt / 20));
        assertLt(_log2(rpt), 210);
        // still fully exitable
        vm.prank(alice);
        s.emergencyWithdraw();
        assertEq(bzb.balanceOf(alice), MIN);
    }

    function _log2(uint256 x) internal pure returns (uint256 r) {
        while (x > 1) {
            x >>= 1;
            ++r;
        }
    }

    // ------------------------------------------------------------ (d) balance-reducing reward token

    /// Negative-rebase/slash on a reward token: only that token's claims fail; principal and other tokens unaffected;
    /// notify fails closed until the owner restores solvency by donation.
    function test_P2_balanceReducingRewardIsContained() public {
        SlashableToken sl = new SlashableToken();
        MockERC20 w = new MockERC20("W", "W", 18);
        _list(address(sl));
        _list(address(w));
        _stake(alice, 10 ether);
        _stake(bob, 10 ether);
        sl.mint(owner, 200 ether);
        vm.startPrank(owner);
        sl.approve(address(s), 200 ether);
        s.notifyRewardAmount(M.RunConfig(address(sl), 100 ether, 10 days, 0, 1, 1));
        vm.stopPrank();
        _fund(address(w), 100 ether, 10 days, 0);
        _warp(11 days);
        sl.slash(address(s), 60 ether); // contract now holds 40 of 100 owed
        vm.prank(alice);
        vm.expectRevert(); // 50 owed, 40 held
        s.claim(address(sl));
        vm.prank(alice);
        vm.expectRevert();
        s.claimAll(); // all-or-nothing path blocked
        // principal + other token unaffected
        vm.prank(alice);
        s.claim(address(w));
        assertApproxEqAbs(w.balanceOf(alice), 50 ether, 1e6);
        vm.prank(alice);
        s.withdraw(10 ether);
        vm.prank(bob);
        s.emergencyWithdraw();
        assertEq(bzb.balanceOf(alice) + bzb.balanceOf(bob), 20 ether);
        // notify fails closed while insolvent
        vm.prank(owner);
        vm.expectRevert(M.Underfunded.selector);
        s.notifyRewardAmount(M.RunConfig(address(sl), 1 ether, 1 days, 0, 1, 1));
        // restore by donation, claims work again
        vm.prank(owner);
        sl.transfer(address(s), 60 ether);
        vm.prank(alice);
        s.claim(address(sl));
        assertApproxEqAbs(sl.balanceOf(alice), 50 ether, 1e6);
    }

    // ------------------------------------------------------------ owner-power edge cases (Info)

    /// I-1 regression (was P2-03): listing the staking contract itself is rejected.
    function test_P2_listSelfBurnsSlotPermanently() public {
        vm.prank(owner);
        vm.expectRevert(M.NotContract.selector);
        s.addRewardToken(address(s));
        assertFalse(s.isRewardToken(address(s)));
        assertEq(s.rewardTokensLength(), 0);
    }

    /// Owner can occupy all 5 run slots of a token with dust 365-day runs (blocks new runs for a year).
    function test_P2_ownerCanFillRunSlotsWithDust() public {
        MockERC20 usdc = new MockERC20("USDC", "USDC", 6);
        _list(address(usdc));
        for (uint256 j; j < 5; ++j) {
            _fund(address(usdc), 1, 365 days, 0);
        }
        usdc.mint(owner, 1e12);
        vm.startPrank(owner);
        usdc.approve(address(s), 1e12);
        vm.expectRevert(M.TooManyRuns.selector);
        s.notifyRewardAmount(M.RunConfig(address(usdc), 1e12, 30 days, 0, 1, 1));
        vm.stopPrank();
    }

    /// Run that ends exactly now is freed by the notify checkpoint (slot reuse at the boundary).
    function test_P2_slotFreedExactlyAtEnd() public {
        MockERC20 w = new MockERC20("W", "W", 18);
        _list(address(w));
        _stake(alice, 1 ether);
        for (uint256 j; j < 5; ++j) {
            _fund(address(w), 1 ether, 1 days, 0);
        }
        _warp(1 days - 1);
        assertEq(s.activeRunCount(address(w)), 5);
        w.mint(owner, 1 ether);
        vm.startPrank(owner);
        w.approve(address(s), 1 ether);
        vm.expectRevert(M.TooManyRuns.selector);
        s.notifyRewardAmount(M.RunConfig(address(w), 1 ether, 1 days, 0, 1, 1));
        vm.stopPrank();
        _warp(1);
        _fund(address(w), 1 ether, 1 days, 0); // all 5 freed, new run in slot 0
        assertEq(s.activeRunCount(address(w)), 1);
        assertEq(s.getRun(address(w), 0).id, 6);
        assertApproxEqAbs(s.earned(alice, address(w)), 5 ether, 10);
    }

    /// BZB as reward + every owner power: principal untouched and withdrawable.
    function test_P2_bzbRewardOwnerMaxRecoverNeverTouchesPrincipal() public {
        _list(address(bzb));
        _stake(alice, 50 ether);
        _fund(address(bzb), 10 ether, 10 days, uint64(_now() + 5 days));
        bzb.mint(address(s), 3 ether); // donation
        _warp(7 days);
        uint256 rec = s.recoverable(address(bzb));
        assertEq(rec, 3 ether);
        vm.startPrank(owner);
        vm.expectRevert(M.Underfunded.selector);
        s.recover(address(bzb), rec + 1, owner);
        s.recover(address(bzb), rec, owner);
        s.pause();
        s.transferOwnership(bob);
        vm.stopPrank();
        vm.prank(bob);
        s.acceptOwnership();
        vm.prank(alice);
        s.exit();
        assertApproxEqAbs(bzb.balanceOf(alice), 50 ether + 2 ether, 1e6);
        assertGe(bzb.balanceOf(address(s)), s.reserved(address(bzb)));
    }

    /// claimTo accepts arbitrary non-zero destinations, e.g. the staking token contract (funds become stuck there).
    function test_P2_claimToAcceptsTokenContract() public {
        MockERC20 w = new MockERC20("W", "W", 18);
        _list(address(w));
        _stake(alice, 1 ether);
        _fund(address(w), 1 ether, 1 days, 0);
        _warp(2 days);
        vm.prank(alice);
        s.claimTo(address(w), address(w));
        assertApproxEqAbs(w.balanceOf(address(w)), 1 ether, 10);
        vm.prank(alice);
        vm.expectRevert(M.ZeroAddress.selector);
        s.claimTo(address(w), address(s));
    }

    /// Rounding dust: owed - sum(earned) after everybody is fully paid stays locked forever (not recoverable).
    function test_P2_roundingDustLockedInOwed() public {
        MockERC20 usdc = new MockERC20("USDC", "USDC", 6);
        _list(address(usdc));
        _stake(alice, 3e15 + 7);
        _stake(bob, 7e21 + 3);
        _stake(carol, 11e17 + 1);
        _fund(address(usdc), 1_000_003, 1 days, 0);
        for (uint256 i; i < 50; ++i) {
            _warp(1700);
            vm.prank(i % 2 == 0 ? alice : carol);
            s.claim(address(usdc));
        }
        _warp(2 days);
        vm.prank(alice);
        s.exit();
        vm.prank(bob);
        s.exit();
        vm.prank(carol);
        s.exit();
        uint256 dust = s.owedStored(address(usdc));
        emit log_named_uint("locked dust (6-dec units)", dust);
        assertLe(dust, 200);
        assertEq(s.recoverable(address(usdc)), 0);
    }
}
