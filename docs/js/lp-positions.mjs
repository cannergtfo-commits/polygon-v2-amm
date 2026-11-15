/**
 * Liquidity-tab helpers: venue addresses, V2 pair candidates, concentrated
 * liquidity math, and manage-on-venue links. No network, no DOM, no keys.
 */

export const ZERO = "0x0000000000000000000000000000000000000000";
export const WPOL = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
export const BZB = "0x462D8d82C2B2D2DDabf7f8a93928De09d47A5807";
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const Q96 = 2n ** 96n;
export const Q128 = 2n ** 128n;

/** ERC-20 V2 factories the desk already quotes. */
export const LP_V2_FACTORIES = [
  { id: "blazar", name: "BlazarSwap", factory: "0x8e9663F4b15F3B291B1354e20d1B019d8864830F", removable: true },
  { id: "quickswap", name: "QuickSwap v2", factory: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32", removable: false },
  { id: "sushi", name: "SushiSwap", factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4", removable: false },
  { id: "apeswap", name: "ApeSwap", factory: "0xCf083Be4164828f00cAE704EC15a36D711491284", removable: false },
];

/**
 * NFT position managers, verified on Polygon against factory() and official docs.
 * Uniswap v3 NPM factory() = 0x1F98431c8aD98523631AE4a59f267346ea31F984.
 * QuickSwap v3 NPM factory() = Algebra v1 0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28.
 * QuickSwap v4 NPM factory() = Algebra Integral 0x134c1dBE4860A9cAaf89002574fFe814772D9904.
 */
export const LP_NFT_MANAGERS = [
  {
    id: "uniswap-v3",
    name: "Uniswap v3",
    kind: "uni-v3",
    manager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  },
  {
    id: "quickswap-v3",
    name: "QuickSwap v3",
    kind: "algebra",
    manager: "0x8eF88E4c7CfbbaC1C163f7eddd4B578792201de6",
    factory: "0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28",
  },
  {
    id: "quickswap-v4",
    name: "QuickSwap v4",
    kind: "algebra4",
    manager: "0x7219C5d9928DB34973b5397d0b6ef00622dD3E8f",
    factory: "0x134c1dBE4860A9cAaf89002574fFe814772D9904",
  },
];

export const DEFAULT_HUBS = [
  WPOL,
  BZB,
  "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
];

export function lower(address) {
  return String(address || "").toLowerCase();
}

export function isZero(address) {
  const key = lower(address);
  return !key || key === lower(ZERO);
}

export function pairKey(factory, a, b) {
  const x = lower(a);
  const y = lower(b);
  return `${lower(factory)}:${x < y ? x : y}:${x < y ? y : x}`;
}

/**
 * getPair queries for token-list (or held) tokens against quote hubs,
 * one per factory. getPair is commutative, so each unordered pair is
 * requested once. BlazarSwap is omitted: the desk still lists it via allPairs.
 */
export function v2CandidateQueries(tokens, hubs = DEFAULT_HUBS, factories = LP_V2_FACTORIES.filter((row) => !row.removable)) {
  const uniq = [];
  const seen = new Set();
  for (const address of [...tokens, ...hubs]) {
    const key = lower(address);
    if (!key || isZero(key) || seen.has(key)) continue;
    seen.add(key);
    uniq.push(address);
  }
  const hubSet = new Set(hubs.map(lower));
  const queries = [];
  const keys = new Set();
  for (const factory of factories) {
    for (const token of uniq) {
      for (const hub of hubs) {
        if (lower(token) === lower(hub)) continue;
        // Prefer pairing every listed token with a hub. Also allow hub-hub pairs
        // (USDC/WPOL, etc.) by iterating hubs as tokens too.
        if (!hubSet.has(lower(hub))) continue;
        const key = pairKey(factory.factory, token, hub);
        if (keys.has(key)) continue;
        keys.add(key);
        queries.push({ factory: factory.factory, venueId: factory.id, venue: factory.name, a: token, b: hub, key });
      }
    }
  }
  return queries;
}

export function v2ShareAndAmounts(balance, reserve0, reserve1, supply) {
  const bal = BigInt(balance || 0n);
  const r0 = BigInt(reserve0 || 0n);
  const r1 = BigInt(reserve1 || 0n);
  const tot = BigInt(supply || 0n);
  if (bal <= 0n || tot <= 0n) {
    return { amount0: 0n, amount1: 0n, shareBps: 0 };
  }
  return {
    amount0: (bal * r0) / tot,
    amount1: (bal * r1) / tot,
    shareBps: Number((bal * 10_000n) / tot) / 100,
  };
}

export function inRange(tick, tickLower, tickUpper) {
  const t = Number(tick);
  return t >= Number(tickLower) && t < Number(tickUpper);
}

export function isFullRange(tickLower, tickUpper) {
  return Number(tickLower) <= MIN_TICK && Number(tickUpper) >= MAX_TICK;
}

export function isOpenPosition(liquidity, owed0 = 0n, owed1 = 0n) {
  return BigInt(liquidity || 0n) > 0n || BigInt(owed0 || 0n) > 0n || BigInt(owed1 || 0n) > 0n;
}

/** Uniswap v3 / Algebra TickMath.getSqrtRatioAtTick, in JS bigint. */
export function getSqrtRatioAtTick(tick) {
  const t = Number(tick);
  if (!Number.isInteger(t) || t < MIN_TICK || t > MAX_TICK) throw new Error("tick out of range");
  const absTick = t < 0 ? -t : t;
  let ratio = (absTick & 0x1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  if (absTick & 0x2) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if (absTick & 0x4) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if (absTick & 0x8) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if (absTick & 0x10) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if (absTick & 0x20) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if (absTick & 0x40) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if (absTick & 0x80) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if (absTick & 0x100) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if (absTick & 0x200) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if (absTick & 0x400) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if (absTick & 0x800) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if (absTick & 0x1000) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if (absTick & 0x2000) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if (absTick & 0x4000) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if (absTick & 0x8000) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if (absTick & 0x10000) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if (absTick & 0x20000) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if (absTick & 0x40000) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if (absTick & 0x80000) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;
  if (t > 0) ratio = (2n ** 256n - 1n) / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

function amount0ForLiquidity(sqrtA, sqrtB, liquidity) {
  let a = BigInt(sqrtA);
  let b = BigInt(sqrtB);
  if (a > b) [a, b] = [b, a];
  if (a <= 0n || liquidity <= 0n) return 0n;
  return (liquidity * Q96 * (b - a)) / b / a;
}

function amount1ForLiquidity(sqrtA, sqrtB, liquidity) {
  let a = BigInt(sqrtA);
  let b = BigInt(sqrtB);
  if (a > b) [a, b] = [b, a];
  if (liquidity <= 0n) return 0n;
  return (liquidity * (b - a)) / Q96;
}

/** Token amounts owed to a concentrated position at the current price. */
export function amountsForLiquidity(sqrtPriceX96, tickLower, tickUpper, liquidity) {
  const L = BigInt(liquidity || 0n);
  if (L <= 0n) return { amount0: 0n, amount1: 0n };
  const sqrt = BigInt(sqrtPriceX96);
  const sqrtA = getSqrtRatioAtTick(tickLower);
  const sqrtB = getSqrtRatioAtTick(tickUpper);
  if (sqrt <= sqrtA) return { amount0: amount0ForLiquidity(sqrtA, sqrtB, L), amount1: 0n };
  if (sqrt < sqrtB) {
    return {
      amount0: amount0ForLiquidity(sqrt, sqrtB, L),
      amount1: amount1ForLiquidity(sqrtA, sqrt, L),
    };
  }
  return { amount0: 0n, amount1: amount1ForLiquidity(sqrtA, sqrtB, L) };
}

export function feeLabel(fee, { alreadyPercent = false } = {}) {
  const n = Number(fee);
  if (!Number.isFinite(n) || n < 0) return "";
  const pct = alreadyPercent ? n : n / 10_000;
  const text = pct >= 1 ? pct.toFixed(2).replace(/\.?0+$/, "") : String(Number(pct.toFixed(4)));
  return `${text}%`;
}

export function rangeLabel({ tickLower, tickUpper, tick, inRange: inside }) {
  if (isFullRange(tickLower, tickUpper)) {
    return inside ? "Full range · in range" : "Full range · out of range";
  }
  return `Ticks ${tickLower} to ${tickUpper} (current ${tick}) · ${inside ? "in range" : "out of range"}`;
}

export function manageUrl(venueId, { tokenId, token0, token1, pair, pool } = {}) {
  if (venueId === "uniswap-v3" && tokenId != null) {
    return `https://app.uniswap.org/positions/v3/polygon/${tokenId}`;
  }
  if (venueId === "quickswap-v3" && tokenId != null) {
    return `https://quickswap.exchange/#/pool/${tokenId}`;
  }
  if (venueId === "quickswap-v4") {
    if (tokenId != null) return `https://quickswap.exchange/#/pool/${tokenId}`;
    if (pool) return `https://quickswap.exchange/#/info/pool/${pool}`;
    return "https://quickswap.exchange/#/pools";
  }
  if (venueId === "quickswap" && token0 && token1) {
    return `https://quickswap.exchange/#/remove/${token0}/${token1}`;
  }
  if (venueId === "sushi") {
    return pair
      ? `https://www.sushi.com/polygon/pool/v2/${pair}`
      : "https://www.sushi.com/polygon/pool";
  }
  if (venueId === "apeswap" && token0 && token1) {
    return `https://apeswap.finance/remove-liquidity/${token0}/${token1}`;
  }
  return "";
}

export function countLabel(rows) {
  if (!rows.length) return "No liquidity in this wallet yet.";
  const tallies = new Map();
  for (const row of rows) {
    const name = row.venue || "Other";
    tallies.set(name, (tallies.get(name) || 0) + 1);
  }
  return [...tallies.entries()].map(([name, n]) => `${n} ${name}`).join(" · ");
}

export const NO_ROUTE_VENUES = "Blazar, QuickSwap, Sushi, Ape, Uniswap v3, QuickSwap v3, or QuickSwap v4";
