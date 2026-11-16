// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BlazarMultiRewardStaking as M} from "../../src/BlazarMultiRewardStaking.sol";
import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";
import {MockERC20} from "../Mocks.sol";
import {FlakyToken} from "../MultiRewardMocks.sol";
import {Permit2Helper} from "./Permit2Helper.sol";

/// Cold gas for the agent paths, same method as RvGas (vm.cool on the staking contract, every token and
/// Permit2; +21k intrinsic). 5 tokens (BZB + 4) x 5 runs. "never-touched" = staked before every run existed
/// and never interacted since. Every well-behaved user path is capped at 1M, like RV-01.
contract AgentGasTest is Permit2Helper {
    uint256 internal constant MIN = 1e15;
    M internal s;
    MockERC20 internal bzb;
    address[] internal toks;
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal carol;
    uint256 internal carolPk;
    address internal zap = makeAddr("zap");

    function setUp() public {
        vm.warp(1_700_000_000);
        _etchPermit2();
        (carol, carolPk) = makeAddrAndKey("carol");
        bzb = new MockERC20("BZB", "BZB", 18);
        s = new M(owner, address(bzb), MIN);
        toks.push(address(bzb));
        for (uint256 i; i < 4; ++i) {
            toks.push(address(new FlakyToken()));
        }
        vm.prank(owner);
        s.addRewardTokens(toks);
        _stake(alice, 10 ether);
        _stake(carol, 10 ether);
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _stake(address who, uint256 amt) internal {
        bzb.mint(who, amt);
        vm.startPrank(who);
        bzb.approve(address(s), amt);
        s.stake(amt);
        vm.stopPrank();
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

    function _measure(string memory label, address who, bytes memory data) internal returns (uint256 used) {
        vm.cool(address(s));
        vm.cool(PERMIT2);
        for (uint256 i; i < toks.length; ++i) {
            vm.cool(toks[i]);
        }
        vm.prank(who);
        uint256 g = gasleft();
        (bool ok,) = address(s).call{gas: 5_000_000}(data);
        used = g - gasleft() + 21_000;
        require(ok, label);
        emit log_named_uint(label, used);
    }

    function test_gas_stakeFor_neverTouched() public {
        _fundAll(30 days);
        vm.warp(_now() + 1 days);
        bzb.mint(zap, 1 ether);
        vm.prank(zap);
        bzb.approve(address(s), 1 ether);
        assertLt(_measure("stakeFor never-touched beneficiary", zap, abi.encodeCall(M.stakeFor, (carol, 1 ether))), 1e6);
    }

    function test_gas_stakeWithPermit2_neverTouched() public {
        _fundAll(30 days);
        vm.warp(_now() + 1 days);
        bzb.mint(carol, 1 ether);
        vm.prank(carol);
        bzb.approve(PERMIT2, type(uint256).max);
        ISignatureTransfer.PermitTransferFrom memory p = _permit(address(bzb), 1 ether, 1, _now() + 1 hours);
        bytes memory sig = _sign(carolPk, p, address(s));
        assertLt(
            _measure(
                "stakeWithPermit2 (relayed) never-touched", zap, abi.encodeCall(M.stakeWithPermit2, (carol, p, sig))
            ),
            1e6
        );
    }

    function test_gas_compound_neverTouched() public {
        _fundAll(30 days);
        vm.warp(_now() + 1 days);
        assertLt(_measure("compound never-touched", carol, abi.encodeCall(M.compound, ())), 1e6);
    }

    function test_gas_claimAllSkipping_neverTouched() public {
        _fundAll(30 days);
        vm.warp(_now() + 1 days);
        assertLt(
            _measure("claimAllSkipping never-touched, 5 paid", carol, abi.encodeCall(M.claimAllSkipping, ())), 1.2e6
        );
    }

    function test_gas_exitSkipping_neverTouched() public {
        _fundAll(30 days);
        vm.warp(_now() + 1 days);
        assertLt(_measure("exitSkipping never-touched, 5 paid", carol, abi.encodeCall(M.exitSkipping, ())), 1.2e6);
    }

    function test_gas_exitSkipping_25finishing() public {
        _fundAll(1 days);
        vm.warp(_now() + 10 days);
        // Skipping exits are not the principal-critical path (withdraw/emergencyWithdraw are, RV-01 1M cap).
        // Cap 1.2M; UI must send estimateGas + 25% or >= 2.2M (covers 5 tokens x SKIP_PAY_GAS burned).
        assertLt(
            _measure("exitSkipping never-touched, 25 runs finishing", carol, abi.encodeCall(M.exitSkipping, ())), 1.2e6
        );
    }

    function test_gas_exit_25finishing_reference() public {
        _fundAll(1 days);
        vm.warp(_now() + 10 days);
        _measure("exit (reference) never-touched, 25 runs finishing", carol, abi.encodeCall(M.exit, ()));
    }

    function test_gas_claimAll_neverTouched_reference() public {
        _fundAll(30 days);
        vm.warp(_now() + 1 days);
        _measure("claimAll (reference) never-touched", carol, abi.encodeCall(M.claimAll, ()));
    }

    /// Worst case: 4 reward tokens burn their whole SKIP_PAY_GAS. Bounded by ~settle + 4 x 200k.
    function test_gas_exitSkipping_fourGasBurners() public {
        _fundAll(30 days);
        vm.warp(_now() + 1 days);
        for (uint256 i = 1; i < 5; ++i) {
            FlakyToken(toks[i]).setMode(3);
        }
        uint256 u = _measure("exitSkipping, 4 tokens burn all forwarded gas", carol, abi.encodeCall(M.exitSkipping, ()));
        assertLt(u, 2_000_000);
    }

    function test_gas_getPosition_view() public {
        _fundAll(30 days);
        vm.warp(_now() + 1 days);
        vm.cool(address(s));
        uint256 g = gasleft();
        s.getPosition(carol);
        emit log_named_uint("getPosition (eth_call) 5 tokens x 5 runs", g - gasleft());
    }
}
