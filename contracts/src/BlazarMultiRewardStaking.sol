// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title BlazarMultiRewardStaking
/// @notice Stake one immutable token (BZB). Earn up to `MAX_REWARD_TOKENS` ERC20 reward tokens at once.
///
///         Every reward token has its own independent run: amount, start, duration and emission curve.
///         The curve is linear in time. The owner picks a start weight and an end weight (0..10_000 each,
///         not both zero). Equal weights give a flat stream; a higher end weight ramps emissions up; a higher
///         start weight ramps them down. The instantaneous rate is proportional to
///             w(x) = startWeight + (endWeight - startWeight) * x / D        (x = seconds since start, D = duration)
///         and the cumulative amount emitted after x seconds is the exact closed-form integral
///             E(x) = amount * (startWeight * x * (2D - x) + endWeight * x^2) / (D^2 * (startWeight + endWeight))
///         rounded down. E(0) = 0, E(D) = amount exactly, and E is non-decreasing, so the sum of the
///         per-checkpoint deltas E(b) - E(a) telescopes to exactly `amount` regardless of how often anyone
///         checkpoints. Total emission can never exceed the funded amount.
///
///         Accounting is Synthetix-style reward-per-token (scaled by 1e36 for low-decimal reward tokens and a
///         large staked supply). For each reward token the contract tracks:
///           - `owed`:      emitted while someone was staked and not yet paid out (covers every user's credit)
///           - future:      `run.amount - run.emitted` (not yet emitted from the current run)
///         `reserved(token) = owed + future (+ totalStaked if token is the staking token)`. Every funding call
///         checks `balance >= reserved`, and `recover` can only take `balance - reserved`. Staked principal is
///         tracked separately and is never counted as reward funding, even when BZB is also a reward token.
///
///         Emission that happens while nobody is staked is not credited to anyone. It leaves `reserved` and
///         becomes recoverable surplus (see `recoverable`), so it is never lost and never double-counted.
///
///         Safety properties:
///           - `withdraw` and `emergencyWithdraw` never call a reward token and work while paused.
///           - Claims are per token (`claim`, `claimMany`, `claimAll`); a reverting or blacklisting reward
///             token can only block its own claims.
///           - Unclaimed rewards survive new runs, top-ups, new reward tokens and pausing.
///           - Fee-on-transfer funding and staking are measured by balance delta. Rebasing tokens are NOT
///             supported as reward or staking tokens (a negative rebase can break solvency).
///           - Reward tokens cannot be removed (keeps every user's accounting exact); the list is capped.
contract BlazarMultiRewardStaking is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_REWARD_TOKENS = 10;
    uint256 public constant MIN_DURATION = 1 days;
    uint256 public constant MAX_DURATION = 365 days;
    uint256 public constant MAX_START_DELAY = 30 days;
    uint256 public constant MAX_WEIGHT = 10_000;
    /// @notice Upper bound on a run's total amount. Keeps `delta * PRECISION` inside 256 bits so the
    ///         checkpoint math (used by withdraw) can never overflow.
    uint256 public constant MAX_RUN_AMOUNT = type(uint128).max;
    uint256 public constant PRECISION = 1e36;

    struct Run {
        uint128 amount; // total amount scheduled for this run (rolled-over remainder + new funding)
        uint128 emitted; // E(elapsed) at the last checkpoint, within this run
        uint64 start;
        uint64 duration;
        uint16 startWeight;
        uint16 endWeight;
    }

    struct RewardState {
        bool listed;
        uint256 rewardPerTokenStored;
        uint256 owed; // emitted while staked, not yet paid
        Run run;
    }

    struct RunConfig {
        address token;
        uint256 amount; // requested transfer amount; the run is credited with what actually arrives
        uint64 duration;
        uint64 startTime; // 0 = now; otherwise now <= startTime <= now + MAX_START_DELAY
        uint16 startWeight;
        uint16 endWeight;
    }

    IERC20 public immutable stakingToken;
    /// @notice Smallest non-zero position. Every balance is 0 or >= minStake, so `totalStaked` is 0 or
    ///         >= minStake. This bounds the per-checkpoint reward-per-token increment
    ///         (<= MAX_RUN_AMOUNT * PRECISION / minStake), so the accumulator can never overflow and the
    ///         checkpoint that `withdraw` runs can never revert.
    uint256 public immutable minStake;

    uint256 public totalStaked;
    mapping(address => uint256) public balanceOf;

    address[] internal _rewardTokens;
    mapping(address => RewardState) internal _rewards;
    mapping(address => mapping(address => uint256)) public userRewardPerTokenPaid; // user => token => rpt
    mapping(address => mapping(address => uint256)) public rewards; // user => token => credited, unpaid

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event EmergencyWithdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, address indexed token, uint256 amount);
    event RewardTokenAdded(address indexed token);
    event RunStarted(
        address indexed token,
        uint256 received,
        uint256 rolledOver,
        uint256 amount,
        uint256 start,
        uint256 duration,
        uint16 startWeight,
        uint16 endWeight
    );
    event Recovered(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error NotContract();
    error AlreadyListed();
    error NotListed();
    error TooManyRewardTokens();
    error BadDuration();
    error BadWeights();
    error BadStart();
    error AmountTooLarge();
    error InsufficientBalance();
    error Underfunded();
    error RenounceDisabled();
    error BelowMinStake();

    constructor(address initialOwner, address stakingToken_, uint256 minStake_) Ownable(initialOwner) {
        if (stakingToken_ == address(0)) revert ZeroAddress();
        if (stakingToken_.code.length == 0) revert NotContract();
        if (minStake_ == 0) revert ZeroAmount();
        stakingToken = IERC20(stakingToken_);
        minStake = minStake_;
    }

    // ------------------------------------------------------------------
    // Owner
    // ------------------------------------------------------------------

    /// @notice Ownership can only move by the two-step transfer. Renouncing would strand surplus and
    ///         make further runs impossible, so it is disabled. Users can always withdraw and claim anyway.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /// @notice Pauses new stakes and new runs. Withdraw, emergencyWithdraw and claims stay open.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice List a reward token. Listing is permanent (see contract notes). Capped at MAX_REWARD_TOKENS.
    function addRewardToken(address token) external onlyOwner {
        _addRewardToken(token);
    }

    function addRewardTokens(address[] calldata tokens) external onlyOwner {
        for (uint256 i; i < tokens.length; ++i) {
            _addRewardToken(tokens[i]);
        }
    }

    /// @notice Fund one run. If the token has a live (or scheduled) run, its not-yet-emitted remainder is
    ///         rolled into the new run, which then follows the new duration and curve. Rewards already
    ///         emitted are checkpointed first and stay owed to stakers.
    function notifyRewardAmount(RunConfig calldata cfg) external nonReentrant onlyOwner whenNotPaused {
        _notify(cfg);
    }

    /// @notice Fund several runs (one per entry) in one transaction.
    function notifyRewardAmounts(RunConfig[] calldata cfgs) external nonReentrant onlyOwner whenNotPaused {
        if (cfgs.length == 0) revert ZeroAmount();
        for (uint256 i; i < cfgs.length; ++i) {
            _notify(cfgs[i]);
        }
    }

    /// @notice Send out tokens that are not staked principal, not owed to stakers and not scheduled for a
    ///         current or future run. Covers donations, stranded zero-stake emission and rounding dust.
    function recover(address token, uint256 amount, address to) external nonReentrant onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (_rewards[token].listed) _checkpoint(token);
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal < _reservedStored(token) + amount) revert Underfunded();
        emit Recovered(token, to, amount);
        IERC20(token).safeTransfer(to, amount);
    }

    // ------------------------------------------------------------------
    // Users
    // ------------------------------------------------------------------

    function stake(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        _updateAll(msg.sender);
        uint256 beforeBal = stakingToken.balanceOf(address(this));
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = stakingToken.balanceOf(address(this)) - beforeBal;
        if (received == 0) revert ZeroAmount();
        uint256 newBal = balanceOf[msg.sender] + received;
        if (newBal < minStake) revert BelowMinStake();
        totalStaked += received;
        balanceOf[msg.sender] = newBal;
        emit Staked(msg.sender, received);
    }

    /// @notice Withdraw staked principal. Never touches reward tokens. Works while paused.
    function withdraw(uint256 amount) external nonReentrant {
        _updateAll(msg.sender);
        _withdraw(msg.sender, amount);
    }

    /// @notice Last-resort exit. Returns all principal without running any reward math.
    ///         Rewards already credited in `rewards` stay claimable; only accrual since the user's last
    ///         checkpoint is forfeited (it is shared by the remaining stakers). Works while paused.
    function emergencyWithdraw() external nonReentrant {
        uint256 bal = balanceOf[msg.sender];
        if (bal == 0) revert ZeroAmount();
        balanceOf[msg.sender] = 0;
        totalStaked -= bal;
        emit EmergencyWithdrawn(msg.sender, bal);
        stakingToken.safeTransfer(msg.sender, bal);
    }

    /// @notice Claim one reward token.
    function claim(address token) external nonReentrant {
        _updateAll(msg.sender);
        _pay(msg.sender, token);
    }

    /// @notice Claim a chosen subset of reward tokens (lets users skip a token that is failing).
    function claimMany(address[] calldata tokens) external nonReentrant {
        _updateAll(msg.sender);
        for (uint256 i; i < tokens.length; ++i) {
            _pay(msg.sender, tokens[i]);
        }
    }

    /// @notice Claim every reward token. Reverts if any single token transfer reverts; use `claim` or
    ///         `claimMany` to skip it.
    function claimAll() external nonReentrant {
        _updateAll(msg.sender);
        uint256 n = _rewardTokens.length;
        for (uint256 i; i < n; ++i) {
            _pay(msg.sender, _rewardTokens[i]);
        }
    }

    /// @notice Withdraw everything and claim every reward token. Use `withdraw` if a reward token reverts.
    function exit() external nonReentrant {
        _updateAll(msg.sender);
        uint256 bal = balanceOf[msg.sender];
        if (bal > 0) _withdraw(msg.sender, bal);
        uint256 n = _rewardTokens.length;
        for (uint256 i; i < n; ++i) {
            _pay(msg.sender, _rewardTokens[i]);
        }
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function rewardTokens() external view returns (address[] memory) {
        return _rewardTokens;
    }

    function rewardTokensLength() external view returns (uint256) {
        return _rewardTokens.length;
    }

    function isRewardToken(address token) external view returns (bool) {
        return _rewards[token].listed;
    }

    function getRun(address token) external view returns (Run memory) {
        return _rewards[token].run;
    }

    /// @notice Emitted while someone was staked and not yet paid (stored value, as of the last checkpoint).
    function owedStored(address token) external view returns (uint256) {
        return _rewards[token].owed;
    }

    function runEnd(address token) external view returns (uint256) {
        Run memory r = _rewards[token].run;
        return r.amount == 0 ? 0 : uint256(r.start) + r.duration;
    }

    function rewardPerToken(address token) public view returns (uint256 rpt) {
        RewardState storage s = _rewards[token];
        rpt = s.rewardPerTokenStored;
        uint256 ts = totalStaked;
        if (ts == 0) return rpt;
        Run memory r = s.run;
        uint256 delta = _emittedAt(r, block.timestamp) - r.emitted;
        if (delta > 0) rpt += Math.mulDiv(delta, PRECISION, ts);
    }

    function earned(address account, address token) public view returns (uint256) {
        return rewards[account][token]
            + Math.mulDiv(balanceOf[account], rewardPerToken(token) - userRewardPerTokenPaid[account][token], PRECISION);
    }

    function earnedAll(address account) external view returns (address[] memory tokens, uint256[] memory amounts) {
        tokens = _rewardTokens;
        amounts = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            amounts[i] = earned(account, tokens[i]);
        }
    }

    /// @notice Instantaneous emission rate (token wei per second, rounded down) of the token's run.
    function rewardRate(address token) external view returns (uint256) {
        Run memory r = _rewards[token].run;
        if (r.amount == 0 || block.timestamp < r.start) return 0;
        uint256 x = block.timestamp - r.start;
        uint256 d = r.duration;
        if (x >= d) return 0;
        uint256 wS = r.startWeight;
        uint256 wE = r.endWeight;
        return Math.mulDiv(r.amount, 2 * (wS * (d - x) + wE * x), d * d * (wS + wE));
    }

    /// @notice Amount of `token` the contract must keep: owed + not-yet-emitted (+ principal for the stake token).
    function reserved(address token) public view returns (uint256 amount) {
        RewardState storage s = _rewards[token];
        if (s.listed) {
            Run memory r = s.run;
            uint256 nowE = _emittedAt(r, block.timestamp);
            uint256 owed = s.owed;
            // Emission since the last checkpoint is owed only if someone is staked; otherwise it is surplus.
            if (totalStaked > 0) owed += nowE - r.emitted;
            amount = owed + (uint256(r.amount) - nowE);
        }
        if (token == address(stakingToken)) amount += totalStaked;
    }

    /// @notice Amount the owner may `recover` right now.
    function recoverable(address token) external view returns (uint256) {
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 res = reserved(token);
        return bal > res ? bal - res : 0;
    }

    /// @notice The curve's cumulative emission after `elapsed` seconds (exposed for UIs and tests).
    function curveEmitted(uint256 amount, uint256 duration, uint256 startWeight, uint256 endWeight, uint256 elapsed)
        public
        pure
        returns (uint256)
    {
        if (amount == 0 || elapsed == 0) return 0;
        if (elapsed >= duration) return amount;
        uint256 num = startWeight * elapsed * (2 * duration - elapsed) + endWeight * elapsed * elapsed;
        uint256 den = duration * duration * (startWeight + endWeight);
        return Math.mulDiv(amount, num, den);
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    function _addRewardToken(address token) internal {
        if (token == address(0)) revert ZeroAddress();
        if (token.code.length == 0) revert NotContract();
        RewardState storage s = _rewards[token];
        if (s.listed) revert AlreadyListed();
        if (_rewardTokens.length >= MAX_REWARD_TOKENS) revert TooManyRewardTokens();
        s.listed = true;
        _rewardTokens.push(token);
        emit RewardTokenAdded(token);
    }

    function _notify(RunConfig calldata cfg) internal {
        RewardState storage s = _rewards[cfg.token];
        if (!s.listed) revert NotListed();
        if (cfg.amount == 0) revert ZeroAmount();
        if (cfg.duration < MIN_DURATION || cfg.duration > MAX_DURATION) revert BadDuration();
        if (cfg.startWeight > MAX_WEIGHT || cfg.endWeight > MAX_WEIGHT) revert BadWeights();
        if (uint256(cfg.startWeight) + cfg.endWeight == 0) revert BadWeights();
        uint256 start = cfg.startTime == 0 ? block.timestamp : cfg.startTime;
        if (start < block.timestamp || start > block.timestamp + MAX_START_DELAY) revert BadStart();

        // Settle everything emitted so far into rewardPerToken / owed before the schedule changes.
        _checkpoint(cfg.token);

        IERC20 token = IERC20(cfg.token);
        uint256 beforeBal = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), cfg.amount);
        uint256 afterBal = token.balanceOf(address(this));
        if (afterBal <= beforeBal) revert ZeroAmount();
        uint256 received = afterBal - beforeBal;

        Run memory old = s.run;
        uint256 rolledOver = uint256(old.amount) - old.emitted;
        // A delayed start may not pause emission of an existing remainder (owner cannot freeze a live run).
        if (rolledOver != 0 && start != block.timestamp) revert BadStart();
        uint256 total = rolledOver + received;
        if (total > MAX_RUN_AMOUNT) revert AmountTooLarge();

        // Casts are safe: total <= MAX_RUN_AMOUNT (uint128), start <= now + 30 days, duration is uint64.
        s.run = Run({
            // forge-lint: disable-next-line(unsafe-typecast)
            amount: uint128(total),
            emitted: 0,
            // forge-lint: disable-next-line(unsafe-typecast)
            start: uint64(start),
            duration: cfg.duration,
            startWeight: cfg.startWeight,
            endWeight: cfg.endWeight
        });

        if (afterBal < _reservedStored(cfg.token)) revert Underfunded();
        emit RunStarted(cfg.token, received, rolledOver, total, start, cfg.duration, cfg.startWeight, cfg.endWeight);
    }

    /// @dev Reserved amount using stored values. Only valid right after `_checkpoint(token)`.
    function _reservedStored(address token) internal view returns (uint256 amount) {
        RewardState storage s = _rewards[token];
        if (s.listed) amount = s.owed + (uint256(s.run.amount) - s.run.emitted);
        if (token == address(stakingToken)) amount += totalStaked;
    }

    /// @dev Settle emission since the last checkpoint. Pure accounting: no external calls, cannot revert
    ///      (amounts are bounded by MAX_RUN_AMOUNT, so `delta * PRECISION` fits in 256 bits).
    function _checkpoint(address token) internal returns (uint256 rpt) {
        RewardState storage s = _rewards[token];
        rpt = s.rewardPerTokenStored;
        Run memory r = s.run;
        uint256 nowE = _emittedAt(r, block.timestamp);
        uint256 delta = nowE - r.emitted;
        if (delta == 0) return rpt;
        // nowE <= run.amount <= MAX_RUN_AMOUNT, so the cast is lossless.
        // forge-lint: disable-next-line(unsafe-typecast)
        s.run.emitted = uint128(nowE);
        uint256 ts = totalStaked;
        if (ts > 0) {
            rpt += Math.mulDiv(delta, PRECISION, ts);
            s.rewardPerTokenStored = rpt;
            s.owed += delta;
        }
        // ts == 0: nobody earns it. It leaves `reserved` and becomes recoverable surplus.
    }

    function _updateAll(address account) internal {
        uint256 n = _rewardTokens.length;
        uint256 bal = balanceOf[account];
        for (uint256 i; i < n; ++i) {
            address token = _rewardTokens[i];
            uint256 rpt = _checkpoint(token);
            if (account != address(0)) {
                uint256 paid = userRewardPerTokenPaid[account][token];
                if (rpt != paid) {
                    if (bal > 0) rewards[account][token] += Math.mulDiv(bal, rpt - paid, PRECISION);
                    userRewardPerTokenPaid[account][token] = rpt;
                }
            }
        }
    }

    function _emittedAt(Run memory r, uint256 ts) internal pure returns (uint256) {
        if (ts <= r.start) return 0;
        return curveEmitted(r.amount, r.duration, r.startWeight, r.endWeight, ts - r.start);
    }

    function _withdraw(address account, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balanceOf[account];
        if (bal < amount) revert InsufficientBalance();
        uint256 left = bal - amount;
        if (left != 0 && left < minStake) revert BelowMinStake();
        balanceOf[account] = left;
        totalStaked -= amount;
        emit Withdrawn(account, amount);
        stakingToken.safeTransfer(account, amount);
    }

    function _pay(address account, address token) internal {
        uint256 amount = rewards[account][token];
        if (amount == 0) return;
        rewards[account][token] = 0;
        _rewards[token].owed -= amount;
        emit RewardPaid(account, token, amount);
        IERC20(token).safeTransfer(account, amount);
    }
}
