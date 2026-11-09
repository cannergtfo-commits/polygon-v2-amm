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
