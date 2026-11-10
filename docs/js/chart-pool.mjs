/**
 * Pick the one GeckoTerminal pool that backs a token chart.
 *
 * Same rule as web/src/lib/pool-score.ts and android PoolScore:
 *   score = 0.70 * norm(liquidityUsd) + 0.30 * norm(ageSeconds)
 *   norm(x) = x / max(x) in the set, or 0 when that max is 0
 * Ties prefer more liquidity, then a longer history.
 * Age stands in for candle history so choosing a chart does not
 * spend a GeckoTerminal request per pool.
 *
 * The winner is a display choice. Swap quotes still search every
 * allowlisted venue and do not read this score.
 */
import { NATIVE, WPOL } from "./desk-core.mjs";

export const LIQUIDITY_WEIGHT = 0.7;
export const HISTORY_WEIGHT = 0.3;
export const GECKO_NETWORK = "polygon_pos";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/i;

const DEX_LABELS = {
  quickswap: "QuickSwap",
  quickswap_v3: "QuickSwap v3",
  uniswap_v3_polygon_pos: "Uniswap v3",
  sushiswap: "SushiSwap",
  apeswap: "ApeSwap",
  dfyn: "Dfyn",
  comethswap: "ComethSwap",
};

export function dexLabel(dex) {
  if (!dex) return "";
  return DEX_LABELS[dex] || dex;
}

export function scorePools(pools) {
  const rows = pools.map((pool) => ({
    address: pool.address,
    liquidityUsd: Number.isFinite(pool.liquidityUsd) ? Math.max(0, pool.liquidityUsd) : 0,
    ageSeconds: Number.isFinite(pool.ageSeconds) ? Math.max(0, pool.ageSeconds) : 0,
  }));
  const maxLiquidity = rows.reduce((max, row) => Math.max(max, row.liquidityUsd), 0);
  const maxAge = rows.reduce((max, row) => Math.max(max, row.ageSeconds), 0);
  return rows
    .map((row) => {
      const liquidityNorm = maxLiquidity > 0 ? row.liquidityUsd / maxLiquidity : 0;
      const historyNorm = maxAge > 0 ? row.ageSeconds / maxAge : 0;
      return {
        ...row,
        liquidityNorm,
        historyNorm,
        score: LIQUIDITY_WEIGHT * liquidityNorm + HISTORY_WEIGHT * historyNorm,
      };
    })
    .sort((a, b) => b.score - a.score || b.liquidityUsd - a.liquidityUsd || b.ageSeconds - a.ageSeconds);
}

export function canonicalChartToken(address, wpol = WPOL, native = NATIVE) {
  if (typeof address !== "string") return null;
  const trimmed = address.trim();
  if (!ADDRESS.test(trimmed)) return null;
  if (trimmed.toLowerCase() === String(native).toLowerCase()) return String(wpol).toLowerCase();
  return trimmed.toLowerCase();
}

export function geckoPoolsPath(address) {
  const token = canonicalChartToken(address);
  if (!token) return null;
  return `/networks/${GECKO_NETWORK}/tokens/${token}/pools?page=1`;
}

