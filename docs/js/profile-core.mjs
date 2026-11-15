/**
 * Profile-tab helpers: price picking, USD math, token ranking, protocol
 * grouping, and Aave decoding. No network, no DOM, no keys.
 */

export const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const WPOL = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

/** Aave v3 Polygon, verified on-chain via PoolAddressesProvider 0xa976…3CDb. */
export const AAVE_V3 = {
  pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  addressesProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
  dataProvider: "0x243Aa95cAC2a25651eda86e80bEe66114413c43b",
  oracle: "0xb023e699F5a33916Ea823A16485e259257cA8Bd1",
  app: "https://app.aave.com/?marketName=proto_polygon_v3",
};

export const DEXSCREENER_TOKENS = "https://api.dexscreener.com/tokens/v1/polygon/";
export const DEXSCREENER_BATCH = 30;
/** Pools thinner than this still price a token, but the row is flagged. */
export const THIN_LIQUIDITY_USD = 1_000;
export const DUST_USD = 1;
export const TOP_TOKENS = 6;

/** Display order and look for each protocol group. */
export const PROTOCOLS = {
  blazar: { name: "BlazarSwap", logo: "bzb-icon.png", order: 0 },
  "blazar-stake": { name: "BlazarSwap Staking", logo: "bzb-icon.png", order: 1 },
  "blazar-rewards": { name: "BlazarSwap Trading Rewards", logo: "bzb-icon.png", order: 2 },
  quickswap: { name: "QuickSwap", logo: "https://icons.llamao.fi/icons/protocols/quickswap?w=48&h=48", order: 3 },
  uniswap: { name: "Uniswap", logo: "https://icons.llamao.fi/icons/protocols/uniswap?w=48&h=48", order: 4 },
  aave: { name: "Aave v3", logo: "https://icons.llamao.fi/icons/protocols/aave-v3?w=48&h=48", order: 5 },
  sushi: { name: "SushiSwap", logo: "https://icons.llamao.fi/icons/protocols/sushi?w=48&h=48", order: 6 },
  apeswap: { name: "ApeSwap", logo: "https://icons.llamao.fi/icons/protocols/apeswap?w=48&h=48", order: 7 },
};

/** Map a liquidity-tab venue id onto a profile protocol group. */
export function protocolOf(venueId) {
  const id = String(venueId || "");
  if (id === "blazar") return "blazar";
  if (id.startsWith("quickswap")) return "quickswap";
  if (id.startsWith("uniswap")) return "uniswap";
  if (id === "sushi") return "sushi";
  if (id === "apeswap") return "apeswap";
  return id || "other";
}

export function lower(address) {
  return String(address || "").toLowerCase();
}

export function isAddress(text) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(text || "").trim());
}

/** Price key: native POL shares WPOL's price. */
export function priceKey(address) {
  return lower(address) === lower(NATIVE) ? lower(WPOL) : lower(address);
}

/** Raw token amount times a USD unit price, as a float. */
export function usdOf(amount, decimals, priceUsd) {
  if (priceUsd == null || !Number.isFinite(Number(priceUsd))) return null;
  const raw = BigInt(amount || 0n);
  if (raw === 0n) return 0;
  const d = Number(decimals) || 0;
  // Keep 6 fractional digits of precision before converting to float.
  const scale = 10n ** BigInt(d);
  const whole = raw / scale;
  const frac = raw % scale;
  const human = Number(whole) + Number((frac * 1_000_000n) / scale) / 1e6;
  return human * Number(priceUsd);
}

/** Human float of a raw amount (for display only). */
export function toFloat(amount, decimals) {
  return usdOf(amount, decimals, 1) ?? 0;
}

/**
 * Pick a USD price for `token` from DexScreener /tokens/v1 pairs.
 * The deepest pool wins. Pools where the token is the quote side are used
 * through priceUsd / priceNative. Returns { price, liquidity, thin } or null.
 */
