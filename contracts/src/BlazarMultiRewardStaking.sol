// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ISignatureTransfer} from "./interfaces/ISignatureTransfer.sol";

/// @title BlazarMultiRewardStaking
/// @notice Stake one immutable token (BZB). Earn up to `MAX_REWARD_TOKENS` ERC20 reward tokens.
///
///         RUNS. Every funding call (`notifyRewardAmount`) creates a NEW, independent run for one reward token
///         with its own amount, start, duration and emission curve. A run is never modified after it is
///         created: top-ups do not touch existing runs. Each token can have up to `MAX_RUNS_PER_TOKEN`
///         unfinished runs at once (overlapping or scheduled). A run that has fully emitted is settled and
///         its slot is freed, so the per-token loop is bounded at 5 runs.
///
///         CURVE. Per run, rate ∝ w(x) = startWeight + (endWeight - startWeight)·x/D (weights 0..10_000, not
///         both zero). Cumulative emission after x seconds is the exact closed-form integral
///             E(x) = amount·(startWeight·x·(2D − x) + endWeight·x²) / (D²·(startWeight + endWeight))
///         rounded down. E(0)=0, E(D)=amount exactly, E non-decreasing, so per-run checkpoint deltas
///         telescope to exactly `amount`; a run can never emit more than it was funded with.
///
///         ACCOUNTING. Each checkpoint sums the deltas of all of a token's runs and adds them to one
///         reward-per-token accumulator for that token (1e36 scale). Every staker shares every run pro rata to
///         stake, so per-token aggregation gives each user exactly what per-run accounting would, with bounded
///         gas. Users claim per token (`claim`, `claimMany`, `claimAll`); per-run views exist for UIs.
///         Per token:
///             owed     = emitted while someone was staked − paid out (covers every user's credit)
///             unemitted = Σ over unfinished runs (amount − emitted)
///             reserved = owed + unemitted (+ totalStaked if the token is the staking token)
///         Funding checks `balance >= reserved`. `recover` can only move `balance − reserved`.
///         Emission while nobody is staked is credited to nobody and becomes recoverable surplus.
///
///         PRINCIPAL. Staked principal (`totalStaked`) is never usable by any owner function: `recover` of the
///         staking token is limited to `balance − (totalStaked + owed + unemitted)`; `notify` only adds
///         tokens; `pause` only blocks `stake` and `notify`. `withdraw` and `emergencyWithdraw` have no owner
///         gate, no pause gate, and never call a reward token. No upgradeability, no delegatecall, no
///         selfdestruct, staking token is immutable.
///
///         Unsupported: rebasing / balance-reducing tokens (owner must vet reward tokens). Fee-on-transfer
///         funding and staking are credited with the measured balance delta.
///
///         ENTRY POINTS FOR BOTS AND INTEGRATORS. `stakeFor` (payer funds, beneficiary owns),
///         `stakeWithPermit2` (one Permit2 signature, relayable; the signer is always the beneficiary),
///         `compound` (own owed BZB rewards into own stake, no transfer), `claimAllSkipping` / `exitSkipping`
///         (a reward token whose transfer fails is skipped and stays credited), and the views `totalSupply`,
///         `getPosition`, `rewardsEnd`, `emissionBetween`. Every one of these can only ADD to a position;
///         only the account itself can ever reduce its own balance (`withdraw`, `emergencyWithdraw`, `exit*`).
///
///         STAKING-TOKEN TRUST. BZB on Polygon is an upgradeable PoS-bridge proxy controlled by Polygon's
///         multisig, not by this contract's owner. A future BZB implementation with sender-side fees,
///         rebasing or blacklisting could make withdrawals fail; this contract cannot defend against that.
contract BlazarMultiRewardStaking is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_REWARD_TOKENS = 5;
    uint256 public constant MAX_RUNS_PER_TOKEN = 5;
    /// @dev SAFETY BOUND (RV-04): together with MAX_RUN_AMOUNT and MIN_STAKE_FLOOR this bounds checkpoint math
    ///      that runs on the withdraw/emergencyWithdraw path. Changing it requires re-proving exits cannot revert.
    uint256 public constant MIN_DURATION = 1 days;
    uint256 public constant MAX_DURATION = 365 days;
    uint256 public constant MAX_START_DELAY = 30 days;
    uint256 public constant MAX_WEIGHT = 10_000;
    /// @dev SAFETY BOUND (RV-04): changing this requires re-proving that `_checkpoint` (run on every exit)
    ///      cannot overflow or revert.
    /// @notice Upper bound on one run's amount. With `minStake`, keeps the accumulator far from overflow.
    uint256 public constant MAX_RUN_AMOUNT = type(uint128).max;
    uint256 public constant PRECISION = 1e36;
    /// @dev SAFETY BOUND (RV-04): lowering this requires re-proving the reward-per-token accumulator cannot
    ///      overflow, i.e. that withdraw/emergencyWithdraw cannot revert.
    /// @notice Constructor floor for `minStake` (0.001 of an 18-decimal stake token). Keeps the per-checkpoint
    ///         accumulator increment <= 5·2^128·1e36/1e15 ≈ 2^201, so overflow is unreachable.
    uint256 public constant MIN_STAKE_FLOOR = 1e15;
    /// @notice Gas forwarded to each guarded reward transfer in `claimAllSkipping` / `exitSkipping`.
    ///         A token that needs more (or reverts, or burns it) is skipped and stays credited.
    uint256 public constant SKIP_PAY_GAS = 200_000;
    /// @dev Gas the caller must still hold after forwarding SKIP_PAY_GAS (covers CALL overhead and the
    ///      1/64 kept by EIP-150), so a skip is never caused by the caller sending too little gas.
    uint256 internal constant SKIP_GAS_OVERHEAD = 10_000;
    /// @notice Canonical Uniswap Permit2 (same address on Polygon PoS and every other chain). Not settable.
    ISignatureTransfer public constant PERMIT2 = ISignatureTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    struct Run {
        uint128 amount; // 0 = empty slot
        uint128 emitted; // E(elapsed) at the last checkpoint
        uint64 start;
        uint64 duration;
        uint16 startWeight;
        uint16 endWeight;
        uint64 id; // per-token sequential id, starts at 1
    }

    struct RewardState {
        bool listed;
        uint64 nextRunId;
        uint64 latestEnd; // max(start + duration) over every run ever created for this token
        uint256 rewardPerTokenStored;
        uint256 owed;
        Run[MAX_RUNS_PER_TOKEN] runs;
    }

    struct RunConfig {
        address token;
        uint256 amount; // requested transfer; the run is credited with what actually arrives
        uint64 duration;
        uint64 startTime; // 0 = now; otherwise now <= startTime <= now + MAX_START_DELAY
        uint16 startWeight;
        uint16 endWeight;
    }

    struct RunView {
        uint256 slot;
        uint256 id;
        uint256 amount;
        uint256 emittedNow; // emitted by this run as of now (stored + pending)
        uint256 start;
        uint256 end;
        uint256 startWeight;
        uint256 endWeight;
        uint256 ratePerSecond; // instantaneous, rounded down
    }

    /// @notice Everything a bot needs about one account in one call (see `getPosition`).
    struct Position {
        uint256 staked; // balanceOf(account)
        uint256 totalStaked;
        uint256 minStake;
        bool paused; // true: stake/stakeFor/stakeWithPermit2/compound and new runs are blocked; exits never are
        uint256 timestamp; // block.timestamp the numbers are valid for
        address[] tokens; // listed reward tokens, in listing order
        uint256[] earned; // earned(account, token) for each token
        uint256[] ratePerSecond; // rewardRate(token): total emission per second across all runs, now
        uint256[] rewardsEnd; // rewardsEnd(token)
    }

    IERC20 public immutable stakingToken;
    /// @notice Every position is 0 or >= minStake, so totalStaked is 0 or >= minStake. Bounds the
    ///         accumulator increment per checkpoint (<= 5·MAX_RUN_AMOUNT·PRECISION / minStake).
    uint256 public immutable minStake;

    uint256 public totalStaked;
    mapping(address => uint256) public balanceOf;

    address[] internal _rewardTokens;
    mapping(address => RewardState) internal _rewards;
    mapping(address => mapping(address => uint256)) public userRewardPerTokenPaid; // user => token => rpt
    mapping(address => mapping(address => uint256)) public rewards; // user => token => credited, unpaid

    /// @dev `payer` is who funded it: the user for `stake`/`stakeWithPermit2`, the caller for `stakeFor`,
    ///      and this contract for `compound`. `balanceAfter`/`totalStakedAfter` let indexers rebuild
    ///      positions from events alone.
    event Staked(
        address indexed user, address indexed payer, uint256 amount, uint256 balanceAfter, uint256 totalStakedAfter
    );
    event Withdrawn(address indexed user, uint256 amount, uint256 balanceAfter, uint256 totalStakedAfter);
    event EmergencyWithdrawn(address indexed user, uint256 amount, uint256 balanceAfter, uint256 totalStakedAfter);
    /// @notice `amount` of the user's owed BZB rewards moved into their stake (also emits `Staked`).
    event Compounded(address indexed user, uint256 amount);
    /// @notice A guarded reward transfer failed in a skipping exit; `amount` stays credited to `user`.
    event RewardSkipped(address indexed user, address indexed token, uint256 amount);
    event RewardPaid(address indexed user, address indexed token, address indexed to, uint256 amount);
    event RewardTokenAdded(address indexed token);
    event RunStarted(
        address indexed token,
        uint256 indexed runId,
        uint256 slot,
        uint256 amount,
        uint256 start,
        uint256 duration,
        uint16 startWeight,
        uint16 endWeight
    );
    event RunFinished(address indexed token, uint256 indexed runId, uint256 slot);
    event Recovered(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error NotContract();
    error AlreadyListed();
    error NotListed();
    error TooManyRewardTokens();
    error TooManyRuns();
    error BadDuration();
    error BadWeights();
    error BadStart();
    error AmountTooLarge();
    error InsufficientBalance();
    error Underfunded();
    error RenounceDisabled();
    error BelowMinStake();
    error CannotListSelf();
    error WrongToken();
    error BadWindow();
    error OnlySelf();
    error InsufficientGas();

    constructor(address initialOwner, address stakingToken_, uint256 minStake_) Ownable(initialOwner) {
        if (stakingToken_ == address(0)) revert ZeroAddress();
        if (stakingToken_.code.length == 0) revert NotContract();
        if (minStake_ < MIN_STAKE_FLOOR) revert BelowMinStake();
        stakingToken = IERC20(stakingToken_);
        minStake = minStake_;
    }

    // ------------------------------------------------------------------
    // Owner
    // ------------------------------------------------------------------

    /// @notice Disabled. Ownership moves only by the two-step transfer (e.g. to a Safe).
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /// @notice Pauses `stake` and new runs only. Withdraw, emergencyWithdraw and claims stay open.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice List a reward token. Permanent (no removal). Capped at MAX_REWARD_TOKENS.
    function addRewardToken(address token) external onlyOwner {
        _addRewardToken(token);
    }

    function addRewardTokens(address[] calldata tokens) external onlyOwner {
        for (uint256 i; i < tokens.length; ++i) {
            _addRewardToken(tokens[i]);
        }
    }

    /// @notice Create a new independent run. Existing runs are never changed.
    function notifyRewardAmount(RunConfig calldata cfg) external nonReentrant onlyOwner whenNotPaused {
        _notify(cfg);
    }

    /// @notice Create several new runs (one per entry) in one transaction.
    function notifyRewardAmounts(RunConfig[] calldata cfgs) external nonReentrant onlyOwner whenNotPaused {
        if (cfgs.length == 0) revert ZeroAmount();
        for (uint256 i; i < cfgs.length; ++i) {
            _notify(cfgs[i]);
        }
    }

    /// @notice Move tokens that are not principal, not owed, and not scheduled in any unfinished run.
    ///         For the staking token this is strictly `balance − (totalStaked + owed + unemitted)`.
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
        uint256 received = _pullStake(msg.sender, amount);
        _credit(msg.sender, msg.sender, received, false);
    }

    /// @notice Stake `amount` from msg.sender into `beneficiary`'s position (zaps, vaults, payroll bots).
    ///         Only `beneficiary` can ever withdraw it. A deposit for someone else must be >= minStake, so it
    ///         can never leave a sub-minStake remainder that would make the beneficiary's own partial
    ///         `withdraw` revert (front-run griefing). Same pause and minStake rules as `stake`.
    function stakeFor(address beneficiary, uint256 amount) external nonReentrant whenNotPaused {
        if (beneficiary == address(0) || beneficiary == address(this)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _updateAll(beneficiary);
        uint256 received = _pullStake(msg.sender, amount);
        _credit(beneficiary, msg.sender, received, beneficiary != msg.sender);
    }

    /// @notice Stake with one Permit2 SignatureTransfer signature instead of an approve tx to this contract.
    ///         Needs a one-time `BZB.approve(PERMIT2, ...)` by `owner_` (or gasless via BZB's
    ///         `executeMetaTransaction`). Anyone may submit the signature (relayers, agents); the signer
    ///         `owner_` is always the beneficiary, and exactly `permit.permitted.amount` is staked, so a relayer
    ///         can neither redirect nor shrink the deposit. Relayed deposits must be >= minStake.
    function stakeWithPermit2(
        address owner_,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        if (owner_ == address(0)) revert ZeroAddress();
        if (permit.permitted.token != address(stakingToken)) revert WrongToken();
        uint256 amount = permit.permitted.amount;
        if (amount == 0) revert ZeroAmount();
        _updateAll(owner_);
        uint256 beforeBal = stakingToken.balanceOf(address(this));
        PERMIT2.permitTransferFrom(
            permit,
            ISignatureTransfer.SignatureTransferDetails({to: address(this), requestedAmount: amount}),
            owner_,
            signature
        );
        uint256 received = stakingToken.balanceOf(address(this)) - beforeBal;
        if (received == 0) revert ZeroAmount();
        _credit(owner_, owner_, received, msg.sender != owner_);
    }

    /// @notice Move all of the caller's owed BZB rewards into the caller's stake. No token transfer:
    ///         `owed` falls and `totalStaked` rises by the same amount, so `reserved(BZB)` is unchanged.
    ///         Own position only (no keeper path). Requires BZB to be a listed reward token. Blocked by
    ///         pause like `stake`; `claim(BZB)` stays available while paused.
    function compound() external nonReentrant whenNotPaused returns (uint256 amount) {
        address bzb = address(stakingToken);
        RewardState storage st = _rewards[bzb];
        if (!st.listed) revert NotListed();
        _updateAll(msg.sender);
        amount = rewards[msg.sender][bzb];
        if (amount == 0) revert ZeroAmount();
        rewards[msg.sender][bzb] = 0;
        st.owed -= amount;
        emit Compounded(msg.sender, amount);
        _credit(msg.sender, address(this), amount, false);
    }

    /// @notice Withdraw principal. No owner/pause gate; never calls a reward token.
    function withdraw(uint256 amount) external nonReentrant {
        _updateAll(msg.sender);
        _withdraw(msg.sender, amount);
    }

    /// @notice Last-resort exit: all principal back, never calling any reward token. Settles every listed
    ///         token first (pure storage math via `_updateAll`, no external calls, cannot revert under the
    ///         documented bounds), so the user keeps their full share up to this block; it stays claimable.
    ///         Differs from `withdraw` only in always taking the full balance and skipping the min-stake check.
    function emergencyWithdraw() external nonReentrant {
        uint256 bal = balanceOf[msg.sender];
        if (bal == 0) revert ZeroAmount();
        _updateAll(msg.sender);
        balanceOf[msg.sender] = 0;
        uint256 newTotal = totalStaked - bal;
        totalStaked = newTotal;
        emit EmergencyWithdrawn(msg.sender, bal, 0, newTotal);
        stakingToken.safeTransfer(msg.sender, bal);
    }

    /// @notice Settle the given reward tokens (globally and for the caller) without transferring anything.
    ///         Unlisted entries are ignored. Lets anyone checkpoint even if a token's transfers are failing.
    function checkpoint(address[] calldata tokens) external nonReentrant {
        for (uint256 i; i < tokens.length; ++i) {
            _updateOne(msg.sender, tokens[i]);
        }
    }

    /// @notice Claim one token. Settles only that token (balance is unchanged, so other tokens' accounting
    ///         stays exact and they are settled whenever they are next touched).
    function claim(address token) external nonReentrant {
        _updateOne(msg.sender, token);
        _pay(msg.sender, token, msg.sender);
    }

    /// @notice Claim one token to another address (e.g. if the caller is blacklisted by that token).
    function claimTo(address token, address to) external nonReentrant {
        if (to == address(0) || to == address(this)) revert ZeroAddress();
        _updateOne(msg.sender, token);
        _pay(msg.sender, token, to);
    }

    /// @notice Claim a chosen subset (lets users skip a failing token).
    function claimMany(address[] calldata tokens) external nonReentrant {
        for (uint256 i; i < tokens.length; ++i) {
            _updateOne(msg.sender, tokens[i]);
            _pay(msg.sender, tokens[i], msg.sender);
        }
    }

    /// @notice Claim a chosen subset to another address.
    function claimManyTo(address[] calldata tokens, address to) external nonReentrant {
        if (to == address(0) || to == address(this)) revert ZeroAddress();
        for (uint256 i; i < tokens.length; ++i) {
            _updateOne(msg.sender, tokens[i]);
            _pay(msg.sender, tokens[i], to);
        }
    }

    /// @notice Claim every token. Reverts if any one token transfer reverts; use `claim`/`claimMany`.
    function claimAll() external nonReentrant {
        _updateAll(msg.sender);
        uint256 n = _rewardTokens.length;
        for (uint256 i; i < n; ++i) {
            _pay(msg.sender, _rewardTokens[i], msg.sender);
        }
    }

    /// @notice Withdraw everything and claim every token. Use `withdraw` if a reward token reverts.
    function exit() external nonReentrant {
        _updateAll(msg.sender);
        uint256 bal = balanceOf[msg.sender];
        if (bal > 0) _withdraw(msg.sender, bal);
        uint256 n = _rewardTokens.length;
        for (uint256 i; i < n; ++i) {
            _pay(msg.sender, _rewardTokens[i], msg.sender);
        }
    }

    /// @notice Like `claimAll`, but a reward token whose transfer reverts, returns false, or needs more than
    ///         SKIP_PAY_GAS is skipped: its amount stays credited (claim it later) and `RewardSkipped` is
    ///         emitted. Returns the skipped tokens. Reverts `InsufficientGas` rather than skipping if the
    ///         caller did not send enough gas for a full try.
    function claimAllSkipping() external nonReentrant returns (address[] memory skipped) {
        _updateAll(msg.sender);
        skipped = _payAllSkipping(msg.sender);
    }

    /// @notice Like `exit`, but reward tokens are paid as in `claimAllSkipping`. Principal is withdrawn first
    ///         and only touches the staking token, so no reward token can block it.
    function exitSkipping() external nonReentrant returns (address[] memory skipped) {
        _updateAll(msg.sender);
        uint256 bal = balanceOf[msg.sender];
        if (bal > 0) _withdraw(msg.sender, bal);
        skipped = _payAllSkipping(msg.sender);
    }

    /// @notice Internal hook for the skipping exits; callable only by this contract (via CALL, never
    ///         delegatecall). Runs in its own gas-capped frame so a failing token rolls back only this payment.
    function payRewardSelf(address account, address token) external {
        if (msg.sender != address(this)) revert OnlySelf();
        _pay(account, token, account);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice Synthetix-style alias of `totalStaked` for generic TVL readers.
    function totalSupply() external view returns (uint256) {
        return totalStaked;
    }

    /// @notice One-call snapshot of `account` (stake, global state, and per-token earned/rate/end).
    function getPosition(address account) external view returns (Position memory p) {
        p.staked = balanceOf[account];
        p.totalStaked = totalStaked;
        p.minStake = minStake;
        p.paused = paused();
        p.timestamp = block.timestamp;
        address[] memory toks = _rewardTokens;
        uint256 n = toks.length;
        p.tokens = toks;
        p.earned = new uint256[](n);
        p.ratePerSecond = new uint256[](n);
        p.rewardsEnd = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            p.earned[i] = earned(account, toks[i]);
            p.ratePerSecond[i] = rewardRate(toks[i]);
            p.rewardsEnd[i] = _rewards[toks[i]].latestEnd;
        }
    }

    /// @notice Latest end time of any run ever created for `token` (0 if none). Rewards for `token` stop
    ///         at this time unless a new run is added. If it is <= block.timestamp, nothing is emitting.
    function rewardsEnd(address token) external view returns (uint256) {
        return _rewards[token].latestEnd;
    }

    /// @notice Total emission of `token` scheduled in [t0, t1] by the runs still stored (every unfinished
    ///         run), using the same exact curve math as accrual. Runs that finished and were pruned at a
    ///         checkpoint are not included, so use it for windows starting now or later (APR forecasts).
    ///         Gross emission: it goes to stakers pro rata, and to nobody while totalStaked == 0.
    function emissionBetween(address token, uint256 t0, uint256 t1) external view returns (uint256 total) {
        if (t0 > t1) revert BadWindow();
        RewardState storage s = _rewards[token];
        for (uint256 i; i < MAX_RUNS_PER_TOKEN; ++i) {
            Run memory r = s.runs[i];
            if (r.amount != 0) total += _emittedAt(r, t1) - _emittedAt(r, t0);
        }
    }

    function rewardTokens() external view returns (address[] memory) {
        return _rewardTokens;
    }

    function rewardTokensLength() external view returns (uint256) {
        return _rewardTokens.length;
    }

    function isRewardToken(address token) external view returns (bool) {
        return _rewards[token].listed;
    }

    /// @notice Raw stored run in `slot` (amount == 0 means empty).
    function getRun(address token, uint256 slot) external view returns (Run memory) {
        return _rewards[token].runs[slot];
    }

    /// @notice Unfinished runs of a token with live numbers. Finished-but-not-yet-pruned runs are omitted.
    function getRuns(address token) external view returns (RunView[] memory out) {
        RewardState storage s = _rewards[token];
        uint256 n = 0;
        RunView[MAX_RUNS_PER_TOKEN] memory tmp; // zero-initialised scratch, only the first n entries are used
        for (uint256 i; i < MAX_RUNS_PER_TOKEN; ++i) {
            Run memory r = s.runs[i];
            if (r.amount == 0 || _finishedAt(r, block.timestamp)) continue;
            tmp[n++] = RunView({
                slot: i,
                id: r.id,
                amount: r.amount,
                emittedNow: _emittedAt(r, block.timestamp),
                start: r.start,
                end: uint256(r.start) + r.duration,
                startWeight: r.startWeight,
                endWeight: r.endWeight,
                ratePerSecond: _rateAt(r, block.timestamp)
            });
        }
        out = new RunView[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = tmp[i];
        }
    }

    /// @notice Number of unfinished runs (the ones that occupy a slot for a new notify).
    function activeRunCount(address token) public view returns (uint256 n) {
        RewardState storage s = _rewards[token];
        for (uint256 i; i < MAX_RUNS_PER_TOKEN; ++i) {
            Run memory r = s.runs[i];
            if (r.amount != 0 && !_finishedAt(r, block.timestamp)) ++n;
        }
    }

    function owedStored(address token) external view returns (uint256) {
        return _rewards[token].owed;
    }

    /// @notice Σ (amount − E(now)) over the token's runs: scheduled but not yet emitted.
    function unemitted(address token) public view returns (uint256 total) {
        RewardState storage s = _rewards[token];
        for (uint256 i; i < MAX_RUNS_PER_TOKEN; ++i) {
            Run memory r = s.runs[i];
            if (r.amount != 0) total += uint256(r.amount) - _emittedAt(r, block.timestamp);
        }
    }

    function rewardPerToken(address token) public view returns (uint256 rpt) {
        RewardState storage s = _rewards[token];
        rpt = s.rewardPerTokenStored;
        uint256 ts = totalStaked;
        if (ts == 0) return rpt;
        uint256 delta = _pendingDelta(s);
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

    /// @notice Sum of instantaneous rates of all runs of `token` (wei per second, rounded down per run).
    function rewardRate(address token) public view returns (uint256 rate) {
        RewardState storage s = _rewards[token];
        for (uint256 i; i < MAX_RUNS_PER_TOKEN; ++i) {
            Run memory r = s.runs[i];
            if (r.amount != 0) rate += _rateAt(r, block.timestamp);
        }
    }

    /// @notice What the contract must keep of `token`: owed + unemitted (+ totalStaked for the stake token).
    function reserved(address token) public view returns (uint256 amount) {
        RewardState storage s = _rewards[token];
        if (s.listed) {
            uint256 owed = s.owed;
            // Pending emission is owed only if someone is staked; otherwise it is surplus.
            if (totalStaked > 0) owed += _pendingDelta(s);
            amount = owed + unemitted(token);
        }
        if (token == address(stakingToken)) amount += totalStaked;
    }

    function recoverable(address token) external view returns (uint256) {
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 res = reserved(token);
        return bal > res ? bal - res : 0;
    }

    /// @notice A run's cumulative emission after `elapsed` seconds (for UIs and tests).
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
        if (token == address(this)) revert CannotListSelf();
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

        // Settle all existing runs (and free finished slots). Existing schedules are not modified.
        _checkpoint(cfg.token);
        uint256 slot = MAX_RUNS_PER_TOKEN;
        for (uint256 i; i < MAX_RUNS_PER_TOKEN; ++i) {
            if (s.runs[i].amount == 0) {
                slot = i;
                break;
            }
        }
        if (slot == MAX_RUNS_PER_TOKEN) revert TooManyRuns();

        IERC20 token = IERC20(cfg.token);
        uint256 beforeBal = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), cfg.amount);
        uint256 afterBal = token.balanceOf(address(this));
        if (afterBal <= beforeBal) revert ZeroAmount();
        uint256 received = afterBal - beforeBal;
        if (received > MAX_RUN_AMOUNT) revert AmountTooLarge();

        uint64 id = ++s.nextRunId;
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 end = uint64(start) + cfg.duration; // <= now + 30 days + 365 days, no overflow
        if (end > s.latestEnd) s.latestEnd = end;
        // Casts are safe: received <= MAX_RUN_AMOUNT (uint128), start <= now + 30 days.
        s.runs[slot] = Run({
            // forge-lint: disable-next-line(unsafe-typecast)
            amount: uint128(received),
            emitted: 0,
            // forge-lint: disable-next-line(unsafe-typecast)
            start: uint64(start),
            duration: cfg.duration,
            startWeight: cfg.startWeight,
            endWeight: cfg.endWeight,
            id: id
        });

        if (afterBal < _reservedStored(cfg.token)) revert Underfunded();
        emit RunStarted(cfg.token, id, slot, received, start, cfg.duration, cfg.startWeight, cfg.endWeight);
    }

    /// @dev Reserved using stored values. Only valid right after `_checkpoint(token)`.
    function _reservedStored(address token) internal view returns (uint256 amount) {
        RewardState storage s = _rewards[token];
        if (s.listed) {
            amount = s.owed;
            for (uint256 i; i < MAX_RUNS_PER_TOKEN; ++i) {
                Run storage r = s.runs[i];
                amount += uint256(r.amount) - r.emitted;
            }
        }
        if (token == address(stakingToken)) amount += totalStaked;
    }

    /// @dev Emission of all runs since their last checkpoint.
    function _pendingDelta(RewardState storage s) internal view returns (uint256 delta) {
        for (uint256 i; i < MAX_RUNS_PER_TOKEN; ++i) {
            Run memory r = s.runs[i];
            if (r.amount != 0) delta += _emittedAt(r, block.timestamp) - r.emitted;
        }
    }

    /// @dev Settle all runs of `token`. Pure accounting: no external calls, cannot revert
    ///      (≤ 5 runs × MAX_RUN_AMOUNT per call, totalStaked is 0 or ≥ minStake). Frees finished slots.
    function _checkpoint(address token) internal returns (uint256 rpt) {
        RewardState storage s = _rewards[token];
        rpt = s.rewardPerTokenStored;
        uint256 delta = 0;
        for (uint256 i; i < MAX_RUNS_PER_TOKEN; ++i) {
            Run storage sr = s.runs[i];
            uint256 amount = sr.amount;
            if (amount == 0) continue;
            Run memory r = sr;
            uint256 nowE = _emittedAt(r, block.timestamp);
            uint256 d = nowE - r.emitted;
            if (nowE == amount) {
                // Fully emitted: its last delta is counted below; free the slot.
                emit RunFinished(token, r.id, i);
                delete s.runs[i];
            } else if (d != 0) {
                // nowE < amount <= MAX_RUN_AMOUNT, so the cast is lossless.
                // forge-lint: disable-next-line(unsafe-typecast)
                sr.emitted = uint128(nowE);
            }
            delta += d;
        }
        if (delta == 0) return rpt;
        uint256 ts = totalStaked;
        if (ts > 0) {
            rpt += Math.mulDiv(delta, PRECISION, ts);
            s.rewardPerTokenStored = rpt;
            s.owed += delta;
        }
        // ts == 0: nobody earns it; it leaves `reserved` and becomes recoverable surplus.
    }

    /// @dev Must run before any change to `balanceOf[account]` (stake/withdraw/exit).
    function _updateAll(address account) internal {
        uint256 n = _rewardTokens.length;
        uint256 bal = balanceOf[account];
        for (uint256 i; i < n; ++i) {
            _settleUser(account, _rewardTokens[i], bal);
        }
    }

    /// @dev Settle one token for one user. Valid only when the user's balance is not about to change.
    function _updateOne(address account, address token) internal {
        if (!_rewards[token].listed) return;
        _settleUser(account, token, balanceOf[account]);
    }

    function _settleUser(address account, address token, uint256 bal) internal {
        uint256 rpt = _checkpoint(token);
        uint256 paid = userRewardPerTokenPaid[account][token];
        if (rpt != paid) {
            if (bal > 0) rewards[account][token] += Math.mulDiv(bal, rpt - paid, PRECISION);
            userRewardPerTokenPaid[account][token] = rpt;
        }
    }

    function _emittedAt(Run memory r, uint256 ts) internal pure returns (uint256) {
        if (ts <= r.start) return 0;
        return curveEmitted(r.amount, r.duration, r.startWeight, r.endWeight, ts - r.start);
    }

    function _finishedAt(Run memory r, uint256 ts) internal pure returns (bool) {
        return ts >= uint256(r.start) + r.duration;
    }

    function _rateAt(Run memory r, uint256 ts) internal pure returns (uint256) {
        if (r.amount == 0 || ts < r.start) return 0;
        uint256 x = ts - r.start;
        uint256 d = r.duration;
        if (x >= d) return 0;
        uint256 wS = r.startWeight;
        uint256 wE = r.endWeight;
        return Math.mulDiv(r.amount, 2 * (wS * (d - x) + wE * x), d * d * (wS + wE));
    }

    function _withdraw(address account, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balanceOf[account];
        if (bal < amount) revert InsufficientBalance();
        uint256 left = bal - amount;
        if (left != 0 && left < minStake) revert BelowMinStake();
        balanceOf[account] = left;
        uint256 newTotal = totalStaked - amount;
        totalStaked = newTotal;
        emit Withdrawn(account, amount, left, newTotal);
        stakingToken.safeTransfer(account, amount);
    }

    /// @dev Pull `amount` of the staking token from `payer`; returns what actually arrived.
    function _pullStake(address payer, uint256 amount) internal returns (uint256 received) {
        uint256 beforeBal = stakingToken.balanceOf(address(this));
        stakingToken.safeTransferFrom(payer, address(this), amount);
        received = stakingToken.balanceOf(address(this)) - beforeBal;
        if (received == 0) revert ZeroAmount();
    }

    /// @dev Add `amount` to `account`'s position. Callers must run `_updateAll(account)` first.
    ///      `thirdParty`: deposit initiated by someone other than `account`; must be >= minStake.
    function _credit(address account, address payer, uint256 amount, bool thirdParty) internal {
        if (thirdParty && amount < minStake) revert BelowMinStake();
        uint256 newBal = balanceOf[account] + amount;
        if (newBal < minStake) revert BelowMinStake();
        uint256 newTotal = totalStaked + amount;
        totalStaked = newTotal;
        balanceOf[account] = newBal;
        emit Staked(account, payer, amount, newBal, newTotal);
    }

    /// @dev Try to pay every listed token; skip (keep credited) any whose guarded payment fails.
    function _payAllSkipping(address account) internal returns (address[] memory skipped) {
        uint256 n = _rewardTokens.length;
        skipped = new address[](n);
        uint256 k;
        for (uint256 i; i < n; ++i) {
            address token = _rewardTokens[i];
            uint256 amount = rewards[account][token];
            if (amount == 0) continue;
            if (!_tryPay(account, token)) {
                skipped[k++] = token;
                emit RewardSkipped(account, token, amount);
            }
        }
        assembly ("memory-safe") {
            mstore(skipped, k) // shrink to the k skipped entries
        }
    }

    /// @dev Self-CALL into `payRewardSelf` with exactly SKIP_PAY_GAS. The inner frame zeroes the credit and
    ///      transfers; if anything in it fails (revert, false return, out of gas) the whole frame rolls back,
    ///      so the credit is untouched. No return data is copied (returnbomb-safe). The gas check makes sure
    ///      the callee really receives SKIP_PAY_GAS despite the 63/64 rule.
    function _tryPay(address account, address token) internal returns (bool ok) {
        if (gasleft() < SKIP_PAY_GAS + SKIP_PAY_GAS / 63 + SKIP_GAS_OVERHEAD) revert InsufficientGas();
        bytes memory data = abi.encodeCall(this.payRewardSelf, (account, token));
        uint256 g = SKIP_PAY_GAS;
        assembly ("memory-safe") {
            ok := call(g, address(), 0, add(data, 0x20), mload(data), 0, 0)
        }
    }

    function _pay(address account, address token, address to) internal {
        uint256 amount = rewards[account][token];
        if (amount == 0) return;
        rewards[account][token] = 0;
        _rewards[token].owed -= amount;
        emit RewardPaid(account, token, to, amount);
        IERC20(token).safeTransfer(to, amount);
    }
}
