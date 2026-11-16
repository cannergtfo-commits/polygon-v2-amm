// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {BlazarMultiRewardStaking} from "../src/BlazarMultiRewardStaking.sol";

/// @notice Deploys BlazarMultiRewardStaking (stake BZB, earn up to 10 reward tokens). NOT RUN.
///         Mirrors Deploy.s.sol safety: no key in this file, refuses chain 137 unless
///         ALLOW_POLYGON_MAINNET=1, deployer must be PixelForge on 137, ownership goes to the
///         operator via Ownable2Step (operator must call acceptOwnership). Adds no reward tokens and
///         funds nothing; the owner does that after accepting ownership.
///
///         Dry run (simulation only):
///           forge script script/DeployMultiRewardStaking.s.sol --rpc-url polygon
contract DeployMultiRewardStaking is Script {
    address constant PIXELFORGE = 0xB452329B7b9d55a82f10a4e60E22748De6e490F2;
    address constant OPERATOR = 0x6F47aa396215ab22647dDB3E86b4663DFe11dB14;
    address constant BZB = 0x462D8d82C2B2D2DDabf7f8a93928De09d47A5807;

    function run() external returns (BlazarMultiRewardStaking staking) {
        uint256 chainId = block.chainid;
        if (chainId == 137 && vm.envOr("ALLOW_POLYGON_MAINNET", uint256(0)) != 1) {
            revert("refusing chain 137: set ALLOW_POLYGON_MAINNET=1 only when you mean it");
        }
        address deployer = vm.envOr("DEPLOYER", PIXELFORGE);
        uint256 key = vm.envOr("DEPLOYER_KEY", uint256(0));
        address owner = vm.envOr("OWNER", OPERATOR);
        address stakeToken = vm.envOr("STAKE_TOKEN", BZB);
        // 0.001 BZB minimum position (BZB has 18 decimals). Bounds reward-per-token growth.
        uint256 minStake = vm.envOr("MIN_STAKE", uint256(1e15));
        if (chainId == 137) {
            if (deployer != PIXELFORGE) revert("refusing chain 137: deployer must be the PixelForge address");
            if (owner != OPERATOR) revert("refusing chain 137: pending owner must be the operator wallet");
            if (stakeToken != BZB) revert("refusing chain 137: stake token must be BZB");
            if (minStake < 1e12 || minStake > 1e18) revert("refusing chain 137: MIN_STAKE out of range");
        }

        if (key != 0) {
            if (vm.addr(key) != deployer) revert("DEPLOYER_KEY does not match DEPLOYER");
            vm.startBroadcast(key);
        } else {
            vm.startBroadcast(deployer);
        }
        staking = new BlazarMultiRewardStaking(deployer, stakeToken, minStake);
        if (owner != deployer) staking.transferOwnership(owner);
        vm.stopBroadcast();

        console2.log("BlazarMultiRewardStaking", address(staking));
        console2.log("pending owner (must acceptOwnership)", owner);
    }
}
