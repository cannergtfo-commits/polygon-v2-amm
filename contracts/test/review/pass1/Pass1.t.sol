// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {BlazarMultiRewardStaking as M} from "../../../src/BlazarMultiRewardStaking.sol";
import {MockERC20, TaxToken} from "../../Mocks.sol";
import {BlacklistToken} from "../../MultiRewardMocks.sol";
import {LyingToken, GasBombToken, FalseToken, ReenterAllToken, SenderFeeBZB} from "./Pass1Mocks.sol";

/// Pass-1 independent review tests (head-of-security). Local only.
contract Pass1Test is Test {
    uint256 internal constant MIN = 1e15;
    M internal s;
    MockERC20 internal bzb;
    MockERC20 internal ra;
    MockERC20 internal rb;
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public {
        vm.warp(1_700_000_000);
        bzb = new MockERC20("BlazarBits", "BZB", 18);
        ra = new MockERC20("A", "A", 18);
        rb = new MockERC20("B", "B", 6);
        s = _deploy(address(bzb));
    }

    function _deploy(address stakeTok) internal returns (M x) {
        x = new M(owner, stakeTok, MIN);
        vm.startPrank(owner);
        x.addRewardToken(address(ra));
        x.addRewardToken(address(rb));
        vm.stopPrank();
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _warp(uint256 dt) internal {
        vm.warp(_now() + dt);
    }

    function _cfg(address t, uint256 amt, uint64 dur, uint64 start, uint16 wS, uint16 wE)
        internal
        pure
        returns (M.RunConfig memory)
    {
        return M.RunConfig({token: t, amount: amt, duration: dur, startTime: start, startWeight: wS, endWeight: wE});
    }

    function _fundOn(M x, address t, uint256 amt, uint64 dur, uint64 start, uint16 wS, uint16 wE) internal {
        MockERC20(t).mint(owner, amt);
        vm.startPrank(owner);
        MockERC20(t).approve(address(x), amt);
        x.notifyRewardAmount(_cfg(t, amt, dur, start, wS, wE));
        vm.stopPrank();
    }

    function _fund(address t, uint256 amt, uint64 dur, uint64 start, uint16 wS, uint16 wE) internal {
        _fundOn(s, t, amt, dur, start, wS, wE);
    }

    function _stakeOn(M x, address who, uint256 amt) internal {
        MockERC20(address(x.stakingToken())).mint(who, amt);
        vm.startPrank(who);
        MockERC20(address(x.stakingToken())).approve(address(x), amt);
        x.stake(amt);
        vm.stopPrank();
    }

    function _stake(address who, uint256 amt) internal {
        _stakeOn(s, who, amt);
    }

    // =====================================================================================
    // (1) Run settlement & slot freeing
    // =====================================================================================

    /// Run is NOT freed one second before its end and IS freed exactly at start+duration; the single
    /// always-staked user receives the whole run up to rounding dust.
    function test_P1_runEndBoundaryExact() public {
        _stake(alice, 1 ether);
        uint256 amt = 1000e18 + 7;
        _fund(address(ra), amt, 1 days, 0, 3, 11);
        uint256 end = _now() + 1 days;
        vm.warp(end - 1);
        vm.prank(alice);
        s.claim(address(ra));
        M.Run memory r = s.getRun(address(ra), 0);
        assertEq(r.amount, amt, "not freed at end-1");
        assertLt(r.emitted, amt, "not fully emitted at end-1");
        assertEq(s.activeRunCount(address(ra)), 1);
        vm.warp(end);
        assertEq(s.activeRunCount(address(ra)), 0, "finished at end");
        vm.expectEmit(true, true, false, true, address(s));
        emit M.RunFinished(address(ra), 1, 0);
        vm.prank(alice);
        s.claim(address(ra));
        assertEq(s.getRun(address(ra), 0).amount, 0, "freed at end");
        assertApproxEqAbs(ra.balanceOf(alice), amt, 2, "full run delivered");
        assertLe(ra.balanceOf(alice), amt);
        assertEq(s.unemitted(address(ra)), 0);
    }

    /// Delayed-start runs emit nothing before start, are never freed before start+duration and the slot
    /// stays occupied (counts toward the cap) the whole time.
    function test_P1_delayedRunLifecycle() public {
        _stake(alice, 1 ether);
        uint64 start = uint64(_now() + 30 days);
        _fund(address(ra), 500e18, 1 days, start, 10_000, 0);
        _warp(30 days - 1);
        vm.prank(alice);
        s.claim(address(ra));
        assertEq(ra.balanceOf(alice), 0, "nothing before start");
        assertEq(s.getRun(address(ra), 0).amount, 500e18);
        vm.warp(start);
        vm.prank(alice);
        s.claim(address(ra));
        assertEq(ra.balanceOf(alice), 0, "nothing at start");
        vm.warp(start + 1 days - 1);
        vm.prank(alice);
        s.claim(address(ra));
        assertEq(s.getRun(address(ra), 0).amount, 500e18, "not freed before end");
        vm.warp(start + 1 days);
        vm.prank(alice);
        s.claim(address(ra));
        assertEq(s.getRun(address(ra), 0).amount, 0);
        assertApproxEqAbs(ra.balanceOf(alice), 500e18, 3);
    }

    /// Freeing a middle slot does not move or alter any other run (no swap-delete); the new run reuses
    /// the first free slot with the next id.
    function test_P1_slotReuseLeavesOtherRunsUntouched() public {
        _stake(alice, 1 ether);
        uint64[5] memory durs = [uint64(10 days), 20 days, 1 days, 30 days, 40 days];
        for (uint256 i; i < 5; ++i) {
            _fund(address(ra), (i + 1) * 1e18, durs[i], 0, 1, 1);
        }
        vm.prank(owner);
        vm.expectRevert(M.TooManyRuns.selector);
        s.notifyRewardAmount(_cfg(address(ra), 1, 1 days, 0, 1, 1));
        _warp(1 days);
        vm.prank(alice);
        s.claim(address(ra)); // settles; slot 2 freed
        M.Run[5] memory before;
        for (uint256 i; i < 5; ++i) {
            before[i] = s.getRun(address(ra), i);
        }
        assertEq(before[2].amount, 0);
        _fund(address(ra), 9e18, 5 days, 0, 1, 1);
        for (uint256 i; i < 5; ++i) {
            M.Run memory r = s.getRun(address(ra), i);
            if (i == 2) {
                assertEq(r.id, 6);
                assertEq(r.amount, 9e18);
            } else {
                assertEq(r.id, before[i].id);
                assertEq(r.amount, before[i].amount);
                assertEq(r.emitted, before[i].emitted);
                assertEq(r.start, before[i].start);
                assertEq(r.duration, before[i].duration);
            }
        }
    }

    /// Single always-staked user over random 5-run schedules (random delays, durations, weights) receives
    /// exactly Σfunded minus bounded rounding dust; runs are freed iff finished.
    function testFuzz_P1_randomRunsFullyDeliveredAndFreedOnlyWhenFinished(uint256 seed) public {
        _stake(alice, 3 ether + (seed % 1e18));
        uint256 total;
        uint256 lastEnd;
        for (uint256 i; i < 5; ++i) {
            uint256 h = uint256(keccak256(abi.encode(seed, i)));
            uint256 amt = 1 + (h % 1e27);
            uint64 dur = uint64(1 days + (h >> 64) % (365 days - 1 days + 1));
            uint64 delay = uint64((h >> 128) % (30 days + 1));
            uint16 wS = uint16((h >> 160) % 10_001);
            uint16 wE = uint16((h >> 176) % 10_001);
            if (uint256(wS) + wE == 0) wE = 1;
            uint64 st = delay == 0 ? 0 : uint64(_now() + delay);
            _fund(address(ra), amt, dur, st, wS, wE);
            total += amt;
            uint256 e = (st == 0 ? _now() : st) + dur;
            if (e > lastEnd) lastEnd = e;
        }
        uint256 checkpoints;
        while (_now() < lastEnd + 1) {
            _warp(1 + uint256(keccak256(abi.encode(seed, _now()))) % 40 days);
            vm.prank(alice);
            s.claim(address(ra));
            checkpoints++;
            for (uint256 i; i < 5; ++i) {
                M.Run memory r = s.getRun(address(ra), i);
                if (r.amount != 0) {
                    assertLt(_now(), uint256(r.start) + r.duration, "unfinished run must not be finished");
                    assertLt(r.emitted, r.amount, "stored emitted < amount");
                }
            }
        }
        assertEq(s.activeRunCount(address(ra)), 0);
        assertLe(ra.balanceOf(alice), total, "never over-delivers");
        assertLe(total - ra.balanceOf(alice), checkpoints + 1, "dust <= 1 wei/checkpoint");
    }

    /// INFO: owner (or a compromised owner key) can occupy all 5 run slots of a token for ~395 days with
    /// 1-wei runs (30-day delay + 365-day duration). Not a principal risk; listing is also permanent.
    function test_P1_ownerCanOccupyAllRunSlotsFor395Days() public {
        uint64 st = uint64(_now() + 30 days);
        for (uint256 i; i < 5; ++i) {
            _fund(address(ra), 1, 365 days, st, 1, 1);
        }
        ra.mint(owner, 1e24);
        vm.startPrank(owner);
        ra.approve(address(s), 1e24);
        vm.expectRevert(M.TooManyRuns.selector);
        s.notifyRewardAmount(_cfg(address(ra), 1e24, 30 days, 0, 1, 1));
        vm.stopPrank();
        vm.warp(st + 365 days - 1);
        vm.startPrank(owner);
        vm.expectRevert(M.TooManyRuns.selector);
        s.notifyRewardAmount(_cfg(address(ra), 1e24, 30 days, 0, 1, 1));
        vm.warp(st + 365 days);
        s.notifyRewardAmount(_cfg(address(ra), 1e24, 30 days, 0, 1, 1));
        vm.stopPrank();
    }

    // =====================================================================================
    // (2) Partial-claim drift — differential against an identical contract with no claims
    // =====================================================================================

    function testFuzz_P1_partialClaimsDoNotDrift(uint256 seed) public {
        M s2 = _deploy(address(bzb));
        uint64 st = uint64(_now() + 2 days);
        _fundOn(s, address(ra), 1000e18, 40 days, 0, 2, 9);
        _fundOn(s2, address(ra), 1000e18, 40 days, 0, 2, 9);
        _fundOn(s, address(rb), 777e6, 20 days, st, 9, 2);
        _fundOn(s2, address(rb), 777e6, 20 days, st, 9, 2);
        address[3] memory who = [alice, bob, carol];
        uint256 steps;
        for (uint256 i; i < 25; ++i) {
            uint256 h = uint256(keccak256(abi.encode(seed, i)));
            address u = who[h % 3];
            uint256 amt = MIN + (h >> 8) % 50 ether;
            if ((h >> 200) % 2 == 0 || s.balanceOf(u) == 0) {
                _stakeOn(s, u, amt);
                _stakeOn(s2, u, amt);
            } else {
                uint256 bal = s.balanceOf(u);
                uint256 w = 1 + (h >> 100) % bal;
                if (bal - w != 0 && bal - w < MIN) w = bal;
                vm.prank(u);
                s.withdraw(w);
                vm.prank(u);
                s2.withdraw(w);
            }
            _warp(1 + (h >> 40) % 3 days);
            // In s ONLY: every user claims only token A (B is never touched by claims).
            for (uint256 k; k < 3; ++k) {
                vm.prank(who[k]);
                s.claim(address(ra));
            }
            steps++;
        }
        _warp(45 days);
        for (uint256 k; k < 3; ++k) {
            // token B: identical checkpoint schedule in both => exact equality
            assertEq(s.earned(who[k], address(rb)), s2.earned(who[k], address(rb)), "B drift");
            // token A: s paid out along the way; totals equal up to rounding dust from extra checkpoints
            uint256 gotA = ra.balanceOf(who[k]) + s.earned(who[k], address(ra));
            assertApproxEqAbs(gotA, s2.earned(who[k], address(ra)), 4 * steps + 4, "A drift");
        }
        assertEq(s.owedStored(address(rb)), s2.owedStored(address(rb)));
    }

    // =====================================================================================
    // (3) P-1 emergencyWithdraw credit; rounding favours solvency
    // =====================================================================================

    /// When all tokens were checkpointed in the same block, emergencyWithdraw credits exactly what
    /// withdraw would; when stale, the user loses only their share of emission since the last checkpoint,
    /// which goes to the remaining stakers (no value created or destroyed beyond dust).
    function test_P1_emergencyCreditMatchesWithdrawWhenFresh() public {
        _stake(alice, 4 ether);
        _stake(bob, 6 ether);
        _fund(address(ra), 1000e18, 10 days, 0, 1, 1);
        _fund(address(rb), 1000e6, 10 days, 0, 5, 1);
        _warp(3 days);
        // fresh checkpoint of both tokens this block (bob's partial withdraw runs _updateAll)
        vm.prank(bob);
        s.withdraw(1 ether);
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        s.withdraw(4 ether);
        uint256 a1 = s.rewards(alice, address(ra));
        uint256 b1 = s.rewards(alice, address(rb));
        vm.revertToState(snap);
        vm.prank(alice);
        s.emergencyWithdraw();
        assertEq(s.rewards(alice, address(ra)), a1, "A equal");
        assertEq(s.rewards(alice, address(rb)), b1, "B equal");
        assertEq(bzb.balanceOf(alice), 4 ether);
    }

    /// L-1 regression: emergencyWithdraw after a 4-day untouched window now credits alice's full share.
    function test_P1_emergencyStaleWindowKeptByUser() public {
        _stake(alice, 5 ether);
        _stake(bob, 5 ether);
        _fund(address(ra), 1000e18, 10 days, 0, 1, 1);
        _warp(4 days); // no checkpoint for 4 days
        uint256 aliceFull = s.earned(alice, address(ra));
        vm.prank(alice);
        s.emergencyWithdraw();
        assertEq(s.rewards(alice, address(ra)), aliceFull, "alice keeps the 4 stale days");
        assertApproxEqAbs(aliceFull, 200e18, 3);
        _warp(6 days);
        vm.prank(bob);
        s.claim(address(ra));
        vm.prank(alice);
        s.claim(address(ra));
        assertApproxEqAbs(ra.balanceOf(bob) + ra.balanceOf(alice), 1000e18, 3);
        assertApproxEqAbs(ra.balanceOf(alice), 200e18, 3);
        assertApproxEqAbs(ra.balanceOf(bob), 800e18, 3);
    }

    /// Fuzz: Σ earned never exceeds owed (incl. pending) and the gap is dust, across interleavings with
    /// emergencyWithdraw, partial claims and stake changes.
    function testFuzz_P1_sumEarnedLeOwed(uint256 seed) public {
        _fund(address(ra), 1e24 + seed % 1e24, 30 days, 0, uint16(seed % 10_001), 7);
        _fund(address(rb), 1e9 + seed % 1e12, 15 days, uint64(_now() + 1 days), 1, 0);
        address[3] memory who = [alice, bob, carol];
        for (uint256 i; i < 30; ++i) {
            uint256 h = uint256(keccak256(abi.encode(seed, i)));
            address u = who[h % 3];
            uint256 op = (h >> 8) % 5;
            if (op == 0) {
                _stake(u, MIN + (h >> 16) % 1e24);
            } else if (op == 1 && s.balanceOf(u) > 0) {
                vm.prank(u);
                s.emergencyWithdraw();
            } else if (op == 2) {
                vm.prank(u);
                s.claim((h >> 30) % 2 == 0 ? address(ra) : address(rb));
            } else if (op == 3 && s.balanceOf(u) > 0) {
                uint256 b = s.balanceOf(u);
                vm.prank(u);
                s.withdraw(b);
            }
            _warp(1 + (h >> 64) % 2 days);
            address[2] memory tk = [address(ra), address(rb)];
            for (uint256 t; t < 2; ++t) {
                uint256 sum;
                for (uint256 k; k < 3; ++k) {
                    sum += s.earned(who[k], tk[t]);
                }
                uint256 owedNow = s.reserved(tk[t]) - s.unemitted(tk[t]);
                assertLe(sum, owedNow, "earned <= owed");
                assertLe(owedNow - sum, 4 * (i + 1) + 4, "gap is dust");
                assertGe(MockERC20(tk[t]).balanceOf(address(s)), s.reserved(tk[t]), "solvent");
            }
        }
    }

    // =====================================================================================
    // (4) Principal: owner / malicious tokens / BZB behaviour
    // =====================================================================================

    /// Owner lists BZB + four hostile reward tokens (lying balance with max-size phantom runs, gas bomb,
    /// returns-false, re-entering). Stakers at the minimum stake (worst-case accumulator). After every run
    /// has emitted, withdraw and emergencyWithdraw still return exact principal with bounded gas.
    function test_P1_hostileRewardTokensCannotBlockExit() public {
        M x = new M(owner, address(bzb), MIN);
        LyingToken lie = new LyingToken();
        lie.setVictim(address(x));
        GasBombToken bomb = new GasBombToken();
        FalseToken fals = new FalseToken();
        ReenterAllToken re = new ReenterAllToken();
        vm.startPrank(owner);
        x.addRewardToken(address(bzb));
        x.addRewardToken(address(lie));
        x.addRewardToken(address(bomb));
        x.addRewardToken(address(fals));
        x.addRewardToken(address(re));
        vm.stopPrank();
        _stakeOn(x, alice, MIN);
        _stakeOn(x, bob, MIN);
        // 5 phantom max-size runs on the lying token (no real funding needed).
        vm.startPrank(owner);
        for (uint256 i; i < 5; ++i) {
            x.notifyRewardAmount(_cfg(address(lie), type(uint128).max, 1 days, 0, 1, 10_000));
        }
        vm.stopPrank();
        _fundOn(x, address(bzb), 1e24, 1 days, 0, 1, 1);
        _fundOn(x, address(bomb), 1e24, 1 days, 0, 1, 1);
        _fundOn(x, address(fals), 1e24, 1 days, 0, 1, 1);
        _fundOn(x, address(re), 1e24, 1 days, 0, 1, 1);
        bomb.arm(true);
        fals.setBad(true);
        re.arm(address(x), true);
        _warp(12 hours);
        // claimAll is expected to fail (documented); withdraw must not.
        vm.prank(alice);
        vm.expectRevert();
        x.claimAll{gas: 5_000_000}();
        uint256 b0 = bzb.balanceOf(alice);
        vm.prank(alice);
        uint256 g = gasleft();
        x.withdraw(MIN);
        uint256 used = g - gasleft();
        assertEq(bzb.balanceOf(alice) - b0, MIN, "withdraw exact");
        assertLt(used, 1_000_000);
        _warp(2 days);
        b0 = bzb.balanceOf(bob);
        vm.prank(bob);
        x.emergencyWithdraw();
        assertEq(bzb.balanceOf(bob) - b0, MIN, "emergency exact");
        // BZB rewards still claimable; principal never touched.
        vm.prank(bob);
        x.claim(address(bzb));
        assertGe(bzb.balanceOf(address(x)), x.totalStaked() + x.owedStored(address(bzb)) + x.unemitted(address(bzb)));
        // reentrancy into the staking contract from a reward token never succeeds
        vm.prank(bob);
        try x.claim(address(re)) {} catch {}
        assertEq(re.reentrySucceeded(), 0, "no reentry");
    }

    /// Accumulator bound: 5 tokens x 5 runs of MAX_RUN_AMOUNT every day at totalStaked == minStake for
    /// 50 cycles. rewardPerTokenStored growth per cycle is ~2^200, so overflow needs ~2^55 cycles.
    function test_P1_accumulatorOverflowBoundAtMinStake() public {
        M x = new M(owner, address(bzb), MIN);
        LyingToken[5] memory lt;
        vm.startPrank(owner);
        for (uint256 i; i < 5; ++i) {
            lt[i] = new LyingToken();
            lt[i].setVictim(address(x));
            x.addRewardToken(address(lt[i]));
        }
        vm.stopPrank();
        _stakeOn(x, alice, MIN);
        uint256 rpt1;
        for (uint256 c; c < 50; ++c) {
            vm.startPrank(owner);
            for (uint256 i; i < 5; ++i) {
                for (uint256 j; j < 5; ++j) {
                    x.notifyRewardAmount(_cfg(address(lt[i]), type(uint128).max, 1 days, 0, 10_000, 10_000));
                }
            }
            vm.stopPrank();
            _warp(1 days);
        }
        uint256 rpt = x.rewardPerToken(address(lt[0]));
        rpt1 = rpt / 50;
        emit log_named_uint("log2(rpt growth per max cycle) approx", _log2(rpt1));
        emit log_named_uint("log2(cycles to overflow) approx", 256 - _log2(rpt1));
        uint256 b0 = bzb.balanceOf(alice);
        vm.prank(alice);
        x.withdraw(MIN);
        assertEq(bzb.balanceOf(alice) - b0, MIN);
        assertGt(256 - _log2(rpt1), 50);
    }

    function _log2(uint256 v) internal pure returns (uint256 r) {
        while (v > 1) {
            v >>= 1;
            r++;
        }
    }

    /// recover can never touch principal or rewards, even with BZB listed as a reward; boundary exact.
    function testFuzz_P1_recoverBoundaryBzbListed(uint256 donation, uint256 stakeAmt, uint256 dt) public {
        donation = bound(donation, 1, 1e24);
        stakeAmt = bound(stakeAmt, MIN, 1e27);
        dt = bound(dt, 0, 40 days);
        vm.prank(owner);
        s.addRewardToken(address(bzb));
        _stake(alice, stakeAmt);
        _fund(address(bzb), 1e24, 30 days, uint64(_now() + 1 days), 3, 1);
        bzb.mint(address(s), donation);
        _warp(dt);
        uint256 free = s.recoverable(address(bzb));
        vm.startPrank(owner);
        vm.expectRevert(M.Underfunded.selector);
        s.recover(address(bzb), free + 1, owner);
        if (free > 0) s.recover(address(bzb), free, owner);
        vm.stopPrank();
        assertGe(bzb.balanceOf(address(s)), s.totalStaked() + s.owedStored(address(bzb)) + s.unemitted(address(bzb)));
        uint256 b0 = bzb.balanceOf(alice);
        vm.prank(alice);
        s.exit();
        assertGe(bzb.balanceOf(alice) - b0, stakeAmt, "principal + rewards");
    }

    /// I-1 regression: listing the staking contract itself now reverts; principal unaffected either way.
    function test_P1_listingSelfRejected() public {
        vm.prank(owner);
        vm.expectRevert(M.CannotListSelf.selector);
        s.addRewardToken(address(s));
        _stake(alice, 1 ether);
        vm.prank(alice);
        s.claim(address(s)); // unlisted: no-op
        vm.prank(alice);
        s.withdraw(1 ether);
        assertEq(bzb.balanceOf(alice), 1 ether);
    }

    /// Trust boundary (documented): if the BZB proxy were upgraded to charge senders, the contract cannot
    /// protect the last withdrawers. Shown for completeness; out of the owner's control.
    function test_P1_bzbSenderFeeUpgradeBreaksLastExit() public {
        SenderFeeBZB fb = new SenderFeeBZB();
        M x = new M(owner, address(fb), MIN);
        fb.mint(alice, 1 ether);
        fb.mint(bob, 1 ether);
        vm.prank(alice);
        fb.approve(address(x), 1 ether);
        vm.prank(alice);
        x.stake(1 ether);
        vm.prank(bob);
        fb.approve(address(x), 1 ether);
        vm.prank(bob);
        x.stake(1 ether);
        fb.setFee(100); // 1% extra from sender
        vm.prank(alice);
        x.withdraw(1 ether);
        vm.prank(bob);
        vm.expectRevert();
        x.withdraw(1 ether);
    }

    // =====================================================================================
    // (6) claimTo / events / misc
    // =====================================================================================

    function test_P1_claimToValidationAndEvent() public {
        _stake(alice, 1 ether);
        _fund(address(ra), 100e18, 1 days, 0, 1, 1);
        _warp(1 days);
        vm.startPrank(alice);
        vm.expectRevert(M.ZeroAddress.selector);
        s.claimTo(address(ra), address(0));
        vm.expectRevert(M.ZeroAddress.selector);
        s.claimTo(address(ra), address(s));
        address[] memory ts = new address[](4);
        ts[0] = address(ra);
        ts[1] = address(ra); // duplicate
        ts[2] = address(0xBEEF); // unlisted
        ts[3] = address(rb); // nothing earned
        vm.expectRevert(M.ZeroAddress.selector);
        s.claimManyTo(ts, address(s));
        uint256 e = s.earned(alice, address(ra));
        vm.expectEmit(true, true, false, true, address(s));
        emit M.RewardPaid(alice, address(ra), carol, e);
        s.claimManyTo(ts, carol);
        vm.stopPrank();
        assertEq(ra.balanceOf(carol), e);
        assertEq(s.earned(alice, address(ra)), 0);
        assertEq(s.rewards(alice, address(ra)), 0);
    }

    /// Zero-stake periods: emission while nobody is staked is not credited to the next staker; donations
    /// never inflate rewards; both become recoverable surplus only.
    function test_P1_zeroStakeAndDonation() public {
        _fund(address(ra), 100e18, 10 days, 0, 1, 1);
        _warp(5 days);
        ra.mint(address(s), 7e18); // donation
        _stake(alice, 1 ether);
        assertEq(s.earned(alice, address(ra)), 0);
        _warp(5 days);
        vm.prank(alice);
        s.claim(address(ra));
        assertApproxEqAbs(ra.balanceOf(alice), 50e18, 2);
        assertApproxEqAbs(s.recoverable(address(ra)), 57e18, 2);
    }
}
