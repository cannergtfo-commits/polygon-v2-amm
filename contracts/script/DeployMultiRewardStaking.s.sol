// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {BlazarMultiRewardStaking} from "../src/BlazarMultiRewardStaking.sol";

/// @notice Deploys BlazarMultiRewardStaking (stake BZB, earn up to 5 reward tokens). NOT RUN.
///         Mirrors Deploy.s.sol safety: no key in this file, refuses chain 137 unless
///         ALLOW_POLYGON_MAINNET=1, deployer must be PixelForge on 137. OWNER (the user's wallet
///         0x6F47…dB14; enforced on 137) is passed straight to the constructor, so the deployer
///         never holds any owner power and there is no pending-owner window (security B-1).
///         Adds no reward tokens and funds nothing; the owner does that after deploy.
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
        // Owner: the user's wallet 0x6F47…dB14. OWNER is only honoured off-mainnet (tests); chain 137 requires
        // 0x6F47. A move to a Safe happens later via Ownable2Step (transferOwnership, then the Safe accepts).
        address owner = vm.envOr("OWNER", OPERATOR);
        if (owner == address(0)) revert("OWNER is zero");
        address stakeToken = vm.envOr("STAKE_TOKEN", BZB);
        // 1 BZB minimum position (BZB has 18 decimals; immutable). Bounds reward-per-token growth.
        uint256 minStake = vm.envOr("MIN_STAKE", uint256(1e18));
        if (chainId == 137) {
            if (deployer != PIXELFORGE) revert("refusing chain 137: deployer must be the PixelForge address");
            if (stakeToken != BZB) revert("refusing chain 137: stake token must be BZB");
            if (minStake != 1e18) revert("refusing chain 137: MIN_STAKE must be 1e18 (1 BZB)");
            if (owner != OPERATOR) revert("refusing chain 137: owner must be 0x6F47...dB14");
        }

        if (key != 0) {
            if (vm.addr(key) != deployer) revert("DEPLOYER_KEY does not match DEPLOYER");
            vm.startBroadcast(key);
        } else {
            vm.startBroadcast(deployer);
        }
        staking = new BlazarMultiRewardStaking(owner, stakeToken, minStake);
        vm.stopBroadcast();

        // Post-checks (B-1): final owner set directly, nothing pending, deployer holds no role.
        require(staking.owner() == owner, "post-check: owner mismatch");
        require(staking.pendingOwner() == address(0), "post-check: pending owner not zero");
        require(address(staking.stakingToken()) == stakeToken, "post-check: stake token mismatch");
        require(staking.minStake() == minStake, "post-check: minStake mismatch");
        console2.log("BlazarMultiRewardStaking", address(staking));
        console2.log("owner", staking.owner());
        console2.log("minStake", minStake);
    }
}
