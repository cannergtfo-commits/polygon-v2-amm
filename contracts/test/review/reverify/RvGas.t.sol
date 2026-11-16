// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {BlazarMultiRewardStaking as M} from "../../../src/BlazarMultiRewardStaking.sol";
import {MockERC20} from "../../Mocks.sol";

/// Adopted from the head-of-security re-verification of 984a927 (RV-01). Every user-path scenario is capped
/// at 1M gas. UI must use estimateGas + 25% or a >= 1.1M gas limit for emergencyWithdraw/checkpoint/withdraw.
/// Cold gas (vm.cool on contract + every token before each measured call; +21k intrinsic + calldata ~ignored).
/// 5 tokens x 5 live runs. "never-touched" = user staked before all runs existed and never interacted since.
contract RvGasTest is Test {
    uint256 internal constant MIN = 1e15;
    M internal s;
    MockERC20 internal bzb;
    address[] internal toks;
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public {
        vm.warp(1_700_000_000);
        bzb = new MockERC20("BZB", "BZB", 18);
        s = new M(owner, address(bzb), MIN);
        toks.push(address(bzb)); // BZB listed as a reward too (worst case: extra stake-token reserved math)
        for (uint256 i; i < 4; ++i) {
            toks.push(address(new MockERC20("R", "R", 18)));
        }
        vm.prank(owner);
        s.addRewardTokens(toks);
        _stake(alice, 10 ether);
        _stake(bob, 10 ether);
        _stake(carol, 10 ether);
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _fundAll(uint64 baseDur) internal {
        for (uint256 i; i < 5; ++i) {
            for (uint256 j; j < 5; ++j) {
                MockERC20(toks[i]).mint(owner, 100 ether);
                vm.startPrank(owner);
                MockERC20(toks[i]).approve(address(s), 100 ether);
                s.notifyRewardAmount(
                    M.RunConfig(toks[i], 100 ether, uint64(baseDur + j * 1 days), 0, uint16(1 + j), uint16(5 - j))
                );
                vm.stopPrank();
            }
        }
    }

    function _stake(address who, uint256 amt) internal {
        bzb.mint(who, amt);
        vm.startPrank(who);
        bzb.approve(address(s), amt);
        s.stake(amt);
        vm.stopPrank();
    }

    function _measure(string memory label, address who, bytes memory data) internal returns (uint256 used) {
        vm.cool(address(s));
        for (uint256 i; i < toks.length; ++i) {
            vm.cool(toks[i]);
        }
        vm.prank(who);
        uint256 g = gasleft();
        (bool ok,) = address(s).call(data);
        used = g - gasleft() + 21_000;
        require(ok, label);
        emit log_named_uint(label, used);
    }

    function _all() internal view returns (address[] memory a) {
        a = toks;
    }

    /// Worst emergency: never-touched user, all 25 runs mid-flight (25 run SSTOREs + 5 rpt + 5 owed + 10 fresh
    /// user slots).
    function test_gas_emergency_neverTouched_25midflight() public {
        _fundAll(30 days);
        vm.warp(_now() + 1 days);
        uint256 u = _measure(
            "emergencyWithdraw never-touched, 25 runs mid-flight", carol, abi.encodeCall(M.emergencyWithdraw, ())
        );
        assertLt(u, 1_000_000);
    }

    /// Never-touched user, all 25 runs just finished (25 deletes + 25 RunFinished events).
    function test_gas_emergency_neverTouched_25finished() public {
        _fundAll(1 days);
        vm.warp(_now() + 10 days);
        uint256 u = _measure(
            "emergencyWithdraw never-touched, 25 runs finishing", carol, abi.encodeCall(M.emergencyWithdraw, ())
        );
        assertLt(u, 1_000_000);
    }

    /// Steady: someone else checkpointed this block already (all globals fresh), user slots warm-ish.
    function test_gas_emergency_afterGlobalCheckpoint() public {
        _fundAll(30 days);
        vm.warp(_now() + 1 days);
        vm.prank(bob);
        s.checkpoint(_all());
        uint256 u = _measure(
            "emergencyWithdraw after same-block global checkpoint", carol, abi.encodeCall(M.emergencyWithdraw, ())
        );
        assertLt(u, 1_000_000);
    }

    function test_gas_withdraw_neverTouched_25midflight() public {
        _fundAll(30 days);
        vm.warp(_now() + 1 days);
        uint256 u =
            _measure("withdraw(full) never-touched, 25 runs mid-flight", carol, abi.encodeCall(M.withdraw, (10 ether)));
        assertLt(u, 1_000_000);
    }

    function test_gas_checkpoint_all_neverTouched() public {
        _fundAll(30 days);
        vm.warp(_now() + 1 days);
        uint256 u = _measure(
            "checkpoint(5 tokens) never-touched, 25 runs mid-flight", carol, abi.encodeCall(M.checkpoint, (_all()))
        );
        assertLt(u, 1_000_000);
    }

    function test_gas_checkpoint_100duplicates() public {
        _fundAll(30 days);
        vm.warp(_now() + 1 days);
        address[] memory d = new address[](100);
        for (uint256 i; i < 100; ++i) {
            d[i] = toks[i % 5];
        }
        // Caller-chosen list length (100 entries): the caller pays; not a user exit path, so no 1M cap.
        _measure("checkpoint(100 entries, 5 tokens x20 dup)", carol, abi.encodeCall(M.checkpoint, (d)));
    }

    function test_gas_checkpoint_1000unlisted() public {
        address[] memory d = new address[](1000);
        for (uint256 i; i < 1000; ++i) {
            d[i] = address(uint160(i + 1));
        }
        _measure("checkpoint(1000 unlisted) - caller pays", carol, abi.encodeCall(M.checkpoint, (d)));
    }

    function test_gas_checkpoint_empty() public {
        _measure("checkpoint([])", carol, abi.encodeCall(M.checkpoint, (new address[](0))));
    }
}
