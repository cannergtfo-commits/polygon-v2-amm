# Subgraph alternative

The default indexer is `web/scripts/index-volume.mjs`. A subgraph is the same pipeline if you want The Graph or a self-hosted Graph node later. Do not deploy either against a live rewards poster until the fee router exists on the chain you intend to score.

## Schema

```graphql
type Swap @entity {
  id: ID!
  trader: Bytes!
  tokenIn: Bytes!
  tokenOut: Bytes!
  amountIn: BigInt!
  feeAmount: BigInt!
  amountOut: BigInt!
  usdE8: BigInt!
  usdTrusted: Boolean!
  feeBps: Int!
  timestamp: BigInt!
  dayId: BigInt!
}

type DayScore @entity {
  id: ID!
  dayId: BigInt!
  trader: Bytes!
  volumeUsd: BigDecimal!
  points: BigInt!
}
```

## Handler

Listen for `AggregatedSwap` on `BlazarFeeRouter`.

1. Ignore trades whose recomputed USD at `block.number - 1` is below `minTradeUsd` (default $25).
2. Price `tokenIn` from Chainlink when a feed is in `web/src/config/registry.json`. Otherwise read a V2 `getPair` against WPOL on QuickSwap, then BlazarSwap, and convert WPOL with the POL/USD feed. Do not score a trade the indexer cannot price.
3. Within `roundTripWindowSec` (default 600), if the same trader swaps the pair in both directions, subtract the smaller USD amount from both legs.
4. Cap each wallet at `walletDailyCapUsd` (default $50,000) per UTC day (`timestamp / 86400`).
5. Points are `floor(countedUsd * perUsd)` with `perUsd = 1`.
6. After the UTC day closes, list the top 50. Pay only the top 25 at the fixed `shareBps` of the 1000 BZB cap. Do not renormalize. Empty ranks stay unpaid. The poster, not the owner, sends `postWinners`.

The owner, or a keeper the owner runs, sends that payload to `BlazarDailyRewards.postTop10`. The contract does not recompute the board. A compromised indexer or owner can post the wrong ten addresses. Traders claim from the posted list; they cannot inflate it themselves.
