// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {BlazarUsdOracle} from "../../src/BlazarUsdOracle.sol";
import {BlazarFeeRouter} from "../../src/BlazarFeeRouter.sol";
import {BlazarDailyRewards} from "../../src/BlazarDailyRewards.sol";
import {BlazarStakingRewards} from "../../src/BlazarStakingRewards.sol";

/// @notice Fork check of the unsigned deploy script's roles. Nothing is broadcast.
contract DeployRolesForkTest is Test {
    address constant DEPLOYER = 0xB452329B7b9d55a82f10a4e60E22748De6e490F2;
    address constant OPERATOR = 0x6F47aa396215ab22647dDB3E86b4663DFe11dB14;
    address constant POSTER = 0x55BA739Ba386D634CF81bd53d974dAF95241952C;
    address constant WPOL = 0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270;
    address constant BZB = 0x462D8d82C2B2D2DDabf7f8a93928De09d47A5807;
    address constant USDC = 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;
    address constant USDT = 0xc2132D05D31c914a87C6611C10748AEb04B58e8F;
    address constant WETH = 0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619;
    address constant WBTC = 0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6;
    address constant BLAZAR_FACTORY = 0x8e9663F4b15F3B291B1354e20d1B019d8864830F;
    address constant QUICK_V2_FACTORY = 0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32;
    address constant SUSHI_FACTORY = 0xc35DADB65012eC5796536bD9864eD8773aBc74C4;
    address constant APE_FACTORY = 0xCf083Be4164828f00cAE704EC15a36D711491284;
    address constant UNI_V3_ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    address constant ALGEBRA_ROUTER = 0xf5b509bB0909a69B1c207E495f687a596C168E12;
    address constant FEED_POL = 0xAB594600376Ec9fD91F8e885dADF0CE036862dE0;
    address constant FEED_ETH = 0xF9680D99D6C9589e2a93a78A04A279e509205945;
    address constant FEED_BTC = 0xc907E116054Ad103354f2D350FD2514433D57F6f;
    address constant FEED_USDC = 0xfE4A8cc5b5B2366C1B58Bea3858e81843581b2F7;
    address constant FEED_USDT = 0x0A6513e40db6EB1b165753AD52E80663aeA50545;
    address constant QUICK_BZB_WPOL = 0x6cCD623a2002F5198F7Acd94011af1Be0a193307;

    function setUp() public {
        vm.createSelectFork("polygon");
    }

    function testFork_scriptRolesAllowlistAndNoRenounce() public {
        vm.startPrank(DEPLOYER);
        address[] memory tokens = new address[](5);
        address[] memory feeds = new address[](5);
        uint8[] memory decimals = new uint8[](5);
        tokens[0] = WPOL;
        tokens[1] = WETH;
        tokens[2] = WBTC;
        tokens[3] = USDC;
        tokens[4] = USDT;
        feeds[0] = FEED_POL;
        feeds[1] = FEED_ETH;
        feeds[2] = FEED_BTC;
        feeds[3] = FEED_USDC;
        feeds[4] = FEED_USDT;
        decimals[0] = 18;
        decimals[1] = 18;
        decimals[2] = 8;
        decimals[3] = 6;
        decimals[4] = 6;
        BlazarUsdOracle oracle = new BlazarUsdOracle(DEPLOYER, tokens, feeds, decimals);
        oracle.setSpot(BZB, QUICK_BZB_WPOL, WPOL);
        BlazarFeeRouter router = new BlazarFeeRouter(DEPLOYER, OPERATOR, WPOL, BLAZAR_FACTORY, address(oracle));
        router.setV2Factory(BLAZAR_FACTORY, 30);
        router.setV2Factory(QUICK_V2_FACTORY, 30);
        router.setV2Factory(SUSHI_FACTORY, 30);
        router.setV2Factory(APE_FACTORY, 30);
        router.setAllowedTarget(UNI_V3_ROUTER, true);
        router.setAllowedTarget(ALGEBRA_ROUTER, true);
        BlazarDailyRewards rewards = new BlazarDailyRewards(DEPLOYER, BZB, POSTER);
        BlazarStakingRewards staking = new BlazarStakingRewards(DEPLOYER, BZB);
        oracle.transferOwnership(OPERATOR);
        router.transferOwnership(OPERATOR);
        rewards.transferOwnership(OPERATOR);
        staking.transferOwnership(OPERATOR);
        vm.stopPrank();

        assertEq(rewards.poster(), POSTER);
        assertEq(rewards.INITIAL_POSTER(), POSTER);
        assertTrue(POSTER != OPERATOR);
        assertEq(router.feeRecipient(), OPERATOR);
        assertEq(router.v2FeeBps(BLAZAR_FACTORY), 30);
        assertEq(router.v2FeeBps(QUICK_V2_FACTORY), 30);
        assertEq(router.v2FeeBps(SUSHI_FACTORY), 30);
        assertEq(router.v2FeeBps(APE_FACTORY), 30);
        assertTrue(router.allowedTarget(UNI_V3_ROUTER));
        assertTrue(router.allowedTarget(ALGEBRA_ROUTER));
        assertEq(oracle.owner(), DEPLOYER);
        assertEq(oracle.pendingOwner(), OPERATOR);
        assertEq(router.owner(), DEPLOYER);
        assertEq(rewards.owner(), DEPLOYER);
        assertEq(staking.owner(), DEPLOYER);
        (uint256 spotUsd, bool trusted) = oracle.quote(BZB, 1 ether);
        assertFalse(trusted);
        spotUsd;

        vm.prank(DEPLOYER);
        vm.expectRevert();
        oracle.acceptOwnership();
        vm.startPrank(OPERATOR);
        oracle.acceptOwnership();
        router.acceptOwnership();
        rewards.acceptOwnership();
        staking.acceptOwnership();
        vm.stopPrank();
        assertEq(oracle.owner(), OPERATOR);
        assertEq(router.owner(), OPERATOR);
        assertEq(rewards.owner(), OPERATOR);
        assertEq(staking.owner(), OPERATOR);
        assertEq(oracle.pendingOwner(), address(0));
        vm.prank(DEPLOYER);
        vm.expectRevert();
        router.setFeeBps(0);
    }
}