export function pickDexPrice(pairs, token) {
  const key = lower(token);
  let best = null;
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    if (!pair || (pair.chainId && pair.chainId !== "polygon")) continue;
    const liq = Number(pair.liquidity?.usd || 0);
    const priceUsd = Number(pair.priceUsd);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;
    let price = null;
    if (lower(pair.baseToken?.address) === key) {
      price = priceUsd;
    } else if (lower(pair.quoteToken?.address) === key) {
      const native = Number(pair.priceNative);
      if (Number.isFinite(native) && native > 0) price = priceUsd / native;
    }
    if (price == null || !Number.isFinite(price) || price <= 0) continue;
    if (!best || liq > best.liquidity) best = { price, liquidity: liq };
  }
  if (!best) return null;
  return { ...best, thin: best.liquidity < THIN_LIQUIDITY_USD };
}

/**
 * A holding can't be sold for more than the pool's quote side (about half
 * its USD liquidity) in a constant-product pool. Cap wallet values there so
 * a huge bag of a thin token doesn't inflate net worth.
 */
export function capByDepth(usd, liquidityUsd) {
  if (usd == null) return { usd: null, capped: false };
  const liq = Number(liquidityUsd);
  if (!Number.isFinite(liq) || liq <= 0) return { usd, capped: false };
  const max = liq / 2;
  return usd > max ? { usd: max, capped: true } : { usd, capped: false };
}

/** Split addresses into DexScreener-sized batches, deduped and lowercased. */
export function dexBatches(addresses, size = DEXSCREENER_BATCH) {
  const uniq = [...new Set(addresses.map(lower).filter((a) => isAddress(a) && a !== lower(NATIVE)))];
  const out = [];
  for (let i = 0; i < uniq.length; i += size) out.push(uniq.slice(i, i + size));
  return out;
}

/** Chainlink / Aave-oracle answer (int, `decimals`) to a float USD price. */
export function oraclePrice(answer, decimals = 8) {
  const n = BigInt(answer || 0n);
  if (n <= 0n) return null;
  return Number(n) / 10 ** Number(decimals);
}

/**
 * Rank wallet tokens by USD value. Rows: { symbol, amount, decimals, usd }.
 * Unpriced rows sort after priced ones. Small balances are anything priced
 * under DUST_USD, or unpriced. Returns { rows, shown, hiddenSmall, total }.
 */
export function rankTokens(rows, { showSmall = false, expanded = false, top = TOP_TOKENS, dust = DUST_USD } = {}) {
  const held = rows.filter((row) => BigInt(row.amount || 0n) > 0n);
  const sorted = held.slice().sort((a, b) => {
    const av = a.usd == null ? -1 : a.usd;
    const bv = b.usd == null ? -1 : b.usd;
    if (av !== bv) return bv - av;
    return String(a.symbol).localeCompare(String(b.symbol));
  });
  const small = (row) => row.usd == null || row.usd < dust;
  const visible = showSmall ? sorted : sorted.filter((row) => !small(row));
  const hiddenSmall = sorted.length - visible.length;
  const total = sorted.reduce((sum, row) => sum + (row.usd || 0), 0);
  const shown = expanded ? visible : visible.slice(0, top);
  return { rows: visible, shown, hiddenSmall, more: visible.length - shown.length, total, count: visible.length };
}

/**
 * Group positions by protocol. Each position: { protocol, usd, debtUsd? }.
 * Returns groups sorted by value with { id, name, logo, usd, positions }.
 */
export function groupPositions(positions) {
  const groups = new Map();
  for (const row of positions) {
    const id = row.protocol || "other";
    const meta = PROTOCOLS[id] || { name: id, logo: "", order: 99 };
    if (!groups.has(id)) groups.set(id, { id, name: meta.name, logo: meta.logo, order: meta.order, usd: 0, unpriced: 0, positions: [] });
    const group = groups.get(id);
    group.positions.push(row);
    if (row.usd == null) group.unpriced += 1;
    else group.usd += row.usd;
  }
  const out = [...groups.values()];
  for (const group of out) group.positions.sort((a, b) => (b.usd || 0) - (a.usd || 0));
  out.sort((a, b) => (b.usd - a.usd) || (a.order - b.order));
  return out;
}

