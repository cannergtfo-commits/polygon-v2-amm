// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {BlazarMultiRewardStaking as M} from "../../../src/BlazarMultiRewardStaking.sol";
import {MockERC20} from "../../Mocks.sol";

/// Worst-case gas, 5 tokens x 5 runs. Every measured call is preceded by vm.cool() on the staking contract
/// and every token so storage/account access is priced cold, as in a real transaction.
contract Pass1GasTest is Test {
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
        bzb = new MockERC20("BlazarBits", "BZB", 18);
        s = new M(owner, address(bzb), MIN);
        toks.push(address(bzb));
        for (uint256 i; i < 4; ++i) {
            toks.push(address(new MockERC20("R", "R", 18)));
        }
        vm.prank(owner);
        s.addRewardTokens(toks);
        _stake(alice, 10 ether);
        _stake(bob, 10 ether);
        _stake(carol, 10 ether);
        for (uint256 i; i < 5; ++i) {
            for (uint256 j; j < 5; ++j) {
                _fund(toks[i], 100 ether, uint64(30 days + j * 1 days), uint16(1 + j), uint16(5 - j));
            }
        }
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _warp(uint256 dt) internal {
        vm.warp(_now() + dt);
    }

    function _fund(address t, uint256 amt, uint64 dur, uint16 wS, uint16 wE) internal {
        MockERC20(t).mint(owner, amt);
        vm.startPrank(owner);
        MockERC20(t).approve(address(s), amt);
        s.notifyRewardAmount(
            M.RunConfig({token: t, amount: amt, duration: dur, startTime: 0, startWeight: wS, endWeight: wE})
        );
        vm.stopPrank();
    }

    function _stake(address who, uint256 amt) internal {
        bzb.mint(who, amt);
        vm.startPrank(who);
        bzb.approve(address(s), amt);
        s.stake(amt);
        vm.stopPrank();
    }

    function _coolAll() internal {
        vm.cool(address(s));
        for (uint256 i; i < toks.length; ++i) {
            vm.cool(toks[i]);
        }
    }

    function _measure(string memory label, address who, bytes memory data) internal returns (uint256 used) {
        _coolAll();
        vm.prank(who);
        uint256 g = gasleft();
        (bool ok,) = address(s).call(data);
        used = g - gasleft();
        require(ok, label);
        emit log_named_uint(label, used + 21_000);
    }

    function test_gas_worstCase() public {
        _warp(3 days);
        bzb.mint(alice, 1 ether);
        vm.prank(alice);
        bzb.approve(address(s), 1 ether);
        uint256 a = _measure("stake (5x5 live, first checkpoint in 3d)", alice, abi.encodeCall(M.stake, (1 ether)));
        _warp(1 hours);
        uint256 b = _measure("withdraw partial (5x5 live)", alice, abi.encodeCall(M.withdraw, (1 ether)));
        _warp(1 hours);
        uint256 c = _measure("claimMany(5 tokens) (5x5 live)", bob, abi.encodeCall(M.claimMany, (toks)));
        _warp(1 hours);
        uint256 d = _measure("claimAll (5x5 live)", carol, abi.encodeCall(M.claimAll, ()));
        _warp(1 hours);
        uint256 e = _measure("claim(1 token) (5 runs)", alice, abi.encodeCall(M.claim, (toks[2])));
        _warp(1 hours);
        uint256 f = _measure("emergencyWithdraw (5 tokens)", carol, abi.encodeCall(M.emergencyWithdraw, ()));
        _warp(1 hours);
        // owner notify with 4 live runs + 1 free slot
        _warp(40 days); // everything finishes
        uint256 gx = _measure("exit (prunes 25 finished runs, pays 5)", bob, abi.encodeCall(M.exit, ()));
        uint256 h = _measure("withdraw all (post-prune)", alice, abi.encodeCall(M.withdraw, (s.balanceOf(alice))));
        uint256 mx = a;
        uint256[7] memory all = [a, b, c, d, e, f, gx];
        for (uint256 i; i < 7; ++i) {
            if (all[i] > mx) mx = all[i];
        }
        if (h > mx) mx = h;
        emit log_named_uint("max user-path gas", mx + 21_000);
        assertLt(mx, 2_000_000, "well under Polygon 30M+ block gas");
    }

    function test_gas_emergencyWithdrawFreshUser() public {
        _warp(5 days);
        vm.prank(alice);
        s.claimAll(); // checkpoints every token
        _warp(1 days);
        uint256 used =
            _measure("emergencyWithdraw, never-touched user, 5 tokens", carol, abi.encodeCall(M.emergencyWithdraw, ()));
        // L-1 fix: emergencyWithdraw now checkpoints every listed token (all runs) before exiting.
        assertLt(used, 900_000);
    }

    function test_gas_notifyWith4LiveRuns() public {
        _warp(30 days + 12 hours); // slot 0 (30d) finished, others live
        MockERC20(toks[1]).mint(owner, 1 ether);
        vm.prank(owner);
        MockERC20(toks[1]).approve(address(s), 1 ether);
        uint256 used = _measure(
            "notifyRewardAmount (prunes 1, 4 live)",
            owner,
            abi.encodeCall(
                M.notifyRewardAmount,
                (M.RunConfig({
                        token: toks[1], amount: 1 ether, duration: 1 days, startTime: 0, startWeight: 1, endWeight: 1
                    }))
            )
        );
        assertLt(used, 500_000);
    }
}
