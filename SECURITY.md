# Internal review — BlazarSwap v2

This is a review checklist, not an audit and not a production clearance. The fee router, oracle, daily rewards, and staking contracts are deployed on Polygon PoS. Ownership acceptance is still pending. PolygonScan source is not verified. The original BlazarSwap factory, router, pairs, and Markarian 421 contracts were not replaced.

## What was reviewed

| Contract | Role |
| --- | --- |
| `BlazarFeeRouter` | Pulls the input, takes a capped fee, runs an allowlisted route, pays the output from the balance delta |
| `BlazarUsdOracle` | Chainlink quotes marked trusted, V2 spot quotes marked untrusted |
| `BlazarDailyRewards` | Poster-posted top 25, fixed shares, pull claims, pause, emergency withdraw |
| `BlazarStakingRewards` | Stake BZB, earn BZB, Synthetix accounting, no lock and no fee |

## Controls that are in the code

- Solidity `^0.8.20`, OpenZeppelin `Ownable2Step`, `Pausable`, `ReentrancyGuard`, `SafeERC20` (`forceApprove` so USDT-style approvals can be cleared).
- Aggregator fee defaults to 5 bps (0.05%) of external-routed principal, taken the first time that principal is spent outside the BlazarSwap factory. Later hops do not charge it again. `setFeeBps` reverts above 25 bps. The fee recipient is immutable. A caller cannot mark a third-party router as Blazar: only `KIND_V2` aimed at the immutable factory skips the fee. `KIND_TARGET` is always eligible for the fee.
- Router calls only succeed for `allowedTarget` routers or `v2FeeBps` factories. Targets are approved for the exact spend of that leg and the approval is set back to zero. V2 swaps are done inside the router: transfer to the pair, measure the pair's balance increase, then `swap`. That is what makes a fee-on-transfer input routable through Blazar, QuickSwap, Sushi, and ApeSwap pairs.
- Output is `balanceAfter - balanceBefore` of the measured token. The wrapper does not assume the venue reports an honest return value. Leftover input is refunded to `msg.sender`.
- `swap` is `nonReentrant`. A callback from the fee recipient or a target cannot re-enter `swap` or `rescue`. Rescue of dust works only while the router is paused.
- Daily rewards store 25 addresses and the exact schedule share for each filled rank. Empty ranks pay nothing and are not redistributed. The poster role is separate from the owner. Reserved BZB cannot be emergency-withdrawn unless the contract is paused. `dailyCap` cannot exceed 1000 BZB.
- Staking has no lock and no fee. `recover` reverts if it would take staked tokens, unclaimed rewards, or the still-streaming rate. Pause blocks new stakes and `notifyRewardAmount`. It does not block withdraw or claim.
- The oracle returns `(0, false)` for a stale, negative, or missing feed instead of reverting, and the router catches oracle failures so a bad price cannot brick a swap.

## Tests that back this up

`forge test` covers the fee math (including the 997/1000 identity at 30 bps), the fee cap, fee-on-transfer input, calldata patching, split routes, native POL in and refund, unknown targets, slippage, pause, reentrancy, rescue, daily post/claim/cap/duplicate/pause/reclaim, staking streams with no lock, and recovery. `BzbSwapForkTest` forks Polygon and swaps BZB to WPOL through the wrapper on the live QuickSwap pair, and WPOL to USDC through Uniswap v3 SwapRouter02. Neither test broadcasts.

## Threat model

The owner is trusted for venue allowlists, the oracle address, the daily board, the reward rate, and emergency withdrawal. Traders are not trusted. Other people's tokens are not held between transactions. A trader can only spend what they approve, and a bad route spends their own input.

## Wash trading

Counted volume is not the raw event USD. The indexer (or a future subgraph) reprices `amountIn` at the previous block, drops trades under $25, nets round trips inside 10 minutes, and caps a wallet at $50,000 a day. The wrapper fee is 0.05% of external principal once per path, and each pool still charges its own fee. A one-hop round trip through a 0.30% pool is about 0.70% plus gas before any reward. Extra external hops do not add another wrapper fee on the same principal. The rewards contract also caps one wallet's posted payout. A sybil can still split activity across wallets. That is an unresolved rewards-farming risk, not a solved one.

What that does not stop:

- Many wallets. A sybil can split activity under the per-wallet cap. The fee still makes each wallet pay, but a reward larger than that cost can still be farmed.
- The owner posting themselves, or posting a list the indexer did not produce. The contract cannot see the trades.
- Spot-price games on tokens that only have a thin pool. Those quotes are `usdTrusted = false` and the indexer is supposed to use the previous block. A trade that moves the previous block's price still affects the print. Chainlink-priced assets are the robust set.
- Dust rounding. A transfer small enough that `amount * 5 / 10000` is zero pays no fee. It also falls under the $25 minimum, and gas dominates.

## Residual risks

- Allowlisted routers are powerful. A malicious router added by the owner can pull the approved spend. The allowlist is the safety boundary. Do not add an upgradeable or unreviewed target.
- V3 and Algebra legs do not measure fee-on-transfer the way the V2 leg does. A taxed token on those venues should revert rather than pay the wrong amount. The input fee is still taken from the balance that actually arrived.
- Donated tokens sitting on the router can be swept to the trader or, while paused, rescued by the owner. Don't use the router as a vault.
- `BlazarDailyRewards` emergency withdraw while paused can take BZB that traders have not claimed yet. That is the incident hatch. It is also a rug if the owner key is stolen.
- Same-token staking means a bug in `rewardAllocated` could lock or free the wrong BZB. The tests cover the happy path and the recover guard. They are not a formal proof.
- No professional audit and no bug bounty. The four new contracts are on Polygon. The deploy script still reverts on chain id 137 unless `ALLOW_POLYGON_MAINNET=1`. That flag is not a standing permission to deploy again.

## Still open

- [ ] Run `forge test` again on the commit you will deploy, including the fork test against a fresh RPC.
- [ ] Deploy only to an Anvil or Hardhat fork, or to Amoy, and read back `feeBps`, `feeRecipient`, and the allowlist.
- [ ] Confirm `MAX_FEE_BPS` is 25 and the recipient is the dev wallet.
- [ ] Fund staking and the daily pot with a small amount of BZB and walk stake, claim, post, and claim on the test chain.
- [ ] Pause both contracts and confirm swaps and new stakes stop, while staking withdrawals still work.
- [ ] The Next.js registry still keeps the fee router at the zero address so the unsigned preview stays closed. Do not point that UI at the deployed router until that gate is reviewed.
- [ ] Keep the indexer off the reward poster until a day of test trades matches the JSON by hand.

## BlazarMultiRewardStaking (not deployed)

Branch `multireward-staking`, `contracts/src/BlazarMultiRewardStaking.sol`. Stake BZB and earn up to 5 owner-listed reward tokens. Each token can have up to 5 independent runs with linear curves. The authoring bot reviewed it twice (`contracts/audits/multireward-selfreview.md`). The head-of-security bot reviewed 9b56694 in two passes (no Critical, High or Medium findings), and its fixes were verified at 984a927 (L-1, `checkpoint()`, I-1 and the indexed `RewardPaid.to` closed; nothing above Info). This is not a professional audit. It is not deployed, and deploying needs the owner's explicit OK.

What the code guarantees:
- **Staked BZB cannot be moved by the owner.**
  - `recover(BZB)` is limited to `balance − (totalStaked + owed + unemitted across all runs)`.
  - `pause` blocks only `stake` and new runs.
  - `withdraw` and `emergencyWithdraw` have no owner or pause gate and never call a reward token. Their settlement step is pure storage math.
  - There is no proxy, no delegatecall, no selfdestruct, and no setter for the stake token or `minStake`. `renounceOwnership` is disabled.
- **Existing runs can't be changed by new ones.** A top-up creates a new run. Existing runs keep their exact schedule.
- **Rewards are always settled before an exit.** `emergencyWithdraw` settles every listed token first, so a user never forfeits accrued rewards (L-1 fix). `checkpoint(tokens)` settles without any transfer.

