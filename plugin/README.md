# Polygon plugin core: discovery, USD pricing, BlazarFeeRouter quotes

Read-only. Nothing here signs or sends; `buildSwapTx` returns an unsigned tx for the deployed
BlazarFeeRouter `0x014AC678c96dd5dFAEc78BfffD8E00EEbf117E9b`. No Alchemy: calls go to publicnode
(fallback Tenderly public gateway, dRPC); historical `eth_getLogs` goes to the Tenderly public gateway
(5M-block windows) with dRPC (10k) as fallback. Reads are batched with Multicall3.

```bash
cd plugin && npm install
npm test                         # 22 unit tests, no network
npm run refresh -- --full        # first run: discover every pool + full price sweep (~3.5 min)
npm run refresh                  # incremental (~2 s)
npm run quote -- POL USDC 10     # best router-executable route, net of the 5 bps wrapper fee
npm run fork-dryrun              # anvil fork: quote -> build -> execute on the fork, compare
npm run compare -- LINK,AAVE     # cached prices vs DexScreener
```

## Venues

| Venue | Discovery | Executed by router as | Router allowlist (live) |
|---|---|---|---|
| BlazarSwap V2 `0x8e96…830F` | `PairCreated` | KIND_V2 (no wrapper fee) | v2FeeBps 30 |
| QuickSwap v2 `0x5757…Ab32` | `PairCreated` | KIND_V2 | v2FeeBps 30 |
| SushiSwap V2 `0xc35D…74C4` | `PairCreated` | KIND_V2 | v2FeeBps 30 |
| ApeSwap V2 `0xCf08…1284` | `PairCreated` | KIND_V2 | v2FeeBps 30 (pool's own fee is 0.2%) |
| Uniswap v3 `0x1F98…F984` | `PoolCreated` | target SwapRouter02 `0x68b3…Fc45` | allowed |
| QuickSwap v3 (Algebra 1.0) `0x411b…3A28` | `Pool` | target `0xf5b5…8E12` | allowed |
| QuickSwap v4 (Algebra Integral) `0x134c…9904` | `Pool` (default deployer only) | target `0x96Fe…f1BB` | allowed (tx 0xf9e1b9e8…) |

The quote path re-reads `feeBps`, `paused`, `blazarFactory`, every `v2FeeBps` and every
`allowedTarget` (one multicall, cached 60 s) and only routes through venues that are both in this
table and allowed on-chain.

## Pricing

* Anchors (USD from Chainlink, never from pools): WPOL, USDC, USDC.e, USDT, WETH, WBTC, DAI.
* Pass 1 prices every token paired with an anchor; pass 2 adds tokens priced in pass 1 with
  ≥ $250k depth and < 5% cross-pool dispersion as extra hubs (LINK, AAVE, AS, LGNS, …).
* Pool depth = 2 × min(hub side USD, token side USD) at that pool's own price. Using the smaller
  side means a concentrated pool parked out of range, or a pool stuffed with a worthless token,
  does not count as deep.
* Price = the deepest pool's mid price × the hub's USD price. `dispersion` reports the gap to the
  next pool with at least 10% of that depth.
* **Liquid = best pool depth ≥ $10,000** (`MIN_TVL_USD`), i.e. ≥ $5k on each side. BZB, BBY and
  M421 are pinned and kept even below the bar (flagged `liquid: false`).

## Cache and incremental refresh

`data/pools.json` (registry, ~32 MB, git-ignored), `data/state.json` (token metadata, hot pool
set, cursors), `data/tokens.json` (output). Incremental refresh = one combined `eth_getLogs` over
all seven factories from the last cursor, plus state for the hot set (pools within 25% of the bar,
~700) and any new pool touching a hub. A full re-sweep runs automatically every 24 h.

## RPC cost (measured 2026-11-16, block ~97.44M)

| Operation | Requests | Multicall sub-calls | Alchemy-CU equivalent* | Time |
|---|---|---|---|---|
| First run (discovery from genesis + full sweep) | 1 blockNumber, 112 getLogs, 635 eth_call | 252k | ~23k | 3.5 min, 250 MB |
| Daily full re-sweep | 1 + 1 getLogs + 629 eth_call | 251k | ~16.4k | 50 s, 112 MB |
| Incremental refresh | 1 + 1 getLogs + 5 eth_call | 1.4k | ~200 | 2 s, 0.6 MB |
| One quote | 6 eth_call + 1 gasPrice | ~120 | ~176 | ~1 s |

\*What it would cost if pointed at Alchemy (eth_call 26, getLogs 60, blockNumber 10). The
defaults use free endpoints, so actual Alchemy use is **0 CU**. Even on Alchemy, a 5-minute
incremental cadence plus a daily full sweep is ~2.2M CU/month.

## Plugin facade (`src/plugin.mjs`)

`listTokens`, `getPrice`, `router`, `quote`, `buildSwapTx`, `buildApproveTx`, `refresh`. Symbols
resolve to the deepest token with that symbol and return `ambiguous` alternatives (several
symbols are duplicated on Polygon: QUICK old/new, JPYC, FUN, …); agents should pass addresses.

## Known limits

* Balancer, Curve, Uniswap v4, DODO, KyberSwap Elastic and other DEXes are not discovered or
  routed (the router cannot execute them). Tokens whose liquidity lives there (e.g. MaticX,
  stMATIC on Balancer) are under-counted or missing.
* Fee-on-transfer and rebasing tokens are not detected; the router measures balance deltas, so a
  swap is safe but the quote can be high.
* Algebra Integral pools with a custom deployer (plugin pools) are not routable: the router plan
  passes `deployer = 0`.
* Native POL output to a recipient with code (contract or EIP-7702-delegated wallet) can revert
  the router's recipient-balance check; `buildSwapTx` refuses and asks for WPOL output.