function num(value) {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function record(value) {
  return value && typeof value === "object" ? value : {};
}

/**
 * Pools on the first GeckoTerminal page. Addresses that are not 20-byte
 * hex are dropped. Nothing here invents an address.
 * `base` is true when this token is the pool's base token. The embed
 * draws that side, same as the base/quote choice in web/src/lib/gecko.ts.
 */
export function poolsFromGecko(body, tokenAddress, nowMs = Date.now()) {
  const token = canonicalChartToken(tokenAddress);
  const rows = Array.isArray(body?.data) ? body.data : [];
  const pools = [];
  for (const row of rows) {
    const attrs = record(row?.attributes);
    const address = typeof attrs.address === "string" ? attrs.address.trim() : "";
    if (!ADDRESS.test(address)) continue;
    const created = typeof attrs.pool_created_at === "string" ? attrs.pool_created_at : null;
    const createdMs = created ? Date.parse(created) : NaN;
    const dex = record(record(record(row?.relationships).dex).data).id;
    const baseId = String(record(record(record(row?.relationships).base_token).data).id || "");
    pools.push({
      address: address.toLowerCase(),
      name: typeof attrs.name === "string" && attrs.name.trim() ? attrs.name.trim() : address.toLowerCase(),
      dex: typeof dex === "string" ? dex : "",
      liquidityUsd: num(attrs.reserve_in_usd) ?? 0,
      ageSeconds: Number.isFinite(createdMs) ? Math.max(0, (nowMs - createdMs) / 1000) : 0,
      createdAt: Number.isFinite(createdMs) ? created : null,
      base: Boolean(token) && baseId.toLowerCase().endsWith(token),
    });
  }
  return pools;
}

/**
 * Highest score wins. The embed charts the pool's base token, so a pool
 * where this token is only the quote does not chart it. Prefer the
 * best-scored pool in which this token is base. If none list it as base,
 * use the highest score anyway.
 */
export function bestChartPool(body, { token = null, nowMs = Date.now() } = {}) {
  const pools = poolsFromGecko(body, token, nowMs);
  const ranked = scorePools(pools);
  const winnerOf = (rows) => {
    const top = rows[0];
    if (!top) return null;
    const pool = pools.find((item) => item.address === String(top.address).toLowerCase());
    return pool ? { ...pool, score: top.score } : null;
  };
  const baseRows = ranked.filter((row) => pools.find((item) => item.address === String(row.address).toLowerCase())?.base);
  return winnerOf(baseRows) || winnerOf(ranked);
}

export function geckoEmbedUrl(poolAddress) {
  if (typeof poolAddress !== "string" || !ADDRESS.test(poolAddress.trim())) return null;
  const id = poolAddress.trim().toLowerCase();
  return `https://www.geckoterminal.com/${GECKO_NETWORK}/pools/${id}?embed=1&info=0&swaps=0&light_chart=0&chart_type=price&resolution=15m&bg_color=030712`;
}

export function geckoPoolUrl(poolAddress) {
  if (typeof poolAddress !== "string" || !ADDRESS.test(poolAddress.trim())) return null;
  return `https://www.geckoterminal.com/${GECKO_NETWORK}/pools/${poolAddress.trim().toLowerCase()}`;
}

export function geckoTokenUrl(address) {
  const token = canonicalChartToken(address);
  if (!token) return null;
  return `https://www.geckoterminal.com/${GECKO_NETWORK}/tokens/${token}`;
}

export function liquidityLabel(liquidityUsd) {
  if (!Number.isFinite(liquidityUsd)) return "Liquidity unavailable";
  return `Liquidity $${liquidityUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function ageLabel(createdAt, nowMs = Date.now()) {
  const created = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(created)) return "Age unavailable";
  const days = Math.max(0, Math.floor((nowMs - created) / 86_400_000));
  return `Age ${days} ${days === 1 ? "day" : "days"}`;
}

export function chartCaption(pool, { blazarPairUnlisted = false } = {}) {
  const dex = pool.dex ? ` · ${dexLabel(pool.dex)}` : "";
  const lead = `${pool.name}${dex}. One pool is chosen automatically: 70% liquidity and 30% age. Swaps still search every allowlisted venue.`;
  if (!blazarPairUnlisted) return lead;
  return `${lead} The Blazar pair is not on GeckoTerminal.`;
}

export function emptyChartCopy(kind) {
  if (kind === "none") {
    return {
      frame: "No GeckoTerminal pool for this token.",
      note: "No GeckoTerminal pool for this token. Swaps still search every allowlisted venue.",
    };
  }
  return {
    frame: "GeckoTerminal is unavailable.",
    note: "GeckoTerminal is unavailable. Swaps still search every allowlisted venue.",
  };
}
