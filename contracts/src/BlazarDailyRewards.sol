// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title BlazarDailyRewards
/// @notice Pull-claim pot for the daily top 25 BZB traders. The leaderboard UI lists 50;
///         only these 25 are paid, at a fixed share of `dailyCap`. Empty ranks are not
///         redistributed, so unpaid BZB stays in the pot.
/// @dev 25 winners are stored on-chain instead of a Merkle root. Posting is one transaction
///      a day (about 50 storage writes). On Polygon that costs cents, the desk can read the
///      day with no proof file, and a reverting trader cannot block the other claims.
///      A Merkle root would be cheaper to post and more expensive to operate. The poster
///      role is not the owner. The owner can rotate it and can still pause or withdraw.
contract BlazarDailyRewards is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant SLOTS = 25;
    uint256 public constant MAX_DAILY_CAP = 1000 ether;
    address public constant INITIAL_POSTER = 0x55BA739Ba386D634CF81bd53d974dAF95241952C;

    IERC20 public immutable bzb;

    /// @notice BZB allocated across a full day. Hard-capped at 1000 BZB. Default is the cap.
    uint256 public dailyCap = MAX_DAILY_CAP;
    uint256 public claimWindow = 30 days;
    /// @notice BZB reserved for posted, unclaimed days.
    uint256 public reserved;
    /// @notice Sum of every posted day. Informational. The live limit is `postedThisDay`.
    uint256 public totalPosted;
    uint256 public immutable startDay;
    /// @notice Reservations made during this UTC calendar day. `dailyCap` is read at the
    ///         posting transaction. There is no stored cap for the scored day, and this is
    ///         not a rolling 24 hour budget. A day that is no longer yesterday cannot be posted.
    uint256 public bucketDay;
    uint256 public postedThisDay;
    uint256 public constant CATCHUP_DAYS = 1;
    /// @notice May call `postWinners`. Not the owner and not the fee recipient.
    address public poster;

    struct Day {
        uint64 postedAt;
        uint64 deadline;
        uint256 total;
        uint256 claimedTotal;
        bool posted;
    }

    mapping(uint256 => Day) public dayInfo;
    mapping(uint256 => address[25]) private _traders;
    mapping(uint256 => uint256[25]) private _amounts;
    mapping(uint256 => mapping(address => bool)) public claimed;

    event Funded(address indexed from, uint256 amount);
    event DayPosted(uint256 indexed dayId, uint256 total, uint64 deadline);
    event RewardClaimed(uint256 indexed dayId, address indexed trader, uint256 amount);
    event Reclaimed(uint256 indexed dayId, uint256 amount);
    event ScheduleSet(uint256 dailyCap, uint256 claimWindow);
    event PosterSet(address indexed poster);
    event EmergencyWithdraw(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error BadSchedule();
    error DayStillOpen(uint256 dayId);
    error AlreadyPosted(uint256 dayId);
    error EmptyDay();
    error Cap();
    error WrongShare(uint256 index, uint256 expected, uint256 given);
    error DuplicateTrader();
    error Insolvent();
    error NothingToClaim();
    error ExpiredDay();
    error StillLive();
    error Reserved();
    error NotPoster();
    error BeforeCampaign(uint256 dayId);
    error StaleDay(uint256 dayId);

    constructor(address initialOwner, address bzb_, address poster_) Ownable(initialOwner) {
        if (bzb_ == address(0) || poster_ == address(0)) revert ZeroAddress();
        bzb = IERC20(bzb_);
        poster = poster_;
        startDay = block.timestamp / 1 days;
        emit PosterSet(poster_);
    }

    /// @notice Share of `dailyCap` for rank `index` (0 = first place), in bps. Sum is 10_000.
    ///         Ranks 4–25 are a largest-remainder apportionment of 7_000 bps on weights
    ///         268, 260, …, 100 (step −8). The whole table is strictly descending.
    function shareBps(uint256 index) public pure returns (uint256) {
        if (index >= SLOTS) revert BadSchedule();
        uint16[25] memory shares = [
            uint16(1500),
            1000,
            500,
            464,
            450,
            436,
            422,
            409,
            395,
            381,
            367,
            353,
            339,
            326,
            312,
            297,
            283,
            269,
            255,
            242,
            228,
            214,
            200,
            186,
            172
        ];
        return shares[index];
    }

    function fund(uint256 amount) external {
        bzb.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    function setPoster(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        poster = next;
        emit PosterSet(next);
    }

    function setSchedule(uint256 dailyCap_, uint256 claimWindow_) external onlyOwner {
        if (dailyCap_ > MAX_DAILY_CAP) revert Cap();
        if (claimWindow_ < 1 days || claimWindow_ > 180 days) revert BadSchedule();
        dailyCap = dailyCap_;
        claimWindow = claimWindow_;
        emit ScheduleSet(dailyCap_, claimWindow_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @param traders Rank order. Unused ranks are address(0) with a zero amount.
    ///        A filled rank must be paid exactly `dailyCap * shareBps(i) / 10_000`.
    function postWinners(uint256 dayId, address[25] calldata traders, uint256[25] calldata amounts)
        external
        whenNotPaused
    {
        if (msg.sender != poster) revert NotPoster();
        if (dayId < startDay) revert BeforeCampaign(dayId);
        uint256 today = block.timestamp / 1 days;
        if (dayId >= today) revert DayStillOpen(dayId);
        if (dayInfo[dayId].posted) revert AlreadyPosted(dayId);

        uint256 sum;
        for (uint256 i; i < SLOTS; ++i) {
            uint256 expected = traders[i] == address(0) ? 0 : Math.mulDiv(dailyCap, shareBps(i), 10_000);
            if (amounts[i] != expected) revert WrongShare(i, expected, amounts[i]);
            if (traders[i] == address(0)) continue;
            for (uint256 j; j < i; ++j) {
                if (traders[j] == traders[i]) revert DuplicateTrader();
            }
            sum += amounts[i];
        }
        if (sum == 0) revert EmptyDay();
        if (sum > dailyCap) revert Cap();
        if (today <= dayId || today - dayId > CATCHUP_DAYS) revert StaleDay(dayId);
        if (bucketDay != today) {
            bucketDay = today;
            postedThisDay = 0;
        }
        if (postedThisDay + sum > dailyCap) revert Cap();
        if (bzb.balanceOf(address(this)) < reserved + sum) revert Insolvent();

        uint64 deadline = uint64(block.timestamp + claimWindow);
        dayInfo[dayId] = Day({postedAt: uint64(block.timestamp), deadline: deadline, total: sum, claimedTotal: 0, posted: true});
        _traders[dayId] = traders;
        _amounts[dayId] = amounts;
        reserved += sum;
        totalPosted += sum;
        postedThisDay += sum;
        emit DayPosted(dayId, sum, deadline);
    }

    function claim(uint256 dayId) external nonReentrant whenNotPaused returns (uint256 amount) {
        amount = _claim(dayId, msg.sender);
    }

    function claimMany(uint256[] calldata dayIds) external nonReentrant whenNotPaused returns (uint256 total) {
        for (uint256 i; i < dayIds.length; ++i) {
            total += _claim(dayIds[i], msg.sender);
        }
    }

    function reclaimExpired(uint256 dayId) external onlyOwner {
        Day storage day = dayInfo[dayId];
        if (!day.posted) revert NothingToClaim();
        if (block.timestamp <= day.deadline) revert StillLive();
        uint256 left = day.total - day.claimedTotal;
        day.claimedTotal = day.total;
        reserved -= left;
        emit Reclaimed(dayId, left);
    }

    function emergencyWithdraw(address token, uint256 amount, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (token == address(bzb)) {
            uint256 bal = bzb.balanceOf(address(this));
            if (bal < reserved || amount > bal - reserved) revert Reserved();
        }
        IERC20(token).safeTransfer(to, amount);
        emit EmergencyWithdraw(token, to, amount);
    }

    function claimable(uint256 dayId, address trader) external view returns (uint256) {
        if (claimed[dayId][trader]) return 0;
        Day memory day = dayInfo[dayId];
        if (!day.posted || block.timestamp > day.deadline) return 0;
        return _find(dayId, trader);
    }

    function winner(uint256 dayId, uint256 index) external view returns (address trader, uint256 amount) {
        if (index >= SLOTS) revert BadSchedule();
        trader = _traders[dayId][index];
        amount = _amounts[dayId][index];
    }

    function _claim(uint256 dayId, address trader) internal returns (uint256 amount) {
        Day storage day = dayInfo[dayId];
        if (!day.posted) revert NothingToClaim();
        if (block.timestamp > day.deadline) revert ExpiredDay();
        if (claimed[dayId][trader]) revert NothingToClaim();
        amount = _find(dayId, trader);
        if (amount == 0) revert NothingToClaim();
        claimed[dayId][trader] = true;
        day.claimedTotal += amount;
        reserved -= amount;
        bzb.safeTransfer(trader, amount);
        emit RewardClaimed(dayId, trader, amount);
    }

    function _find(uint256 dayId, address trader) internal view returns (uint256) {
        for (uint256 i; i < SLOTS; ++i) {
            if (_traders[dayId][i] == trader) return _amounts[dayId][i];
        }
        return 0;
    }
}
