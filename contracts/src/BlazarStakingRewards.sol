// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title BlazarStakingRewards
/// @notice Stake BZB, earn BZB. Synthetix reward-per-token accounting.
///         The owner refills the reward float and sets the stream with `notifyRewardAmount`.
///         The rate is `reward / rewardsDuration` (leftover time on the previous stream is blended in).
///         There is no lock and no fee. Withdrawal and claiming stay open while paused so a pause
///         cannot trap staked BZB.
contract BlazarStakingRewards is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable bzb;

    uint256 public totalSupply;
    uint256 public rewardPerTokenStored;
    /// @notice Exact rewards credited to users and not yet paid. Increased only by the
    ///         amount a checkpoint writes into `rewards`, so it cannot fall behind a claim.
    uint256 public rewardAllocated;
    /// @notice Exact `rewardRate * time` streamed while someone was staked.
    uint256 public streamed;
    uint256 public paidOut;
    uint256 public rewardRate;
    uint256 public rewardsDuration = 7 days;
    uint256 public periodFinish;
    uint256 public lastUpdateTime;

    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
    event RewardAdded(uint256 reward, uint256 rate, uint256 periodFinish);
    event RewardsDurationSet(uint256 duration);
    event Recovered(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error BadDuration();
    error PeriodLive();
    error Underfunded();
    error RateZero();

    constructor(address initialOwner, address bzb_) Ownable(initialOwner) {
        if (bzb_ == address(0)) revert ZeroAddress();
        bzb = IERC20(bzb_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setRewardsDuration(uint256 next) external onlyOwner {
        if (block.timestamp <= periodFinish) revert PeriodLive();
        if (next < 1 days || next > 365 days) revert BadDuration();
        rewardsDuration = next;
        emit RewardsDurationSet(next);
    }

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalSupply == 0) return rewardPerTokenStored;
        return rewardPerTokenStored
            + Math.mulDiv(lastTimeRewardApplicable() - lastUpdateTime, rewardRate * 1e18, totalSupply);
    }

    function earned(address account) public view returns (uint256) {
        return Math.mulDiv(balanceOf[account], rewardPerToken() - userRewardPerTokenPaid[account], 1e18) + rewards[account];
    }

    /// @notice BZB/day currently streaming. Zero after `periodFinish`.
    function dailyRate() external view returns (uint256) {
        if (block.timestamp >= periodFinish) return 0;
        return rewardRate * 1 days;
    }

    /// @notice Pull `reward` BZB from the owner and stream it over `rewardsDuration`.
    function notifyRewardAmount(uint256 reward) external onlyOwner whenNotPaused nonReentrant updateReward(address(0)) {
        if (reward == 0) revert ZeroAmount();
        uint256 beforeBal = bzb.balanceOf(address(this));
        bzb.safeTransferFrom(msg.sender, address(this), reward);
        uint256 received = bzb.balanceOf(address(this)) - beforeBal;
        if (received == 0) revert ZeroAmount();
        if (block.timestamp >= periodFinish) {
            rewardRate = received / rewardsDuration;
        } else {
            uint256 leftover = (periodFinish - block.timestamp) * rewardRate;
            rewardRate = (received + leftover) / rewardsDuration;
        }
        if (rewardRate == 0) revert RateZero();
        uint256 future = rewardRate * rewardsDuration;
        uint256 locked = totalSupply + _unclaimed() + future;
        if (bzb.balanceOf(address(this)) < locked) revert Underfunded();
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + rewardsDuration;
        emit RewardAdded(reward, rewardRate, periodFinish);
    }

    function stake(uint256 amount) external nonReentrant whenNotPaused updateReward(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        uint256 beforeBal = bzb.balanceOf(address(this));
        bzb.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = bzb.balanceOf(address(this)) - beforeBal;
        if (received == 0) revert ZeroAmount();
        totalSupply += received;
        balanceOf[msg.sender] += received;
        emit Staked(msg.sender, received);
    }

    function withdraw(uint256 amount) external nonReentrant updateReward(msg.sender) {
        _withdraw(msg.sender, amount);
    }

    function getReward() external nonReentrant updateReward(msg.sender) {
        _pay(msg.sender);
    }

    function exit() external nonReentrant updateReward(msg.sender) {
        uint256 bal = balanceOf[msg.sender];
        if (bal > 0) _withdraw(msg.sender, bal);
        _pay(msg.sender);
    }

    /// @notice Pull tokens that are not staked BZB and not committed to the current reward stream
    ///         or to already-earned but unclaimed rewards.
    function recover(address token, uint256 amount, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (token == address(bzb)) {
            uint256 future = periodFinish > lastTimeRewardApplicable() ? (periodFinish - lastTimeRewardApplicable()) * rewardRate : 0;
            uint256 locked = totalSupply + _unclaimed() + future;
            if (bzb.balanceOf(address(this)) < locked + amount) revert Underfunded();
        }
        IERC20(token).safeTransfer(to, amount);
        emit Recovered(token, to, amount);
    }

    function _withdraw(address account, uint256 amount) internal {
        if (amount == 0 || balanceOf[account] < amount) revert ZeroAmount();
        totalSupply -= amount;
        balanceOf[account] -= amount;
        bzb.safeTransfer(account, amount);
        emit Withdrawn(account, amount);
    }

    function _pay(address account) internal {
        uint256 reward = rewards[account];
        if (reward == 0) return;
        rewards[account] = 0;
        rewardAllocated -= reward;
        paidOut += reward;
        bzb.safeTransfer(account, reward);
        emit RewardPaid(account, reward);
    }

    /// @dev Exact wei streamed since the last checkpoint, plus earlier `streamed`, minus payouts.
    function _unclaimed() internal view returns (uint256) {
        uint256 pending;
        uint256 applicable = lastTimeRewardApplicable();
        if (totalSupply > 0 && applicable > lastUpdateTime) {
            pending = (applicable - lastUpdateTime) * rewardRate;
        }
        return streamed + pending - paidOut;
    }

    modifier updateReward(address account) {
        uint256 rpt = rewardPerToken();
        uint256 applicable = lastTimeRewardApplicable();
        if (totalSupply > 0 && applicable > lastUpdateTime) {
            streamed += (applicable - lastUpdateTime) * rewardRate;
        }
        rewardPerTokenStored = rpt;
        lastUpdateTime = applicable;
        if (account != address(0)) {
            uint256 updated = earned(account);
            if (updated > rewards[account]) rewardAllocated += updated - rewards[account];
            rewards[account] = updated;
            userRewardPerTokenPaid[account] = rpt;
        }
        _;
    }
}
