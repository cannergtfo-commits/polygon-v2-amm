/**
 * Pure pricing math. No network. All USD values are JS numbers (display/ranking only);
 * execution amounts elsewhere stay in BigInt.
 */
import { MIN_TVL_USD, SECONDARY_HUB_TVL_USD } from "./config.mjs";

const Q96 = 2 ** 96;

export function lower(a) {
  return String(a || "").toLowerCase();
}

/** Raw base-unit amount -> float in whole tokens. */
export function toFloat(raw, decimals) {
  const v = BigInt(raw);
  if (v === 0n) return 0;
  const s = v.toString();
  const d = Number(decimals);
  if (s.length <= 15) return Number(v) / 10 ** d;
  // keep 15 significant digits to avoid Number overflow/precision loss
  const head = Number(s.slice(0, 15));
  return head * 10 ** (s.length - 15 - d);
}

/** Mid price of token0 in token1 (whole units) from a Uniswap/Algebra sqrt price. */
export function priceFromSqrt(sqrtPriceX96, dec0, dec1) {
  const r = Number(BigInt(sqrtPriceX96)) / Q96;
  return r * r * 10 ** (Number(dec0) - Number(dec1));
}

/** Mid price of token0 in token1 (whole units) from V2 reserves. */
export function priceFromReserves(r0, r1, dec0, dec1) {
  const a = toFloat(r0, dec0);
  const b = toFloat(r1, dec1);
  return a > 0 ? b / a : 0;
}

/**
 * Value one pool for a given (token, hub) orientation.
 * pool: { kind, token0, token1, reserve0?, reserve1?, sqrtPriceX96?, bal0?, bal1? }
 * Returns { priceInHub, hubSideUsd, tokenSideUsd, depthUsd } or null.
 * depthUsd = 2 * min(hub side, token side) at this pool's own price.
 */
export function valuePool(pool, token, hub, decimals, hubUsd) {
  const t = lower(token);
  const h = lower(hub);
  const t0 = lower(pool.token0);
  const t1 = lower(pool.token1);
  if (!((t0 === t && t1 === h) || (t0 === h && t1 === t))) return null;
  const dec0 = decimals[t0];
  const dec1 = decimals[t1];
  if (dec0 === undefined || dec1 === undefined || !(hubUsd > 0)) return null;
  let p01;
  let amt0;
  let amt1;
  if (pool.kind === "v2") {
    if (!pool.reserve0 || !pool.reserve1) return null;
    p01 = priceFromReserves(pool.reserve0, pool.reserve1, dec0, dec1);
    amt0 = toFloat(pool.reserve0, dec0);
    amt1 = toFloat(pool.reserve1, dec1);
  } else {
    if (!pool.sqrtPriceX96 || pool.bal0 === undefined || pool.bal1 === undefined) return null;
    p01 = priceFromSqrt(pool.sqrtPriceX96, dec0, dec1);
    amt0 = toFloat(pool.bal0, dec0);
    amt1 = toFloat(pool.bal1, dec1);
  }
  if (!(p01 > 0) || !Number.isFinite(p01)) return null;
  const tokenIs0 = t0 === t;
  const priceInHub = tokenIs0 ? p01 : 1 / p01;
  const hubAmt = tokenIs0 ? amt1 : amt0;
  const tokAmt = tokenIs0 ? amt0 : amt1;
  const hubSideUsd = hubAmt * hubUsd;
  const tokenSideUsd = tokAmt * priceInHub * hubUsd;
  const depthUsd = 2 * Math.min(hubSideUsd, tokenSideUsd);
  return { priceInHub, priceUsd: priceInHub * hubUsd, hubSideUsd, tokenSideUsd, depthUsd };
}

/** Hub-side USD only. Cheap pre-filter before token decimals are known. */
export function hubSideUsd(pool, hub, hubDecimals, hubUsd) {
  const h = lower(hub);
  const is0 = lower(pool.token0) === h;
  if (!is0 && lower(pool.token1) !== h) return 0;
  const raw = pool.kind === "v2" ? (is0 ? pool.reserve0 : pool.reserve1) : is0 ? pool.bal0 : pool.bal1;
  if (raw === undefined || raw === null) return 0;
  return toFloat(raw, hubDecimals) * hubUsd;
}

/**
 * Price every token reachable from priced hubs. `pools` carry live state. `hubs` maps
 * lower(address) -> { usd, decimals }. Returns Map token -> best quote plus all candidates.
 */
export function priceTokens(pools, hubs, decimals, { minDepthUsd = 0 } = {}) {
  const best = new Map();
  for (const pool of pools) {
    const t0 = lower(pool.token0);
    const t1 = lower(pool.token1);
    for (const [token, hub] of [[t0, t1], [t1, t0]]) {
      const h = hubs[hub];
      if (!h) continue;
      const v = valuePool(pool, token, hub, decimals, h.usd);
      if (!v || v.depthUsd < minDepthUsd) continue;
      const row = { token, hub, pool: lower(pool.address), venue: pool.venue, ...v };
      const cur = best.get(token);
      if (!cur) best.set(token, { best: row, candidates: [row] });
      else {
        cur.candidates.push(row);
        if (row.depthUsd > cur.best.depthUsd) cur.best = row;
      }
    }
  }
  for (const entry of best.values()) {
    entry.candidates.sort((a, b) => b.depthUsd - a.depthUsd);
    entry.candidates = entry.candidates.slice(0, 4);
    const second = entry.candidates[1];
    entry.dispersion = second && second.depthUsd >= entry.best.depthUsd * 0.1 ? Math.abs(second.priceUsd / entry.best.priceUsd - 1) : 0;
    entry.totalDepthUsd = entry.candidates.reduce((s, c) => s + c.depthUsd, 0);
  }
  return best;
}

export function isLiquid(entry, minTvl = MIN_TVL_USD) {
  return !!entry && entry.best.depthUsd >= minTvl;
}

export function secondaryHubs(priced, anchors, minTvl = SECONDARY_HUB_TVL_USD) {
  const out = {};
  for (const [token, entry] of priced) {
    if (anchors[token]) continue;
    if (entry.best.depthUsd >= minTvl && entry.dispersion < 0.05) out[token] = { usd: entry.best.priceUsd };
  }
  return out;
}
