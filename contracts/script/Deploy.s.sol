// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {BlazarUsdOracle} from "../src/BlazarUsdOracle.sol";
import {BlazarFeeRouter} from "../src/BlazarFeeRouter.sol";
import {BlazarDailyRewards} from "../src/BlazarDailyRewards.sol";
import {BlazarStakingRewards} from "../src/BlazarStakingRewards.sol";

/// @notice Unsigned deployment bundle for Polygon PoS.
///         The deployer is the PixelForge address. This file never contains a key.
///         A dry run calls `vm.startBroadcast(deployer)` so Forge can simulate that public
///         address. A key is used only when DEPLOYER_KEY is already present in the signer's
///         own environment, and only if it derives to the same deployer. This repository
///         does not set that variable and does not broadcast.
///         Refuses chain 137 unless ALLOW_POLYGON_MAINNET=1.
///         Does not renounce. The operator must acceptOwnership from 0x6F47…dB14.
contract Deploy is Script {
    /// @notice PixelForge deployer. Gas and contract creation only. Not the long-term admin.
    address constant PIXELFORGE = 0xB452329B7b9d55a82f10a4e60E22748De6e490F2;
    /// @notice Fee recipient and pending owner. Must sign acceptOwnership. Not the poster.
    address constant OPERATOR = 0x6F47aa396215ab22647dDB3E86b4663DFe11dB14;
    address constant FEE_RECIPIENT = OPERATOR;
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

    function run() external {
        uint256 chainId = block.chainid;
        if (chainId == 137 && vm.envOr("ALLOW_POLYGON_MAINNET", uint256(0)) != 1) {
            revert("refusing chain 137: set ALLOW_POLYGON_MAINNET=1 only when you mean it");
        }

        address deployer = vm.envOr("DEPLOYER", PIXELFORGE);
        uint256 key = vm.envOr("DEPLOYER_KEY", uint256(0));
        address owner = vm.envOr("OWNER", OPERATOR);
        // Poster stays the dedicated least-privilege wallet. The owner can rotate it later.
        // It is not the operator, and an EOA with no code is the expected kind of poster.
        // Same address as BlazarDailyRewards.INITIAL_POSTER. Owner can rotate it after acceptOwnership.
        address poster = vm.envOr("POSTER", address(0x55BA739Ba386D634CF81bd53d974dAF95241952C));
        if (chainId == 137 && deployer != PIXELFORGE) {
            revert("refusing chain 137: deployer must be the PixelForge address");
        }
        if (chainId == 137 && owner != OPERATOR) {
            revert("refusing chain 137: pending owner must be the fee wallet");
        }
        if (chainId == 137 && poster != address(0x55BA739Ba386D634CF81bd53d974dAF95241952C)) {
            revert("refusing chain 137: poster stays the dedicated 0x55BA wallet");
        }
        if (chainId == 137 && owner == deployer) {
            revert("refusing chain 137: OWNER is the deployer. The operator must accept ownership.");
        }
        // Configure as the broadcaster. onlyOwner setters fail if the constructor owner is someone else.
        // This script never renounces. Rewards and staking still need an owner to refill and to recover surplus.
        if (key != 0) {
            if (vm.addr(key) != deployer) revert("DEPLOYER_KEY does not match DEPLOYER");
            vm.startBroadcast(key);
        } else {
            vm.startBroadcast(deployer);
        }

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

        BlazarUsdOracle oracle = new BlazarUsdOracle(deployer, tokens, feeds, decimals);
        // Spot BZB against WPOL on the QuickSwap pool. Marked untrusted. Indexer reprices.
        if (chainId == 137) {
            oracle.setSpot(BZB, QUICK_BZB_WPOL, WPOL);
        }

        BlazarFeeRouter router = new BlazarFeeRouter(deployer, FEE_RECIPIENT, WPOL, BLAZAR_FACTORY, address(oracle));
        router.setV2Factory(BLAZAR_FACTORY, 30);
        router.setV2Factory(QUICK_V2_FACTORY, 30);
        router.setV2Factory(SUSHI_FACTORY, 30);
        router.setV2Factory(APE_FACTORY, 30);
        router.setAllowedTarget(UNI_V3_ROUTER, true);
        router.setAllowedTarget(ALGEBRA_ROUTER, true);

        BlazarDailyRewards rewards = new BlazarDailyRewards(deployer, BZB, poster);
        // dailyCap starts at 1000 BZB. It is not zero. Funding is separate.
        BlazarStakingRewards staking = new BlazarStakingRewards(deployer, BZB);
        if (owner != deployer) {
            oracle.transferOwnership(owner);
            router.transferOwnership(owner);
            rewards.transferOwnership(owner);
            staking.transferOwnership(owner);
        }

        vm.stopBroadcast();

        console2.log("oracle", address(oracle));
        console2.log("feeRouter", address(router));
        console2.log("dailyRewards", address(rewards));
        console2.log("bzbStaking", address(staking));
        console2.log("deployer", deployer);
        console2.log("pending owner", owner);
        if (chainId != 137) {
            console2.log("venue addresses are Polygon mainnet constants; do not treat them as deployed on this chain");
        }
    }
}
