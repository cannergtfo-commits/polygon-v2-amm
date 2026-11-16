// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, Vm} from "forge-std/Test.sol";
import {BlazarMultiRewardStaking as M} from "../../../src/BlazarMultiRewardStaking.sol";
import {MockERC20} from "../../Mocks.sol";

/// Gas table, 5 tokens (BZB + 4) x 5 live runs. Run with `forge test --isolate` so each call is its own tx
/// (cold storage), and read vm.lastFrameGas(). Reported numbers exclude the 21k intrinsic + calldata.
contract P2GasTest is Test {
    M internal s;
    MockERC20 internal bzb;
    address[] internal toks;
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function _warp(uint256 dt) internal {
        vm.warp(vm.getBlockTimestamp() + dt);
    }

    function _g(string memory label) internal {
        Vm.Gas memory g = vm.lastFrameGas();
        emit log_named_uint(label, g.gasTotalUsed);
    }

    function _fund(address token, uint256 amount, uint64 duration, uint64 st) internal {
        MockERC20(token).mint(owner, amount);
        vm.prank(owner);
        MockERC20(token).approve(address(s), amount);
        vm.prank(owner);
        s.notifyRewardAmount(M.RunConfig(token, amount, duration, st, 3000, 7000));
    }

    function _stake(address who, uint256 amount) internal {
        bzb.mint(who, amount);
        vm.prank(who);
        bzb.approve(address(s), amount);
        vm.prank(who);
        s.stake(amount);
    }

    function setUp() public {
        vm.warp(1_700_000_000);
        bzb = new MockERC20("BZB", "BZB", 18);
        s = new M(owner, address(bzb), 1e15);
        toks.push(address(bzb));
        for (uint256 i; i < 4; ++i) {
            toks.push(address(new MockERC20("R", "R", i == 0 ? 6 : 18)));
        }
        vm.prank(owner);
        s.addRewardTokens(toks);
        _stake(alice, 10 ether);
        _stake(bob, 10 ether);
        _stake(carol, 10 ether);
    }

    function test_P2_gasTable() public {
        // notify into an empty token, then 2nd..5th run (each checkpoints existing runs)
        for (uint256 i; i < 5; ++i) {
            for (uint256 j; j < 5; ++j) {
                _fund(
                    toks[i],
                    1000 ether,
                    uint64(30 days + j * 1 days),
                    j == 4 ? uint64(vm.getBlockTimestamp() + 1 days) : 0
                );
                if (i == 4) _g(string(abi.encodePacked("notify run #", vm.toString(j + 1), " (token 5)")));
            }
        }
        _warp(3 days);
        _stake(alice, 1 ether);
        _g("stake, 5x5 live runs, first checkpoint after funding");
        _warp(1 hours);
        vm.prank(bob);
        s.withdraw(1 ether);
        _g("withdraw, 5x5 live runs (steady state)");
        _warp(1 hours);
        vm.prank(carol);
        s.claim(toks[1]);
        _g("claim(one token), 5 live runs");
        _warp(1 hours);
        address[] memory three = new address[](3);
        three[0] = toks[1];
        three[1] = toks[2];
        three[2] = toks[3];
        vm.prank(carol);
        s.claimManyTo(three, makeAddr("dest"));
        _g("claimManyTo(3 tokens)");
        _warp(1 hours);
        vm.prank(alice);
        s.claimAll();
        _g("claimAll, 5x5");
        _warp(1 hours);
        MockERC20(toks[2]).mint(address(s), 5);
        vm.prank(owner);
        s.recover(toks[2], 5, owner);
        _g("recover(listed token, 5 live runs)");
        _warp(1 hours);
        vm.prank(bob);
        s.emergencyWithdraw();
        _g("emergencyWithdraw, 5 tokens (stale credit)");
        _warp(40 days); // all runs finish
        vm.prank(alice);
        s.withdraw(1 ether);
        _g("withdraw, pruning 25 finished runs");
        vm.prank(carol);
        s.exit();
        _g("exit, 5 tokens, after prune");
    }

    /// Worst case for withdraw: nobody touched any token since all 25 runs were funded at different curves.
    function test_P2_gasWithdrawWorst() public {
        for (uint256 i; i < 5; ++i) {
            for (uint256 j; j < 5; ++j) {
                _fund(toks[i], 1000 ether + j, uint64(365 days - j), 0);
            }
        }
        _warp(100 days);
        vm.prank(alice);
        s.withdraw(10 ether);
        _g("withdraw full, 25 live runs, all need SSTORE, cold");
        vm.prank(bob);
        s.emergencyWithdraw();
        _g("emergencyWithdraw, 5 tokens");
    }
}
