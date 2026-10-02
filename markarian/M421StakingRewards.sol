// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title M421StakingRewards
/// @notice Synthetix StakingRewards accounting (rewardPerToken / earned / updateReward).
///         The fixed notifyRewardAmount window is replaced by a public schedule:
///         500 BzB/day for 100 days, 250 BzB/day for the next 100, then 100 BzB/day.
///         Rewards are not pulled by an admin. Anyone can transfer BzB in.
///         Emission is capped by the unallocated balance and is not back-paid
///         for time when nobody was staked or the contract was unfunded.
contract M421StakingRewards is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable stakingToken;
    IERC20 public immutable rewardsToken;
    uint256 public immutable start;

    uint256 public totalSupply;
    uint256 public rewardPerTokenStored;
    uint256 public rewardAllocated;
    uint256 public lastUpdateTime;

    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);

    modifier updateReward(address account) {
        uint256 rpt = rewardPerToken();
        uint256 emission = totalSupply == 0 ? 0 : ((rpt - rewardPerTokenStored) * totalSupply) / 1e18;
        rewardPerTokenStored = rpt;
        rewardAllocated += emission;
        lastUpdateTime = block.timestamp;
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rpt;
        }
        _;
    }

    constructor(address stakingToken_, address rewardsToken_, uint256 start_) {
        require(stakingToken_ != address(0) && rewardsToken_ != address(0), "token");
        require(start_ != 0, "start");
        stakingToken = IERC20(stakingToken_);
        rewardsToken = IERC20(rewardsToken_);
        start = start_;
        lastUpdateTime = start_;
    }

    /// @dev Cumulative scheduled BzB from `start` to `t`, ignoring funding.
    function cumulativeRewards(uint256 t) public view returns (uint256) {
        if (t <= start) return 0;
        uint256 elapsed = t - start;
        uint256 day = 1 days;
        uint256 first = 100 days;
        uint256 second = 200 days;
        if (elapsed <= first) return (500 ether * elapsed) / day;
        if (elapsed <= second) {
            return (500 ether * first) / day + (250 ether * (elapsed - first)) / day;
        }
        return (500 ether * first) / day + (250 ether * first) / day + (100 ether * (elapsed - second)) / day;
    }

    function currentDailyRate() public view returns (uint256) {
        if (block.timestamp <= start) return 500 ether;
        uint256 elapsed = block.timestamp - start;
        if (elapsed < 100 days) return 500 ether;
        if (elapsed < 200 days) return 250 ether;
        return 100 ether;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalSupply == 0) return rewardPerTokenStored;
        uint256 scheduled = cumulativeRewards(block.timestamp) - cumulativeRewards(lastUpdateTime);
        uint256 emission = scheduled > _available() ? _available() : scheduled;
        return rewardPerTokenStored + (emission * 1e18) / totalSupply;
    }

    function earned(address account) public view returns (uint256) {
        return (balanceOf[account] * (rewardPerToken() - userRewardPerTokenPaid[account])) / 1e18 + rewards[account];
    }

    function stake(uint256 amount) external nonReentrant updateReward(msg.sender) {
        require(amount > 0, "amount");
        totalSupply += amount;
        balanceOf[msg.sender] += amount;
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    function withdraw(uint256 amount) public nonReentrant updateReward(msg.sender) {
        require(amount > 0 && balanceOf[msg.sender] >= amount, "amount");
        totalSupply -= amount;
        balanceOf[msg.sender] -= amount;
        stakingToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function getReward() public nonReentrant updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        if (reward == 0) return;
        rewards[msg.sender] = 0;
        rewardAllocated -= reward;
        rewardsToken.safeTransfer(msg.sender, reward);
        emit RewardPaid(msg.sender, reward);
    }

    function exit() external {
        withdraw(balanceOf[msg.sender]);
        getReward();
    }

    function _available() internal view returns (uint256) {
        uint256 bal = rewardsToken.balanceOf(address(this));
        return bal > rewardAllocated ? bal - rewardAllocated : 0;
    }
}
