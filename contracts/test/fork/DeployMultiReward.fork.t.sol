// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {BlazarMultiRewardStaking} from "../../src/BlazarMultiRewardStaking.sol";
import {DeployMultiRewardStaking} from "../../script/DeployMultiRewardStaking.s.sol";

/// @notice Fork check of DeployMultiRewardStaking after security B-1: the user's wallet is owner from
///         the constructor, nothing pending, deployer holds no power. Simulation only, nothing broadcast.
contract DeployMultiRewardForkTest is Test {
    address constant PIXELFORGE = 0xB452329B7b9d55a82f10a4e60E22748De6e490F2;
    address constant OPERATOR = 0x6F47aa396215ab22647dDB3E86b4663DFe11dB14;
    address constant BZB = 0x462D8d82C2B2D2DDabf7f8a93928De09d47A5807;
    address constant USDC = 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    BlazarMultiRewardStaking s;

    function setUp() public {
        vm.createSelectFork("polygon");
        vm.setEnv("ALLOW_POLYGON_MAINNET", "1");
        s = new DeployMultiRewardStaking().run();
    }

    function testFork_ownerIsUserDirectlyNoPending() public view {
        assertEq(s.owner(), OPERATOR);
        assertEq(s.pendingOwner(), address(0));
        assertEq(address(s.stakingToken()), BZB);
        assertEq(s.minStake(), 1e18);
        assertEq(address(s.PERMIT2()), PERMIT2);
        assertFalse(s.paused());
        assertEq(s.rewardTokensLength(), 0);
    }

    function testFork_deployerHasNoOwnerPowers() public {
        vm.startPrank(PIXELFORGE);
        vm.expectRevert();
        s.pause();
        vm.expectRevert();
        s.addRewardToken(USDC);
        vm.expectRevert();
        s.transferOwnership(PIXELFORGE);
        vm.expectRevert();
        s.acceptOwnership();
        vm.stopPrank();
        // The user can use owner powers immediately, with no acceptOwnership step.
        vm.prank(OPERATOR);
        s.pause();
        assertTrue(s.paused());
    }
}
