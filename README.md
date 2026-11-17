# BlazarSwap

Polygon PoS desk and games for Blazar Force. The live site is [blazarforce.net](https://blazarforce.net/). GitHub Pages publishes the `docs/` folder. The homepage swap sends through the deployed fee router from the browser. The Next.js app in `web/` is not what GitHub Pages runs.

Public repo: https://github.com/cannergtfo-commits/polygon-v2-amm

## What is live

| Piece | Status |
| --- | --- |
| Homepage | Live in `docs/`. Tabs are Swap, Profile, Liquidity, Stake BZB (multi-reward card plus the legacy card), and Leaderboard. The header links to [blazar-apps.html](https://blazarforce.net/blazar-apps.html) and [agents.html](https://blazarforce.net/agents.html) |
| Agents page | Live at [blazarforce.net/agents.html](https://blazarforce.net/agents.html). A "Connect your AI" prompt copies into Grok Bot or another assistant so it can add the hosted MCP at `https://api.blazarforce.net/mcp` (no sign-in). Developer curl for the xAI Responses API is in a collapsible on that page. |
| Token list | `docs/js/polygon-tokens.mjs` (pinned Blazar assets + Uniswap default list). At load the picker also merges graduated PolyPump tokens from `https://launch.blazarforce.net/tokenlist.json` (`docs/js/token-lists.mjs`, test: `node docs/js/token-lists.test.mjs`). Built-in entries are never overridden; PolyPump entries are labelled "unverified" (POL or BZB pair shown), and reserved or duplicate symbols (USDC, WPOL, BZB, ...) are dropped. Matching runs on a confusable skeleton: non-ASCII symbols (Cyrillic `USDС`, `ВZB`, `µSDC`), reserved tickers with short suffixes (`USDC2`, `USDCx`), names impersonating major assets (`USD Сoin`, `BlazarBits`), names with invisible or text-direction characters (zero-width space, BOM, soft hyphen, bidi overrides; stripped before any comparison), names mixing Latin with another script (Lisu `ꓴSD Coin`, Coptic, Cyrillic) and names already in the picker are dropped too. Graduated BZB-paired tokens show "graduated (BZB), thin pool" |
| Swap | Browser quotes allowlisted V2 factories plus Uniswap v3 and QuickSwap v3, then the user signs the fee router. Blazar factory legs pay no extra wrapper fee. External principal pays 0.05% once |
| Fee router `0x014AC678c96dd5dFAEc78BfffD8E00EEbf117E9b` | Deployed and used by the homepage swap. The Next.js registry still keeps this address at zero, so that app's unsigned builder stays closed |
| Oracle `0x7d022EB5b18a79b585601326d87964C87F948892` | Deployed |
| Daily rewards `0x323DCb75A4f265D26dd3f5F203e12e7625d49951` | Deployed. Poster `0x55BA739Ba386D634CF81bd53d974dAF95241952C`. Not a funded public rewards program |
| BZB staking `0x3Aa4a59deC4F677A138857a828220eEd259b2469` | Deployed (legacy). No lock and no stake fee. Era 2 streams ~857 BZB/day until Nov 30, 2026 2:47 PM PST. Still fully usable in the Stake tab. Separate from M421 staking |
| Multi-reward staking `0x4222bFF08cc9D42cd3311033a4882314DfE19615` | Deployed Nov 16, 2026 ([tx](https://polygonscan.com/tx/0x2164b2ee61970a69286f03b006ababd031ed99961c89d76d91e1363b6d9317c9)). Stake BZB (min 1 BZB, no lock) and earn up to 5 reward tokens. Owner `0x6F47aa396215ab22647dDB3E86b4663DFe11dB14` set in the constructor, no pending owner. Verified on Sourcify and Polygonscan. Source: branch `multireward-agent` @ `d475961` (not on `main`). No reward tokens listed yet. See SECURITY.md |
| Sourcify | Exact creation and runtime match on all four, and on the multi-reward staking contract |
| PolygonScan | The four older contracts are unverified (bytecode plus Verify and Publish). The multi-reward staking contract is verified |
| Ownership | Older four: owner `0xB452329B7b9d55a82f10a4e60E22748De6e490F2`, pending owner `0x6F47aa396215ab22647dDB3E86b4663DFe11dB14` has not accepted. Multi-reward staking: owner `0x6F47…dB14` directly |
| Reviewed buy | [2 POL to 35.724819195641942150 BZB](https://polygonscan.com/tx/0xe8abb28a9be4d14d53675e84954c1494492a39e46285545c828e695c9af16ed3), block 96985334, wrapper fee 0, gas 0.073823070974366448 POL. No second trade |

The 15 deployment receipts used 2.110833552073840492 POL. This tree is not an audit and not a clearance to deploy again.

## Source in this repo

- `contracts/` — Solidity for the fee router, oracle, daily rewards, and staking, plus Foundry tests. OpenZeppelin 5.1.0 and forge-std are vendored. Compiler 0.8.26, optimizer 200, via-IR, Cancun.
- `web/` — Next.js desk and a local agent kit. The fee-router address in `web/src/config/registry.json` is still the zero address, so unsigned transaction bytes stay closed. GitHub Pages does not run this app.
- `android/` — debug wallet source. Not a production signer. Do not load a real seed. Debug APKs are not published from this commit.
- `indexer/SUBGRAPH.md` — volume scoring notes. Round-trip netting is not a Sybil proof.
- `docs/developers.html` — how to read the local kit. The OpenAPI file is `docs/developers/blazar-bot-v1.yaml`.

```bash
cd contracts && forge test
cd web && pnpm install && pnpm exec tsc --noEmit && pnpm test:score
cd android && ./gradlew :crypto:test
```

## Markarian 421

Equal-value basket of BzB, WBTC, and WETH. The receipt is M421. See [markarian/MARKARIAN.md](./markarian/MARKARIAN.md).

## Remix

See [REMIX.md](./REMIX.md).

## License

GPL-3.0-or-later for this repository unless a file says otherwise. OpenZeppelin files keep their own license. Not audited.