Residual risks and disclosures:
- **BZB is an upgradeable Polygon PoS-bridge proxy (P-6 / P2-07).** Its proxy admin (Polygon's multisig) could upgrade, pause or blacklist BZB. A sender-side fee, rebase or blacklist in a future BZB implementation could make the last withdrawals fail. This contract cannot defend against its own staking token. Watch BZB's implementation slot and admin, and pause new stakes in the UI if they change.
- **`recover` takes all surplus (I-2).** Surplus is donations plus emission while nobody is staked (for example, a run that starts before the first stake, or after the last staker leaves). The owner can move all of it, and it never includes principal, owed rewards or unemitted run amounts. Rounding dust from reward-per-token flooring stays inside `owed` and is **not** owner surplus: it stays reserved permanently. It is bounded to a few wei per checkpoint.
- **The owner at launch is an EOA, by the user's choice (I-7 / P-8).** The owner is the user's own wallet 0x6F47…dB14 via Ownable2Step. The plan is to move ownership to a Safe later. While the owner is an EOA, a stolen key can only grief future rewards: listing junk tokens into the permanent 5 slots, filling a token's 5 run slots for up to about 395 days, pausing new stakes, or recovering surplus. It cannot touch principal or owed rewards. Listing the contract itself is rejected (I-1).
- **`claimTo` / `claimManyTo` (I-6).** These pay only the caller's own rewards. They reject `to == 0` and `to == this`. Any other address is accepted, including token contracts, which may not be able to return funds. The intended use is a user blacklisted by a reward token sending the payout to another wallet they control.
- **Reward-token behavior.** Rebasing or balance-reducing reward tokens aren't supported. A sender-fee or negative-rebase token can only make its own claims insolvent; other tokens and exits are unaffected. A fee-on-transfer token's `RewardPaid.amount` overstates what the recipient actually gets.
- **Gas limits (RV-01).** Worst-case `emergencyWithdraw` is ~792k gas cold (a never-touched user with 5 tokens × 25 live runs), and ~885k gross if all 25 runs finish in the exit transaction. Tests cap every user path at 1M. The UI must send `emergencyWithdraw`, `checkpoint` and `withdraw` with `estimateGas` + 25%, or a fixed limit of at least **1.1M** gas, so a tight wallet estimate can't make an exit fail.
- **Safety bounds (RV-04).** `MIN_STAKE_FLOOR` (1e15), `MAX_RUN_AMOUNT` (2^128−1), `MIN_DURATION` (1 day), the 5-token cap and the 5-runs-per-token cap are what make the settlement math on the exit path provably non-reverting. They are constants with no setter. Any future version that changes them must re-prove that `withdraw` and `emergencyWithdraw` cannot revert.
- **UI requirement before launch.** `withdraw` is the default exit. The emergency button must carry a warning and should only be used if a normal withdraw fails. The `RewardPaid(user, token, to, amount)` event now indexes `to`, so the indexer must be updated.
- **Stake tab (branch `stake-tab-multireward`).** `docs/js/stake-multi.mjs` (UI) and `docs/js/stake-multi-contract.mjs` (ABI, revert decoding, feature flags) implement those requirements: Withdraw is the primary exit, emergency withdraw sits behind a warning and a confirmation checkbox, and `withdraw`, `emergencyWithdraw` and `checkpoint` are sent with `max(estimateGas × 1.25, 1.1M)` gas ; `exit`, `claimAll`, `claimAllSkipping` and `exitSkipping` use `max(estimateGas × 1.25, 2.2M)`; `stake` (and, on the new ABI, `stakeFor`, `stakeWithPermit2`, `compound`) use `max(estimateGas × 1.25, 1.2M)`; everything else (single claims, owner calls, approvals) uses `estimateGas × 1.25`. The tab stays hidden until `multiStaking` is set in `docs/js/config.js`, and the old contract collapses to a single exit-only "Legacy staking" row (Withdraw, Claim) that shows only while there is something left in it. The UI targets the 7a82a23 ABI. The multireward-agent ABI (aeaf3e6: new Staked/Withdrawn/EmergencyWithdrawn fields, getPosition, compound, claimAllSkipping, exitSkipping, stakeFor, stakeWithPermit2) is in the contract module but stays unused until `FEATURES.agentAbi` is switched on, and that should only happen once that contract is the one deployed and configured. Its ABI uses the new `RewardPaid(user, token, to, amount)` with `to` indexed. No indexer or feed in this repo reads staking events today (`web/scripts/index-volume.mjs` reads only fee-router swaps), so nothing else needed changing. Any future feed must use the new topic.
