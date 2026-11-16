#!/usr/bin/env node
/** Sanity check: compare cached on-chain USD prices with DexScreener's deepest Polygon pair. */
import { createPlugin } from "../src/plugin.mjs";

const p = createPlugin();
const want = (process.argv[2] || "").split(",").filter(Boolean);
const list = p.listTokens({ limit: 100000 }).tokens;
const picks = want.length
  ? want.map((s) => list.find((t) => t.symbol.toLowerCase() === s.toLowerCase() || t.address === s.toLowerCase())).filter(Boolean)
  : list.filter((t) => t.depthUsd).slice(0, 30);
const rows = [];
for (let i = 0; i < picks.length; i += 30) {
  const slice = picks.slice(i, i + 30);
  const res = await fetch(`https://api.dexscreener.com/tokens/v1/polygon/${slice.map((t) => t.address).join(",")}`, { headers: { "user-agent": "blazar-polygon-plugin/0.1" } });
  const pairs = await res.json();
  for (const t of slice) {
    const mine = pairs
      .filter((x) => x.baseToken?.address?.toLowerCase() === t.address && x.priceUsd)
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const ds = mine[0];
    const dsPrice = ds ? Number(ds.priceUsd) : null;
    rows.push({
      symbol: t.symbol,
      address: t.address,
      onchainUsd: Number(t.priceUsd.toPrecision(6)),
      dexscreenerUsd: dsPrice,
      diffPct: dsPrice ? Number(((t.priceUsd / dsPrice - 1) * 100).toFixed(2)) : null,
      ourDepthUsd: t.depthUsd,
      dsLiquidityUsd: ds?.liquidity?.usd ? Math.round(ds.liquidity.usd) : null,
      dsDex: ds ? `${ds.dexId}${ds.labels?.length ? ` ${ds.labels.join("/")}` : ""}` : null,
    });
  }
}
console.log(JSON.stringify({ cacheBlock: p.listTokens().block, cacheAt: p.listTokens().updatedAt, rows }, null, 2));
