// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {BlazarStakingRewards} from "../src/BlazarStakingRewards.sol";
import {MockERC20, TaxToken} from "./Mocks.sol";

contract BlazarStakingRewardsTest is Test {
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    MockERC20 internal bzb;
    BlazarStakingRewards internal staking;

    function setUp() public {
        bzb = new MockERC20("BlazarBits", "BZB", 18);
        staking = new BlazarStakingRewards(owner, address(bzb));
        bzb.mint(alice, 1_000 ether);
        bzb.mint(bob, 1_000 ether);
        bzb.mint(owner, 10_000 ether);
        vm.prank(alice);
        bzb.approve(address(staking), type(uint256).max);
        vm.prank(bob);
        bzb.approve(address(staking), type(uint256).max);
        vm.prank(owner);
        bzb.approve(address(staking), type(uint256).max);
    }

    function _notify(uint256 reward) internal {
        vm.prank(owner);
        staking.notifyRewardAmount(reward);
    }

    function test_singleStakerEarnsTheStream() public {
        vm.prank(alice);
        staking.stake(100 ether);
        _notify(70 ether);
        vm.warp(block.timestamp + 7 days);
        uint256 earned = staking.earned(alice);
        assertApproxEqAbs(earned, 70 ether, 1e12);
        vm.prank(alice);
        staking.getReward();
        assertApproxEqAbs(bzb.balanceOf(alice), 900 ether + 70 ether, 1e12);
        assertEq(staking.balanceOf(alice), 100 ether);
    }

    function test_twoStakersSplitByWeight() public {
        vm.prank(alice);
        staking.stake(75 ether);
        vm.prank(bob);
        staking.stake(25 ether);
        _notify(100 ether);
        vm.warp(block.timestamp + 7 days);
        assertApproxEqAbs(staking.earned(alice), 75 ether, 1e12);
        assertApproxEqAbs(staking.earned(bob), 25 ether, 1e12);
        vm.prank(alice);
        staking.exit();
        assertEq(staking.balanceOf(alice), 0);
        assertGt(bzb.balanceOf(alice), 1_000 ether);
    }

    function test_stakeHasNoLockAndNoFee() public {
        uint256 before = bzb.balanceOf(alice);
        vm.prank(alice);
        staking.stake(10 ether);
        vm.prank(alice);
        staking.withdraw(10 ether);
        assertEq(bzb.balanceOf(alice), before);
    }

    function test_recoverCannotTouchStakeOrStream() public {
        vm.prank(alice);
        staking.stake(100 ether);
        _notify(70 ether);
        vm.prank(owner);
        vm.expectRevert(BlazarStakingRewards.Underfunded.selector);
        staking.recover(address(bzb), 1 ether, owner);

        bzb.mint(address(staking), 5 ether);
        vm.prank(owner);
        staking.recover(address(bzb), 5 ether, owner);
        assertEq(bzb.balanceOf(owner), 10_000 ether - 70 ether + 5 ether);
    }

    function test_pauseBlocksStakeNotExit() public {
        vm.prank(alice);
        staking.stake(10 ether);
        _notify(7 ether);
        vm.prank(owner);
        staking.pause();
        vm.prank(bob);
        vm.expectRevert();
        staking.stake(1 ether);
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        staking.exit();
        assertEq(staking.totalSupply(), 0);
        assertGt(bzb.balanceOf(alice), 1_000 ether - 10 ether);
    }

    function test_emptyStakeDoesNotMintRewardsAndRateIsConfigurable() public {
        _notify(70 ether);
        assertApproxEqAbs(staking.dailyRate(), 10 ether, 1e15);
        vm.warp(block.timestamp + 7 days);
        vm.prank(alice);
        staking.stake(10 ether);
        assertEq(staking.earned(alice), 0);
        // Stream finished with nobody staked. Owner can recover the unearned rewards.
        vm.prank(owner);
        staking.recover(address(bzb), 70 ether, owner);
    }

    function test_stakeCreditsTokensThatArrivedNotTheRequestedAmount() public {
        TaxToken tax = new TaxToken(100, makeAddr("sink"));
        BlazarStakingRewards taxed = new BlazarStakingRewards(owner, address(tax));
        tax.mint(alice, 100 ether);
        vm.prank(alice);
        tax.approve(address(taxed), type(uint256).max);
        vm.prank(alice);
        taxed.stake(100 ether);
        assertEq(taxed.balanceOf(alice), 99 ether);
        assertEq(taxed.totalSupply(), 99 ether);
        vm.prank(alice);
        taxed.withdraw(99 ether);
        assertEq(taxed.totalSupply(), 0);
        vm.prank(owner);
        vm.expectRevert(BlazarStakingRewards.Underfunded.selector);
        taxed.recover(address(tax), 1, owner);
    }

    function test_checkpointRoundingCannotBlockTheClaim() public {
        vm.prank(alice);
        staking.stake(1_000_000_000_000_000_001);
        _notify(7 ether);
        vm.warp(block.timestamp + 1);
        vm.prank(bob);
        staking.getReward();
        vm.warp(block.timestamp + 1);
        vm.prank(bob);
        staking.getReward();
        uint256 owed = staking.earned(alice);
        assertGt(owed, 0);
        vm.prank(alice);
        staking.getReward();
        assertEq(bzb.balanceOf(alice), 1_000 ether - 1_000_000_000_000_000_001 + owed);
        vm.prank(alice);
        staking.withdraw(1_000_000_000_000_000_001);
        assertEq(staking.totalSupply(), 0);
    }

    function test_durationChangeOnlyAfterPeriod() public {
        _notify(70 ether);
        vm.prank(owner);
        vm.expectRevert(BlazarStakingRewards.PeriodLive.selector);
        staking.setRewardsDuration(14 days);
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(owner);
        staking.setRewardsDuration(14 days);
        assertEq(staking.rewardsDuration(), 14 days);
    }
}
