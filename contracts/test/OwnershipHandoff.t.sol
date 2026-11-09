// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {BlazarDailyRewards} from "../src/BlazarDailyRewards.sol";
import {BlazarStakingRewards} from "../src/BlazarStakingRewards.sol";
import {BlazarUsdOracle} from "../src/BlazarUsdOracle.sol";
import {BlazarFeeRouter} from "../src/BlazarFeeRouter.sol";
import {MockERC20} from "./Mocks.sol";

/// @notice Ownable2Step handoff. No renounce. Deployer cannot accept for the operator.
contract OwnershipHandoffTest is Test {
    address internal deployer = 0xB452329B7b9d55a82f10a4e60E22748De6e490F2;
    address internal operator = 0x6F47aa396215ab22647dDB3E86b4663DFe11dB14;
    MockERC20 internal bzb;

    function setUp() public {
        bzb = new MockERC20("BlazarBits", "BZB", 18);
    }

    function test_operatorMustAcceptAndDeployerLosesTheRole() public {
        BlazarDailyRewards rewards = new BlazarDailyRewards(deployer, address(bzb), operator);
        BlazarStakingRewards staking = new BlazarStakingRewards(deployer, address(bzb));
        BlazarUsdOracle oracle = new BlazarUsdOracle(deployer, new address[](0), new address[](0), new uint8[](0));
        BlazarFeeRouter router = new BlazarFeeRouter(deployer, operator, address(0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270), address(0xBEEF), address(oracle));

        vm.startPrank(deployer);
        rewards.transferOwnership(operator);
        staking.transferOwnership(operator);
        oracle.transferOwnership(operator);
        router.transferOwnership(operator);
        vm.stopPrank();

        assertEq(rewards.owner(), deployer);
        assertEq(rewards.pendingOwner(), operator);
        assertEq(rewards.poster(), operator);

        vm.prank(deployer);
        vm.expectRevert();
        rewards.acceptOwnership();

        uint256 beforeGas = gasleft();
        vm.prank(operator);
        rewards.acceptOwnership();
        uint256 acceptGas = beforeGas - gasleft();
        assertLt(acceptGas, 80_000);

        vm.startPrank(operator);
        staking.acceptOwnership();
        oracle.acceptOwnership();
        router.acceptOwnership();
        vm.stopPrank();

        assertEq(rewards.owner(), operator);
        assertEq(staking.owner(), operator);
        assertEq(oracle.owner(), operator);
        assertEq(router.owner(), operator);
        assertEq(rewards.pendingOwner(), address(0));
        assertEq(router.feeRecipient(), operator);

        vm.startPrank(deployer);
        vm.expectRevert();
        rewards.pause();
        vm.expectRevert();
        staking.notifyRewardAmount(1);
        vm.expectRevert();
        oracle.setMaxAge(1 days);
        vm.expectRevert();
        router.setFeeBps(0);
        vm.stopPrank();
    }
}
