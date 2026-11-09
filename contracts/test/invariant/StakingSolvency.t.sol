// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {BlazarStakingRewards} from "../../src/BlazarStakingRewards.sol";
import {MockERC20} from "../Mocks.sol";

contract StakingHandler is Test {
    BlazarStakingRewards public staking;
    MockERC20 public bzb;
    address public owner;
    address[] public actors;
    mapping(address => uint256) public principal;

    constructor(BlazarStakingRewards staking_, MockERC20 bzb_, address owner_) {
        staking = staking_;
        bzb = bzb_;
        owner = owner_;
        actors.push(makeAddr("s0"));
        actors.push(makeAddr("s1"));
        actors.push(makeAddr("s2"));
        actors.push(makeAddr("s3"));
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function stake(uint256 seed, uint256 amount) external {
        amount = bound(amount, 1e15, 100 ether);
        address actor = _actor(seed);
        bzb.mint(actor, amount);
        vm.startPrank(actor);
        bzb.approve(address(staking), amount);
        staking.stake(amount);
        vm.stopPrank();
        principal[actor] += amount;
    }

    function withdraw(uint256 seed, uint256 amount) external {
        address actor = _actor(seed);
        uint256 bal = staking.balanceOf(actor);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(actor);
        staking.withdraw(amount);
        principal[actor] -= amount;
    }

    function claim(uint256 seed) external {
        address actor = _actor(seed);
        uint256 earnedBefore = staking.earned(actor);
        uint256 balBefore = bzb.balanceOf(actor);
        vm.prank(actor);
        staking.getReward();
        assertEq(bzb.balanceOf(actor) - balBefore, earnedBefore);
    }

    function exit(uint256 seed) external {
        address actor = _actor(seed);
        vm.prank(actor);
        staking.exit();
        principal[actor] = 0;
    }

    function notify(uint256 amount) external {
        amount = bound(amount, 1 ether, 50 ether);
        bzb.mint(owner, amount);
        vm.startPrank(owner);
        bzb.approve(address(staking), amount);
        try staking.notifyRewardAmount(amount) {} catch {}
        vm.stopPrank();
    }

    function warp(uint256 seconds_) external {
        seconds_ = bound(seconds_, 1, 20 days);
        vm.warp(block.timestamp + seconds_);
    }

    function recoverSurplus(uint256 amount) external {
        uint256 bal = bzb.balanceOf(address(staking));
        uint256 locked = _locked();
        if (bal <= locked) return;
        amount = bound(amount, 1, bal - locked);
        vm.prank(owner);
        staking.recover(address(bzb), amount, owner);
    }

    function _locked() public view returns (uint256) {
        uint256 applicable = staking.lastTimeRewardApplicable();
        uint256 pending;
        if (staking.totalSupply() > 0 && applicable > staking.lastUpdateTime()) {
            pending = (applicable - staking.lastUpdateTime()) * staking.rewardRate();
        }
        uint256 unclaimed = staking.streamed() + pending - staking.paidOut();
        uint256 future = staking.periodFinish() > applicable ? (staking.periodFinish() - applicable) * staking.rewardRate() : 0;
        return staking.totalSupply() + unclaimed + future;
    }

    function sumPrincipal() public view returns (uint256 sum) {
        for (uint256 i; i < actors.length; ++i) {
            sum += principal[actors[i]];
            assertEq(staking.balanceOf(actors[i]), principal[actors[i]]);
        }
    }
}

contract StakingSolvencyInvariant is Test {
    StakingHandler internal handler;
    BlazarStakingRewards internal staking;
    MockERC20 internal bzb;

    function setUp() public {
        bzb = new MockERC20("BlazarBits", "BZB", 18);
        address owner = makeAddr("owner");
        staking = new BlazarStakingRewards(owner, address(bzb));
        handler = new StakingHandler(staking, bzb, owner);
        targetContract(address(handler));
    }

    function invariant_principalMatchesBalances() public view {
        assertEq(handler.sumPrincipal(), staking.totalSupply());
    }

    function invariant_balanceCoversPrincipalAndRewards() public view {
        assertGe(bzb.balanceOf(address(staking)), handler._locked());
    }
}
