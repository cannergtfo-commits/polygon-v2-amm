/**
 * BlazarMultiRewardStaking contract layer for the Stake tab: ABI, interfaces, revert decoding and the
 * feature switches. Matches the contract at commit 7a82a23 (branch multireward-staking).
 *
 * Everything that knows the contract's function list lives here so a newer ABI can be dropped in.
 * TODO(multireward-agent): that branch adds getPosition and other views, stakeFor, compound(),
 * stakeWithPermit2, exitSkipping / claimAllSkipping, and extra fields on Staked / Withdrawn. When it is
 * the deployed version:
 *   1. Add those fragments to MULTI_STAKING_ABI (and replace the Staked / Withdrawn event fragments).
 *   2. Flip the matching FEATURES flags below. stake-multi.mjs already has hidden UI hooks for them
 *      (#msCompoundBtn and #msSkipBroken), wired through FEATURES.
 *   3. Add their gas rules to GAS_FLOORS in stake-multi-core.mjs. exitSkipping is an exit path, so give it
 *      the same 1.1M floor as withdraw unless SECURITY.md says otherwise.
 */
const ethers = window.ethers;

/** Off until the contract that has these functions is the one configured in config.js. */
export const FEATURES = Object.freeze({
  // TODO(multireward-agent): compound() restakes BZB rewards. Shows #msCompoundBtn when true.
  compound: false,
  // TODO(multireward-agent): claimAllSkipping() / exitSkipping() pay every token except ones whose transfer
  // reverts. Shows the "skip broken tokens" option next to Claim all when true.
  claimAllSkipping: false,
});

export const MULTI_STAKING_ABI = [
  "function stakingToken() view returns (address)",
  "function minStake() view returns (uint256)",
  "function totalStaked() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function paused() view returns (bool)",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function rewardTokens() view returns (address[])",
  "function isRewardToken(address) view returns (bool)",
  "function earned(address account, address token) view returns (uint256)",
  "function getRuns(address token) view returns ((uint256 slot,uint256 id,uint256 amount,uint256 emittedNow,uint256 start,uint256 end,uint256 startWeight,uint256 endWeight,uint256 ratePerSecond)[])",
  "function activeRunCount(address token) view returns (uint256)",
  "function rewardRate(address token) view returns (uint256)",
  "function reserved(address token) view returns (uint256)",
  "function recoverable(address token) view returns (uint256)",
  "function stake(uint256 amount)",
  "function withdraw(uint256 amount)",
  "function emergencyWithdraw()",
  "function checkpoint(address[] tokens)",
  "function claim(address token)",
  "function claimTo(address token, address to)",
  "function claimMany(address[] tokens)",
  "function claimManyTo(address[] tokens, address to)",
  "function claimAll()",
  "function exit()",
  "function addRewardToken(address token)",
  "function addRewardTokens(address[] tokens)",
  "function notifyRewardAmount((address token,uint256 amount,uint64 duration,uint64 startTime,uint16 startWeight,uint16 endWeight) cfg)",
  "function notifyRewardAmounts((address token,uint256 amount,uint64 duration,uint64 startTime,uint16 startWeight,uint16 endWeight)[] cfgs)",
  "function pause()",
  "function unpause()",
  "function recover(address token, uint256 amount, address to)",
  "function acceptOwnership()",
  "event Staked(address indexed user, uint256 amount)",
  "event Withdrawn(address indexed user, uint256 amount)",
  "event EmergencyWithdrawn(address indexed user, uint256 amount)",
  // `to` is indexed since 984a927: RewardPaid(user, token, to, amount).
  "event RewardPaid(address indexed user, address indexed token, address indexed to, uint256 amount)",
  "event RewardTokenAdded(address indexed token)",
  "event RunStarted(address indexed token, uint256 indexed runId, uint256 slot, uint256 amount, uint256 start, uint256 duration, uint16 startWeight, uint16 endWeight)",
  "event RunFinished(address indexed token, uint256 indexed runId, uint256 slot)",
  "event Recovered(address indexed token, address indexed to, uint256 amount)",
  "error ZeroAddress()",
  "error ZeroAmount()",
  "error NotContract()",
  "error AlreadyListed()",
  "error NotListed()",
  "error TooManyRewardTokens()",
  "error TooManyRuns()",
  "error BadDuration()",
  "error BadWeights()",
  "error BadStart()",
  "error AmountTooLarge()",
  "error InsufficientBalance()",
  "error Underfunded()",
  "error RenounceDisabled()",
  "error BelowMinStake()",
  "error CannotListSelf()",
  "error EnforcedPause()",
  "error ExpectedPause()",
  "error ReentrancyGuardReentrantCall()",
  "error OwnableUnauthorizedAccount(address account)",
  "error OwnableInvalidOwner(address owner)",
  "error SafeERC20FailedOperation(address token)",
];

export const ERROR_TEXT = {
  ZeroAddress: "That address can't be used.",
  ZeroAmount: "Nothing to do: the amount is zero.",
  NotContract: "That address has no contract code.",
  AlreadyListed: "That token is already listed.",
  NotListed: "That token isn't a listed reward token.",
  TooManyRewardTokens: "All 5 reward token slots are used.",
  TooManyRuns: "That token already has 5 unfinished runs.",
  BadDuration: "Duration must be 1 to 365 days.",
  BadWeights: "Curve weights must be 0 to 10,000 and not both zero.",
  BadStart: "Start must be now or within the next 30 days.",
  AmountTooLarge: "That run amount is above the per-run cap.",
  InsufficientBalance: "That's more than you have staked.",
  Underfunded: "The contract would not hold enough to cover what it owes.",
  BelowMinStake: "A position must be 0 or at least the 0.001 BZB minimum. Withdraw all, or leave at least 0.001.",
  CannotListSelf: "The staking contract can't list itself.",
  EnforcedPause: "Staking is paused. Withdraw and claims still work.",
  OwnableUnauthorizedAccount: "Only the owner can do that.",
  SafeERC20FailedOperation: "The token transfer failed. If one reward token is failing, claim the others one at a time, and use Withdraw for your stake.",
};

export const iface = new ethers.Interface(MULTI_STAKING_ABI);
export const erc20Iface = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
]);

export function decodeRevert(err) {
  const candidates = [err?.data, err?.info?.error?.data, err?.error?.data, err?.info?.error?.data?.data, err?.revert?.data];
  for (const data of candidates) {
    if (typeof data !== "string" || !data.startsWith("0x") || data.length < 10) continue;
    for (const ifc of [iface, erc20Iface]) {
      try {
        const parsed = ifc.parseError(data);
        if (parsed) return ERROR_TEXT[parsed.name] || `Contract refused: ${parsed.name}`;
      } catch { /* try next */ }
    }
  }
  const msg = String(err?.shortMessage || err?.reason || err?.message || "");
  const m = msg.match(/(ZeroAmount|BelowMinStake|InsufficientBalance|EnforcedPause|Underfunded|TooManyRuns|TooManyRewardTokens|NotListed|AlreadyListed|BadStart|BadDuration|BadWeights|CannotListSelf|OwnableUnauthorizedAccount)/);
  if (m) return ERROR_TEXT[m[1]];
  return null;
}