/** Sum USD over pieces [{ amount, decimals, price }]; null if any piece with a balance is unpriced. */
export function sumPieces(pieces) {
  let total = 0;
  let missing = false;
  for (const piece of pieces) {
    if (BigInt(piece.amount || 0n) === 0n) continue;
    const usd = usdOf(piece.amount, piece.decimals, piece.price);
    if (usd == null) missing = true;
    else total += usd;
  }
  return { usd: total, partial: missing };
}

/**
 * Aave DataProvider.getUserReserveData rows → supplied / borrowed lines.
 * reserve: { asset, symbol, decimals, price }, data: [aBal, stableDebt, variableDebt, …, collateral].
 */
export function aaveLines(reserves, datas) {
  const supplied = [];
  const borrowed = [];
  reserves.forEach((reserve, i) => {
    const data = datas[i];
    if (!data) return;
    const aBal = BigInt(data[0] || 0n);
    const debt = BigInt(data[1] || 0n) + BigInt(data[2] || 0n);
    const collateral = Boolean(data[8]);
    if (aBal > 0n) supplied.push({ ...reserve, amount: aBal, usd: usdOf(aBal, reserve.decimals, reserve.price), collateral });
    if (debt > 0n) borrowed.push({ ...reserve, amount: debt, usd: usdOf(debt, reserve.decimals, reserve.price) });
  });
  const sup = supplied.reduce((s, r) => s + (r.usd || 0), 0);
  const bor = borrowed.reduce((s, r) => s + (r.usd || 0), 0);
  return { supplied, borrowed, suppliedUsd: sup, borrowedUsd: bor, netUsd: sup - bor };
}

/** Aave health factor (1e18 fixed). Max uint means no debt. */
export function healthLabel(hf) {
  const n = BigInt(hf || 0n);
  if (n === 0n || n >= 10n ** 30n) return "No debt";
  const v = Number(n / 10n ** 14n) / 1e4;
  return `Health ${v.toFixed(2)}`;
}

/** Trading-reward day ids to check: today and the previous `days - 1`. */
export function recentDayIds(nowSec, days = 30) {
  const today = Math.floor(Number(nowSec) / 86400);
  return Array.from({ length: days }, (_, i) => today - i).filter((d) => d >= 0);
}

/** Display amount for a raw balance; never shows "0" for a non-zero dust balance. */
export function fmtRaw(amount, decimals) {
  const raw = BigInt(amount || 0n);
  if (raw === 0n) return "0";
  const n = toFloat(raw, decimals);
  return n === 0 ? "<0.0001" : fmtAmount(n);
}

/** "$1,234.56", "$0.42", "<$0.01", "—". */
export function fmtUsd(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  const neg = value < 0;
  const abs = Math.abs(value);
  if (abs > 0 && abs < 0.01) return `${neg ? "-" : ""}<$0.01`;
  const digits = abs >= 1000 ? 0 : 2;
  const text = abs.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${neg ? "-" : ""}$${text}`;
}

/** Unit price: "$1.23", "$0.00688", "$2.61e-9". */
export function fmtPrice(value) {
  if (value == null || !Number.isFinite(value) || value <= 0) return "—";
  if (value >= 0.01) return fmtUsd(value);
  if (value >= 1e-6) return `$${Number(value.toPrecision(3))}`;
  return `$${value.toExponential(2).replace("e-", "e-")}`;
}

/** Compact amount for display: 1.23M, 12.4K, 3.21, 0.0042. */
export function fmtAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs === 0) return "0";
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  if (abs >= 1) return n.toFixed(abs >= 100 ? 2 : 4).replace(/\.?0+$/, "");
  if (abs >= 0.0001) return n.toFixed(6).replace(/\.?0+$/, "");
  return "<0.0001";
}

/** Blockscout /api/v2/addresses/:a/token-balances → ERC-20 addresses. */
export function blockscoutErc20s(rows, limit = 120) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const token = row?.token || {};
    const type = String(token.type || "");
    if (type && type !== "ERC-20") continue;
    const address = token.address_hash || token.address;
    if (!isAddress(address)) continue;
    out.push(address);
    if (out.length >= limit) break;
  }
  return out;
}
