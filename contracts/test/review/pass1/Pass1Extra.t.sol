// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {BlazarMultiRewardStaking as M} from "../../../src/BlazarMultiRewardStaking.sol";
import {MockERC20} from "../../Mocks.sol";

contract Pass1ExtraTest is Test {
    uint256 internal constant MIN = 1e15;
    M internal s;
    MockERC20 internal bzb;
    MockERC20 internal ra;
    MockERC20 internal rb;
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        vm.warp(1_700_000_000);
        bzb = new MockERC20("BZB", "BZB", 18);
        ra = new MockERC20("A", "A", 18);
        rb = new MockERC20("B", "B", 18);
        s = new M(owner, address(bzb), MIN);
        vm.startPrank(owner);
        s.addRewardToken(address(ra));
        s.addRewardToken(address(rb));
        vm.stopPrank();
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _warp(uint256 dt) internal {
        vm.warp(_now() + dt);
    }

    function _fund(address t, uint256 amt, uint64 dur) internal {
        MockERC20(t).mint(owner, amt);
        vm.startPrank(owner);
        MockERC20(t).approve(address(s), amt);
        s.notifyRewardAmount(
            M.RunConfig({token: t, amount: amt, duration: dur, startTime: 0, startWeight: 1, endWeight: 1})
        );
        vm.stopPrank();
    }

    function _stake(address who, uint256 amt) internal {
        bzb.mint(who, amt);
        vm.startPrank(who);
        bzb.approve(address(s), amt);
        s.stake(amt);
        vm.stopPrank();
    }

    /// P1-01 proof: per-token claims keep token A fresh while token B's global checkpoint goes stale.
    /// emergencyWithdraw then forfeits the user's entire share of B since B's last checkpoint (20 days
    /// here), although `withdraw` (which also never calls reward tokens) would have paid it in full.
    function test_P1_01_emergencyNoLongerForfeitsStaleTokenShare() public {
        _stake(alice, 5 ether);
        _stake(bob, 5 ether);
        _fund(address(ra), 100e18, 30 days);
        _fund(address(rb), 100e18, 30 days);
        for (uint256 d; d < 20; ++d) {
            _warp(1 days);
            vm.prank(alice);
            s.claim(address(ra)); // only A is checkpointed
        }
        uint256 viaWithdraw;
        {
            uint256 snap = vm.snapshotState();
            vm.prank(alice);
            s.withdraw(5 ether);
            viaWithdraw = s.rewards(alice, address(rb));
            vm.revertToState(snap);
        }
        vm.prank(alice);
        s.emergencyWithdraw();
        uint256 viaEmergency = s.rewards(alice, address(rb));
        emit log_named_uint("B credited via withdraw", viaWithdraw);
        emit log_named_uint("B credited via emergencyWithdraw", viaEmergency);
        assertApproxEqAbs(viaWithdraw, uint256(100e18) * 20 / 30 / 2, 1e6);
        assertEq(viaEmergency, viaWithdraw, "L-1 fix: emergency credits same as withdraw");
        // last-staker variant: bob emergency-exits too -> his share is credited, nothing stranded
        uint256 bobEarned = s.earned(bob, address(rb));
        vm.prank(bob);
        s.emergencyWithdraw();
        assertEq(s.rewards(bob, address(rb)), bobEarned);
        assertLe(s.recoverable(address(rb)), 1);
        // emission after the last exit (nobody staked) is the only surplus
        _warp(1 days);
        assertApproxEqAbs(s.recoverable(address(rb)), uint256(100e18) / 30, 1e6);
    }

    /// E(x) is non-decreasing and E(D)=amount for all valid params, so `nowE - r.emitted` cannot underflow.
    function testFuzz_P1_curveMonotone(uint256 amt, uint256 d, uint256 wS, uint256 wE, uint256 x, uint256 dx)
        public
        view
    {
        amt = bound(amt, 1, type(uint128).max);
        d = bound(d, 1 days, 365 days);
        wS = bound(wS, 0, 10_000);
        wE = bound(wE, 0, 10_000);
        if (wS + wE == 0) wE = 1;
        x = bound(x, 0, d + 10);
        dx = bound(dx, 0, d);
        uint256 a = s.curveEmitted(amt, d, wS, wE, x);
        uint256 b = s.curveEmitted(amt, d, wS, wE, x + dx);
        assertLe(a, b);
        assertLe(b, amt);
        if (x < d) assertLt(a, amt, "never full before end");
        assertEq(s.curveEmitted(amt, d, wS, wE, d), amt);
    }

    /// claimMany with duplicates / unlisted tokens never double-pays.
    function test_P1_claimManyDuplicatesNoDoublePay() public {
        _stake(alice, 1 ether);
        _fund(address(ra), 10e18, 1 days);
        _warp(1 days);
        address[] memory l = new address[](3);
        l[0] = address(ra);
        l[1] = address(ra);
        l[2] = address(0x1234);
        vm.prank(alice);
        s.claimMany(l);
        assertApproxEqAbs(ra.balanceOf(alice), 10e18, 2);
        assertLe(ra.balanceOf(alice), 10e18);
        assertEq(s.owedStored(address(ra)), 10e18 - ra.balanceOf(alice));
    }
}
