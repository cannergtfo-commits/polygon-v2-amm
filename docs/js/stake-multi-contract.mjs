/**
 * BlazarMultiRewardStaking contract layer for the Stake tab: ABI, interfaces, revert decoding and the
 * feature switches. Everything that knows the contract's function list lives here.
 *
 * The UI targets the contract at 7a82a23 (branch multireward-staking). The multireward-agent ABI
 * (aeaf3e6) is included below as MULTI_STAKING_ABI_AGENT but is only used when FEATURES.agentAbi is on.
 * To switch once that contract is the one deployed and configured in config.js:
 *   1. Set FEATURES.agentAbi = true (swaps the Staked / Withdrawn / EmergencyWithdrawn event shapes and
 *      adds getPosition, stakeFor, stakeWithPermit2, compound, claimAllSkipping, exitSkipping).
 *   2. Flip FEATURES.compound and/or FEATURES.claimAllSkipping to show their UI hooks.
 *   3. Gas rules for the new calls are already in GAS_FLOORS (stake-multi-core.mjs).
 * TODO(multireward-agent): loadMultiStake could read getPosition() in one call instead of the multicall,
 * and the More menu could offer exitSkipping. stakeFor / stakeWithPermit2 have no UI yet.
 */
const ethers = window.ethers;

/** All off: the configured contract (when there is one) is the 7a82a23 version. Don't switch on early. */
export const FEATURES = Object.freeze({
  // Use the multireward-agent (aeaf3e6) ABI. Required by the two flags below.
  agentAbi: false,
  // compound() restakes BZB rewards. Shows #msCompoundBtn when true.
  compound: false,
  // claimAllSkipping() pays every token except ones whose transfer fails. Shows the "skip broken tokens"
  // option next to Claim all when true.
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

/** multireward-agent at aeaf3e6: same functions as above plus the new ones, with the new event shapes. */
const AGENT_REPLACED = /^event (Staked|Withdrawn|EmergencyWithdrawn)\(/;
export const MULTI_STAKING_ABI_AGENT = [
  ...MULTI_STAKING_ABI.filter((f) => !AGENT_REPLACED.test(f)),
  "function totalSupply() view returns (uint256)",
  "function getPosition(address account) view returns ((uint256 staked, uint256 totalStaked, uint256 minStake, bool paused, uint256 timestamp, address[] tokens, uint256[] earned, uint256[] ratePerSecond, uint256[] rewardsEnd) p)",
  "function earnedAll(address account) view returns (address[] tokens, uint256[] amounts)",
  "function rewardsEnd(address token) view returns (uint256)",
  "function emissionBetween(address token, uint256 t0, uint256 t1) view returns (uint256 total)",
  "function stakeFor(address beneficiary, uint256 amount)",
  "function stakeWithPermit2(address owner_, ((address token, uint256 amount) permitted, uint256 nonce, uint256 deadline) permit, bytes signature)",
  "function compound() returns (uint256 amount)",
  "function claimAllSkipping() returns (address[] skipped)",
  "function exitSkipping() returns (address[] skipped)",
  "event Staked(address indexed user, address indexed payer, uint256 amount, uint256 balanceAfter, uint256 totalStakedAfter)",
  "event Withdrawn(address indexed user, uint256 amount, uint256 balanceAfter, uint256 totalStakedAfter)",
  "event EmergencyWithdrawn(address indexed user, uint256 amount, uint256 balanceAfter, uint256 totalStakedAfter)",
  "event Compounded(address indexed user, uint256 amount)",
  "event RewardSkipped(address indexed user, address indexed token, uint256 amount)",
  "error WrongToken()",
  "error BadWindow()",
  "error OnlySelf()",
  "error InsufficientGas()",
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
  BelowMinStake: "A position must be 0 or at least the minimum stake. Withdraw all, or leave at least the minimum.",
  CannotListSelf: "The staking contract can't list itself.",
  EnforcedPause: "Staking is paused. Withdraw and claims still work.",
  OwnableUnauthorizedAccount: "Only the owner can do that.",
  WrongToken: "That signature is for a different token than BZB.",
  BadWindow: "That time window isn't valid.",
  InsufficientGas: "Not enough gas was sent for a full try. Retry; the tab sends at least 2.2M.",
  SafeERC20FailedOperation: "The token transfer failed. If one reward token is failing, claim the others one at a time, and use Withdraw for your stake.",
};

export const ACTIVE_ABI = FEATURES.agentAbi ? MULTI_STAKING_ABI_AGENT : MULTI_STAKING_ABI;
export const iface = new ethers.Interface(ACTIVE_ABI);
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
