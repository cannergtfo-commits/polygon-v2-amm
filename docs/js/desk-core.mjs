/**
 * Pure desk logic for the static homepage.
 * Routing, staking calldata plans, and leaderboard accounting.
 * No network, no DOM, no secret RPC URLs.
 */

export const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const ZERO = "0x0000000000000000000000000000000000000000";
export const WPOL = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
export const BZB = "0x462D8d82C2B2D2DDabf7f8a93928De09d47A5807";
export const FEE_ROUTER = "0x014AC678c96dd5dFAEc78BfffD8E00EEbf117E9b";
export const STAKING = "0x3Aa4a59deC4F677A138857a828220eEd259b2469";
export const REWARDS = "0x323DCb75A4f265D26dd3f5F203e12e7625d49951";
export const BLAZAR_FACTORY = "0x8e9663F4b15F3B291B1354e20d1B019d8864830F";
export const CHAIN_ID = 137;
export const NO_PATCH = (1n << 256n) - 1n;
export const MAX_UINT = (1n << 256n) - 1n;
export const BPS = 10_000n;
export const QUOTE_TTL_MS = 20_000;
export const DEADLINE_SEC = 90;
export const MAX_DEADLINE_WINDOW = 180;
export const MIN_TRADE_USD_E8 = 25n * 10n ** 8n;
export const WALLET_DAY_CAP_USD_E8 = 50_000n * 10n ** 8n;
export const ROUND_TRIP_SEC = 600;
export const FEED_MAX_AGE_SEC = 86_400;
export const SWAP_TOPIC = "0x46714498ab5bcc604f279ecb3f0caca88a385b3c9c109db2e94b9d098dc0c5e7";

/** Ranks 1–25. Same table as BlazarDailyRewards.shareBps. Empty ranks are not filled. */
export const SHARE_BPS = [
  1500, 1000, 500, 464, 450, 436, 422, 409, 395, 381, 367, 353, 339, 326, 312, 297, 283, 269, 255, 242, 228, 214, 200, 186, 172,
];

/**
 * Candidate adapters. A live quote still has to see the factory fee or target
 * flag on the deployed router. These addresses are the reviewed allowlist.
 */
export const VENUES = {
  v2: [
    { id: "blazar", name: "BlazarSwap", factory: BLAZAR_FACTORY, feeBps: 30 },
    { id: "quickswap", name: "QuickSwap v2", factory: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32", feeBps: 30 },
    { id: "sushi", name: "SushiSwap", factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4", feeBps: 30 },
    { id: "apeswap", name: "ApeSwap", factory: "0xCf083Be4164828f00cAE704EC15a36D711491284", feeBps: 30 },
  ],
  targets: [
    {
      id: "uniswap-v3",
      name: "Uniswap v3",
      kind: "v3",
      router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      feeTiers: [100, 500, 3000, 10000],
    },
    {
      id: "algebra",
      name: "QuickSwap v3",
      kind: "algebra",
      router: "0xf5b509bB0909a69B1c207E495f687a596C168E12",
      quoter: "0xa15F0D7377B2A0C0c10db057f641beD21028FC89",
      factory: "0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28",
    },
  ],
};

export const HUBS = [
  WPOL,
  "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
];

export const FEEDS = {
  [WPOL.toLowerCase()]: { aggregator: "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0", tokenDecimals: 18, priceDecimals: 8 },
  ["0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"]: { aggregator: "0xF9680D99D6C9589e2a93a78A04A279e509205945", tokenDecimals: 18, priceDecimals: 8 },
  ["0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"]: { aggregator: "0xc907E116054Ad103354f2D350FD2514433D57F6f", tokenDecimals: 8, priceDecimals: 8 },
  ["0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"]: { aggregator: "0xfE4A8cc5b5B2366C1B58Bea3858e81843581b2F7", tokenDecimals: 6, priceDecimals: 8 },
  ["0xc2132d05d31c914a87c6611c10748aeb04b58e8f"]: { aggregator: "0x0A6513e40db6EB1b165753AD52E80663aeA50545", tokenDecimals: 6, priceDecimals: 8 },
};

export const TOKENS = [
  { symbol: "BZB", name: "BlazarBits", address: BZB, decimals: 18 },
  { symbol: "POL", name: "Polygon", address: NATIVE, decimals: 18, native: true },
  { symbol: "WPOL", name: "Wrapped POL", address: WPOL, decimals: 18 },
  { symbol: "USDC", name: "USD Coin", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
  { symbol: "USDC.e", name: "Bridged USDC", address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6 },
  { symbol: "USDT", name: "Tether USD", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },
  { symbol: "WETH", name: "Wrapped Ether", address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
  { symbol: "WBTC", name: "Wrapped BTC", address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", decimals: 8 },
  { symbol: "BBY", name: "BlazarByte", address: "0xb837f0e111596348A27e424e43938eb01753cf34", decimals: 9 },
];

const COVERAGE = {
  searched: "Allowlisted V2 factories (BlazarSwap, QuickSwap v2, SushiSwap, ApeSwap) and, only when the router allowlist includes them, Uniswap v3 and QuickSwap v3.",
  discovery: "Pools are the pairs among the tokens on this desk, including one- and two-hop routes through WPOL, USDC, USDC.e, USDT, WETH, and WBTC, plus a two-venue V2 split when it beats the best single pool.",
  notCovered: "Balancer, Curve, Uniswap v4, order books, and any router that is not on the fee-router allowlist are not quoted and cannot be called. This is not every pool on Polygon.",
};

export function coverageText() {
  return COVERAGE;
}

export function lower(address) {
  return String(address || "").toLowerCase();
}

export function isNative(address) {
  const key = lower(address);
  return key === lower(NATIVE) || key === lower(ZERO);
}

export function poolToken(address, wpol = WPOL) {
  return isNative(address) ? wpol : address;
}

export function canonicalAsset(address, wpol = WPOL) {
  return isNative(address) ? lower(wpol) : lower(address);
}

export function sameAsset(a, b, wpol = WPOL) {
  return canonicalAsset(a, wpol) === canonicalAsset(b, wpol);
}

export function wrapDirection(tokenIn, tokenOut, wpol = WPOL) {
  if (isNative(tokenIn) && lower(tokenOut) === lower(wpol)) return "wrap";
  if (lower(tokenIn) === lower(wpol) && isNative(tokenOut)) return "unwrap";
  return null;
}

export function wrapTx(tokenIn, tokenOut, amount, wpol = WPOL) {
  const direction = wrapDirection(tokenIn, tokenOut, wpol);
  if (!direction) return null;
  if (amount <= 0n) throw new Error("Enter an amount");
  if (direction === "wrap") return { direction, to: wpol, data: "0xd0e30db0", value: amount };
  return { direction, to: wpol, data: `0x2e1a7d4d${amount.toString(16).padStart(64, "0")}`, value: 0n };
}

export function quoteV2(amountIn, reserveIn, reserveOut, feeBps) {
  const fee = BigInt(feeBps);
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n || fee >= BPS) return 0n;
  const withFee = amountIn * (BPS - fee);
  const out = (withFee * reserveOut) / (reserveIn * BPS + withFee);
  return out > 0n && out < reserveOut ? out : 0n;
}

export function wrapperOnSpend(amount, unpaid, external, feeBps) {
  const unpaidTaken = unpaid <= 0n ? 0n : unpaid > amount ? amount : unpaid;
  if (!external || feeBps <= 0 || unpaidTaken === 0n || amount === 0n) {
    return { net: amount, fee: 0n, unpaidTaken };
  }
  const fee = (unpaidTaken * BigInt(feeBps)) / BPS;
  return { net: amount - fee, fee, unpaidTaken };
}

export function unpaidCarried(external, spendGross, amountOut, unpaidTaken) {
  if (external || spendGross === 0n || unpaidTaken === 0n || amountOut <= 0n) return 0n;
  return (amountOut * unpaidTaken) / spendGross;
}

export function minBuy(quotedOut, slippageBps) {
  const slip = BigInt(slippageBps);
  if (slip < 0n || slip > 2_000n) throw new Error("Slippage must be between 0 and 20%");
  if (quotedOut <= 0n) throw new Error("Quoted output is empty");
  const min = (quotedOut * (BPS - slip)) / BPS;
  if (min <= 0n) throw new Error("Quoted hop is too small to set a minimum");
  return min;
}

export function parseUnits(raw, decimals) {
  const v = String(raw ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(v)) throw new Error("Enter a plain amount");
  const [whole, frac = ""] = v.split(".");
  if (frac.length > decimals) throw new Error("Too many decimal places");
  const digits = whole + frac.padEnd(decimals, "0");
  const amount = BigInt(digits);
  if (amount <= 0n) throw new Error("Enter an amount");
  if (amount === MAX_UINT) throw new Error("Amount is too large");
  return amount;
}

export function formatUnits(amount, decimals, maxFrac = 6) {
  const neg = amount < 0n;
  const value = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fracFull = (value % base).toString().padStart(decimals, "0");
  const frac = fracFull.slice(0, maxFrac).replace(/0+$/, "");
  const text = frac ? `${whole.toString()}.${frac}` : whole.toString();
  return neg ? `-${text}` : text;
}

export function formatUsdE8(amount) {
  return formatUnits(amount, 8, 2);
}

export function quoteFresh(quotedAtMs, nowMs, ttlMs = QUOTE_TTL_MS) {
  return Number.isFinite(quotedAtMs) && Number.isFinite(nowMs) && nowMs >= quotedAtMs && nowMs - quotedAtMs <= ttlMs;
}

export function deadlineFor(blockTime, seconds = DEADLINE_SEC) {
  const deadline = BigInt(blockTime) + BigInt(seconds);
  if (!deadlineOk(deadline, blockTime)) throw new Error("Deadline is outside the router window");
  return deadline;
}

export function deadlineOk(deadline, blockTime) {
  const d = BigInt(deadline);
  const now = BigInt(blockTime);
  return d > now && d <= now + BigInt(MAX_DEADLINE_WINDOW);
}

export function quoteStillTradable(shownOut, freshOut, slippageBps) {
  if (shownOut <= 0n || freshOut <= 0n) return false;
  return freshOut >= minBuy(shownOut, slippageBps);
}

function pairKey(factory, a, b) {
  const [x, y] = [lower(a), lower(b)].sort();
  return `${lower(factory)}:${x}:${y}`;
}

function bookFrom(pairs) {
  const book = new Map();
  for (const pair of pairs) {
    if (pair.reserve0 <= 0n || pair.reserve1 <= 0n) continue;
    book.set(pairKey(pair.factory, pair.tokenA, pair.tokenB), pair);
  }
  return book;
}

function stateFor(book, factory, a, b) {
  return book.get(pairKey(factory, a, b)) || null;
}

function outOf(pair, tokenIn, amountIn) {
  const inIs0 = lower(tokenIn) === lower(pair.token0);
  return quoteV2(amountIn, inIs0 ? pair.reserve0 : pair.reserve1, inIs0 ? pair.reserve1 : pair.reserve0, pair.feeBps);
}

function isBlazar(factory, blazarFactory) {
  return lower(factory) === lower(blazarFactory);
}

function v2Step(pair, tokenIn, tokenOut, bps, useBalance, fee, quotedOut) {
  return {
    kind: "v2",
    venue: pair.venue,
    factory: pair.factory,
    router: null,
    feeTier: null,
    feeBps: pair.feeBps,
    tokenIn,
    tokenOut,
    pool: pair.pair,
    bps,
    useBalance,
    wrapperFee: fee,
    quotedOut,
  };
}

export function bestV2(pairs, tokenIn, tokenOut, amountIn, feeBps, unpaid, blazarFactory, venues = VENUES.v2) {
  const book = bookFrom(pairs);
  let best = null;
  for (const venue of venues) {
    const pair = stateFor(book, venue.factory, tokenIn, tokenOut);
    if (!pair) continue;
    const external = !isBlazar(venue.factory, blazarFactory);
    const charged = wrapperOnSpend(amountIn, unpaid, external, feeBps);
    const amountOut = outOf(pair, tokenIn, charged.net);
    if (amountOut <= 0n) continue;
    if (!best || amountOut > best.amountOut) {
      best = {
        amountOut,
        unpaidOut: unpaidCarried(external, amountIn, amountOut, charged.unpaidTaken),
        step: v2Step(pair, tokenIn, tokenOut, 10_000, false, charged.fee, amountOut),
      };
    }
  }
  return best;
}

export function allV2(pairs, tokenIn, tokenOut, amountIn, feeBps, unpaid, blazarFactory, venues = VENUES.v2) {
  const book = bookFrom(pairs);
  const legs = [];
  for (const venue of venues) {
    const pair = stateFor(book, venue.factory, tokenIn, tokenOut);
    if (!pair) continue;
    const external = !isBlazar(venue.factory, blazarFactory);
    const charged = wrapperOnSpend(amountIn, unpaid, external, feeBps);
    const amountOut = outOf(pair, tokenIn, charged.net);
    if (amountOut <= 0n) continue;
    legs.push({
      amountOut,
      unpaidOut: unpaidCarried(external, amountIn, amountOut, charged.unpaidTaken),
      step: v2Step(pair, tokenIn, tokenOut, 10_000, false, charged.fee, amountOut),
    });
  }
  return legs.sort((a, b) => (a.amountOut > b.amountOut ? -1 : 1));
}

export function splitV2(pairs, tokenIn, tokenOut, amountIn, feeBps, blazarFactory, venues = VENUES.v2) {
  const directs = allV2(pairs, tokenIn, tokenOut, amountIn, feeBps, amountIn, blazarFactory, venues);
  if (directs.length < 2) return null;
  const book = bookFrom(pairs);
  const a = directs[0];
  const b = directs[1];
  const stateA = stateFor(book, a.step.factory, tokenIn, tokenOut);
  const stateB = stateFor(book, b.step.factory, tokenIn, tokenOut);
  let bestOut = 0n;
  let bestBps = 0;
  let feeA = 0n;
  let feeB = 0n;
  let outA = 0n;
  let outB = 0n;
  for (const bps of [1500, 3000, 4000, 5000, 6000, 7000, 8500]) {
    const first = (amountIn * BigInt(bps)) / BPS;
    const second = amountIn - first;
    const chargedA = wrapperOnSpend(first, first, !isBlazar(stateA.factory, blazarFactory), feeBps);
    const chargedB = wrapperOnSpend(second, second, !isBlazar(stateB.factory, blazarFactory), feeBps);
    const left = outOf(stateA, tokenIn, chargedA.net);
    const right = outOf(stateB, tokenIn, chargedB.net);
    const out = left + right;
    if (out > bestOut) {
      bestOut = out;
      bestBps = bps;
      feeA = chargedA.fee;
      feeB = chargedB.fee;
      outA = left;
      outB = right;
    }
  }
  const single = a.amountOut > b.amountOut ? a.amountOut : b.amountOut;
  if (bestOut * BPS <= single * 10_015n) return null;
  return {
    amountOut: bestOut,
    steps: [
      { ...a.step, bps: bestBps, useBalance: false, wrapperFee: feeA, quotedOut: outA },
      { ...b.step, bps: 10_000, useBalance: false, wrapperFee: feeB, quotedOut: outB },
    ],
  };
}

export function twoHopV2(pairs, tokenIn, tokenOut, hubs, amountIn, feeBps, blazarFactory, venues = VENUES.v2) {
  const routes = [];
  for (const hub of hubs) {
    if (sameAsset(hub, tokenIn) || sameAsset(hub, tokenOut)) continue;
    const first = bestV2(pairs, tokenIn, hub, amountIn, feeBps, amountIn, blazarFactory, venues);
    if (!first) continue;
    const second = bestV2(pairs, hub, tokenOut, first.amountOut, feeBps, first.unpaidOut, blazarFactory, venues);
    if (!second) continue;
    routes.push({
      amountOut: second.amountOut,
      steps: [first.step, { ...second.step, useBalance: true }],
    });
  }
  return routes;
}

export function externalLeg(quote, feeBps, unpaid) {
  const charged = wrapperOnSpend(quote.amountIn, unpaid, true, feeBps);
  if (charged.net !== quote.amountIn) throw new Error("Concentrated quote must be priced on the net amount");
  return {
    amountOut: quote.amountOut,
    unpaidOut: 0n,
    step: {
      kind: quote.kind,
      venue: quote.venue,
      factory: null,
      router: quote.router,
      feeTier: quote.feeTier ?? null,
      feeBps: quote.feeBps ?? null,
      tokenIn: quote.tokenIn,
      tokenOut: quote.tokenOut,
      pool: quote.pool ?? null,
      bps: 10_000,
      useBalance: false,
      wrapperFee: charged.fee,
      quotedOut: quote.amountOut,
    },
  };
}

export function routeId(steps) {
  return steps
    .map((step) => `${step.kind}:${step.venue}:${step.feeTier ?? step.feeBps}:${step.bps}:${lower(step.tokenIn)}:${lower(step.tokenOut)}`)
    .join(">");
}

export function routeLabel(steps) {
  const split = steps.length === 2 && !steps[0].useBalance && !steps[1].useBalance && lower(steps[0].tokenOut) === lower(steps[1].tokenOut);
  if (split) return `${steps[0].venue} ${steps[0].bps / 100}% + ${steps[1].venue} ${(10_000 - steps[0].bps) / 100}%`;
  return steps
    .map((step) => {
      if (step.kind === "v3" && step.feeTier) return `${step.venue} ${(step.feeTier / 10_000).toFixed(2)}%`;
      if (step.kind === "algebra") return `${step.venue}`;
      return step.venue;
    })
    .join(" → ");
}

export function gasUnits(steps) {
  return steps.reduce((gas, step) => gas + (step.kind === "v2" ? 120_000 : 175_000), 190_000);
}

export function gasCostOut(steps, gasPrice, outputPerPol) {
  if (!outputPerPol || outputPerPol <= 0n || gasPrice <= 0n) return null;
  return (outputPerPol * gasPrice * BigInt(gasUnits(steps))) / 10n ** 18n;
}

export function rankRoutes(routes, { gasPrice = 0n, outputPerPol = null } = {}) {
  const priced = routes
    .filter((route) => route.amountOut > 0n && route.steps.length > 0 && route.steps.length <= 8)
    .map((route) => {
      const gas = gasCostOut(route.steps, gasPrice, outputPerPol);
      const net = gas === null ? route.amountOut : route.amountOut > gas ? route.amountOut - gas : 0n;
      return { ...route, gasCost: gas, net };
    });
  priced.sort((a, b) => {
    if (a.net === b.net) return a.steps.length - b.steps.length;
    return a.net > b.net ? -1 : 1;
  });
  return priced;
}

export function collectRoutes({ pairs, tokenIn, tokenOut, hubs, amountIn, feeBps, blazarFactory, venues, concentrated = [] }) {
  const sell = poolToken(tokenIn);
  const buy = poolToken(tokenOut);
  if (sameAsset(sell, buy)) throw new Error("Choose two different tokens. POL and WPOL are the same asset once wrapped.");
  const routes = [];
  for (const leg of allV2(pairs, sell, buy, amountIn, feeBps, amountIn, blazarFactory, venues)) {
    routes.push({ amountOut: leg.amountOut, steps: [leg.step] });
  }
  const split = splitV2(pairs, sell, buy, amountIn, feeBps, blazarFactory, venues);
  if (split) routes.push(split);
  routes.push(...twoHopV2(pairs, sell, buy, hubs, amountIn, feeBps, blazarFactory, venues));
  for (const quote of concentrated) {
    if (quote.amountOut > 0n && quote.steps?.length) routes.push(quote);
  }
  return routes;
}

export function pricedExternal({ tokenIn, tokenOut, gross, unpaid, feeBps, quotedOut, venue, router, kind, feeTier = null, pool = null, useBalance = false }) {
  const charged = wrapperOnSpend(gross, unpaid, true, feeBps);
  if (quotedOut <= 0n || charged.net <= 0n) return null;
  return {
    amountOut: quotedOut,
    steps: [
      {
        kind,
        venue,
        factory: null,
        router,
        feeTier,
        feeBps: feeTier ? Math.round(feeTier / 100) : null,
        tokenIn,
        tokenOut,
        pool,
        bps: 10_000,
        useBalance,
        wrapperFee: charged.fee,
        quotedOut,
        quotedNetIn: charged.net,
      },
    ],
  };
}

export function enabledVenues(chain) {
  const v2 = VENUES.v2.filter((venue) => Number(chain.v2FeeBps?.[lower(venue.factory)] || 0) > 0).map((venue) => ({
    ...venue,
    feeBps: Number(chain.v2FeeBps[lower(venue.factory)]),
  }));
  const targets = VENUES.targets.filter((venue) => chain.allowedTarget?.[lower(venue.router)] === true);
  return { v2, targets };
}

export function v3Tiers(tokenIn, tokenOut) {
  const wpol = lower(WPOL);
  return lower(tokenIn) === wpol || lower(tokenOut) === wpol ? [100, 500, 3000] : [500, 3000];
}

export function targetPlan(step, feeRouter, deadline, hopMin) {
  if (step.kind === "v2" || !step.router) return null;
  if (step.kind === "v3") {
    return {
      kind: 0,
      target: step.router,
      functionName: "exactInputSingle",
      args: {
        tokenIn: poolToken(step.tokenIn),
        tokenOut: poolToken(step.tokenOut),
        fee: step.feeTier,
        recipient: feeRouter,
        amountIn: 0n,
        amountOutMinimum: hopMin,
        sqrtPriceLimitX96: 0n,
      },
      amountOffset: 132n,
      minOffset: 164n,
    };
  }
  if (step.kind === "algebra") {
    return {
      kind: 0,
      target: step.router,
      functionName: "exactInputSingle",
      args: {
        tokenIn: poolToken(step.tokenIn),
        tokenOut: poolToken(step.tokenOut),
        recipient: feeRouter,
        deadline,
        amountIn: 0n,
        amountOutMinimum: hopMin,
        limitSqrtPrice: 0n,
      },
      amountOffset: 132n,
      minOffset: 164n,
    };
  }
  throw new Error("Unsupported router adapter");
}

export function buildCalls(steps, feeRouter, deadline, slippageBps) {
  if (!steps.length || steps.length > 8) throw new Error("Route length is not executable");
  return steps.map((step) => {
    const hopMin = minBuy(step.quotedOut, slippageBps);
    if (step.kind === "v2") {
      if (!step.factory) throw new Error("V2 step is missing a factory");
      return {
        kind: 1,
        target: step.factory,
        spendToken: poolToken(step.tokenIn),
        v2TokenOut: poolToken(step.tokenOut),
        bps: step.bps,
        useBalance: !!step.useBalance,
        minBuy: hopMin,
        amountOffset: NO_PATCH,
        minOffset: NO_PATCH,
        data: "0x",
      };
    }
    const plan = targetPlan(step, feeRouter, deadline, hopMin);
    if (!plan) throw new Error("Router step is missing a target");
    return {
      kind: 0,
      target: plan.target,
      spendToken: poolToken(step.tokenIn),
      v2TokenOut: poolToken(step.tokenOut),
      bps: step.bps,
      useBalance: !!step.useBalance,
      minBuy: hopMin,
      amountOffset: plan.amountOffset,
      minOffset: plan.minOffset,
      data: null,
      plan,
    };
  });
}

export function sweepTokens(steps, outputToken) {
  const measure = lower(poolToken(outputToken));
  const mids = [];
  for (let i = 0; i < steps.length - 1; i++) {
    if (steps[i + 1]?.useBalance) {
      const token = poolToken(steps[i].tokenOut);
      if (lower(token) !== measure && !mids.some((item) => lower(item) === lower(token))) mids.push(token);
    }
  }
  return mids.slice(0, 6);
}

export function swapPlan({ tokenIn, tokenOut, amountIn, steps, recipient, blockTime, slippageBps, feeRouter = FEE_ROUTER }) {
  if (sameAsset(tokenIn, tokenOut)) throw new Error("Choose two different tokens");
  if (amountIn <= 0n) throw new Error("Enter an amount");
  const deadline = deadlineFor(blockTime);
  const calls = buildCalls(steps, feeRouter, deadline, slippageBps);
  const quotedOut = steps[steps.length - 1] && steps.every((step) => !step.useBalance) && steps.length > 1
    ? steps.reduce((sum, step) => sum + step.quotedOut, 0n)
    : steps[steps.length - 1].quotedOut;
  const minAmountOut = minBuy(quotedOut, slippageBps);
  const nativeIn = isNative(tokenIn);
  const nativeOut = isNative(tokenOut);
  return {
    tokenIn: nativeIn ? NATIVE : tokenIn,
    tokenOut: nativeOut ? NATIVE : tokenOut,
    amountIn,
    minAmountOut,
    recipient,
    deadline,
    unwrapNative: nativeOut,
    calls,
    sweep: sweepTokens(steps, tokenOut),
    value: nativeIn ? amountIn : 0n,
    feeRouter,
  };
}

export function approvalPlan(allowance, amount) {
  if (amount <= 0n) throw new Error("Enter an amount");
  if (amount >= MAX_UINT) throw new Error("Refusing an unlimited amount");
  if (allowance >= amount) return [];
  if (allowance > 0n) return [0n, amount];
  return [amount];
}

export function executionGate(input) {
  const errors = [];
  if (Number(input.chainId) !== CHAIN_ID) errors.push("Switch to Polygon PoS before sending.");
  if (!input.code || input.code === "0x") errors.push("Contract has no code at the reviewed address.");
  if (input.paused && (input.action === "swap" || input.action === "stake")) errors.push("That contract is paused.");
  if (input.action === "swap" && !input.quoteFresh) errors.push("Quote expired. Refresh it before signing.");
  if (input.action === "swap" && input.stale) errors.push("The pool moved past your slippage. The old quote will not be sent.");
  if (!input.simulationOk) errors.push("Simulation failed. Nothing was sent.");
  if (input.walletReject) errors.push("Wallet rejected the request.");
  return { ok: errors.length === 0, errors };
}

export function stakingAbi() {
  return [
    { type: "function", name: "stake", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
    { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
    { type: "function", name: "getReward", stateMutability: "nonpayable", inputs: [], outputs: [] },
  ];
}

export function erc20ApproveAbi() {
  return [
    { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  ];
}

export function rewardsClaimAbi() {
  return [
    { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ name: "dayId", type: "uint256" }], outputs: [{ type: "uint256" }] },
  ];
}

export function stakePlan(amount) {
  if (amount <= 0n || amount >= MAX_UINT) throw new Error("Enter a stake amount");
  return { functionName: "stake", args: [amount] };
}

export function withdrawPlan(amount) {
  if (amount <= 0n || amount >= MAX_UINT) throw new Error("Enter a withdraw amount");
  return { functionName: "withdraw", args: [amount] };
}

export function claimStakePlan() {
  return { functionName: "getReward", args: [] };
}

function reviewedSpender(spender) {
  if (lower(spender) !== lower(STAKING) && lower(spender) !== lower(FEE_ROUTER) && lower(spender) !== lower(REWARDS)) {
    throw new Error("Approval spender is not a reviewed contract");
  }
}

export function approvePlan(spender, amount) {
  reviewedSpender(spender);
  if (amount <= 0n || amount >= MAX_UINT) throw new Error("Approval must be the exact amount");
  return { functionName: "approve", args: [spender, amount] };
}

export function approveZeroPlan(spender) {
  reviewedSpender(spender);
  return { functionName: "approve", args: [spender, 0n] };
}

export function claimRewardPlan(dayId) {
  if (dayId < 0n) throw new Error("Bad day");
  return { functionName: "claim", args: [dayId] };
}

export function trustedUsdE8({ amount, answer, updatedAt, blockTime, maxAge = FEED_MAX_AGE_SEC, answeredInRound = 1n, roundId = 1n, priceDecimals = 8, tokenDecimals = 18 }) {
  const qty = BigInt(amount);
  const price = BigInt(answer);
  const updated = BigInt(updatedAt);
  const when = BigInt(blockTime);
  const age = BigInt(maxAge);
  const answered = BigInt(answeredInRound);
  const round = BigInt(roundId);
  if (qty <= 0n) return 0n;
  if (price <= 0n || updated <= 0n || updated > when) return 0n;
  if (when - updated > age) return 0n;
  if (answered < round) return 0n;
  const scale = BigInt(priceDecimals) + BigInt(tokenDecimals);
  if (scale >= 8n) return (price * qty) / 10n ** (scale - 8n);
  return price * qty * 10n ** (8n - scale);
}

export function scoreTrade(trade) {
  const inputFeed = FEEDS[canonicalAsset(trade.tokenIn)];
  const outputFeed = FEEDS[canonicalAsset(trade.tokenOut)];
  const feed = inputFeed || outputFeed;
  const amount = inputFeed ? (trade.consumed ?? trade.amountIn ?? 0n) : (trade.amountOut ?? 0n);
  if (!feed || amount <= 0n) return 0n;
  return trustedUsdE8({
    amount,
    answer: trade.answer,
    updatedAt: trade.updatedAt,
    blockTime: trade.blockTime,
    maxAge: trade.maxAge,
    answeredInRound: trade.answeredInRound,
    roundId: trade.roundId,
    priceDecimals: feed.priceDecimals,
    tokenDecimals: feed.tokenDecimals,
  });
}

export function subtractRoundTrips(trades, windowSec = ROUND_TRIP_SEC, wpol = WPOL) {
  const counted = trades.map((trade) => ({
    ...trade,
    assetIn: canonicalAsset(trade.tokenIn, wpol),
    assetOut: canonicalAsset(trade.tokenOut, wpol),
    score: trade.score,
  }));
  for (let i = 0; i < counted.length; i++) {
    for (let j = i + 1; j < counted.length; j++) {
      const a = counted[i];
      const b = counted[j];
      if (lower(a.trader) !== lower(b.trader)) continue;
      if (Math.abs(a.time - b.time) > windowSec) continue;
      if (!(a.assetIn === b.assetOut && a.assetOut === b.assetIn)) continue;
      const wash = a.score < b.score ? a.score : b.score;
      a.score -= wash;
      b.score -= wash;
    }
  }
  return counted;
}

export function applyWalletCap(trades, cap = WALLET_DAY_CAP_USD_E8) {
  const used = new Map();
  return [...trades]
    .sort((a, b) => a.time - b.time)
    .map((trade) => {
      const key = lower(trade.trader);
      const soFar = used.get(key) || 0n;
      const room = cap > soFar ? cap - soFar : 0n;
      const score = trade.score > room ? room : trade.score;
      used.set(key, soFar + score);
      return { ...trade, score };
    });
}

export function estimatedPayout(rankIndex, capBzb) {
  if (rankIndex < 0 || rankIndex >= SHARE_BPS.length) return 0n;
  return (capBzb * BigInt(SHARE_BPS[rankIndex])) / BPS;
}

export function buildDayBoard(trades, { capBzb, wpol = WPOL } = {}) {
  const scored = trades.map((trade) => ({ ...trade, score: trade.score ?? scoreTrade(trade) }));
  const netted = subtractRoundTrips(scored, ROUND_TRIP_SEC, wpol);
  const eligible = netted.filter((trade) => trade.score >= MIN_TRADE_USD_E8);
  const kept = applyWalletCap(eligible).filter((trade) => trade.score > 0n);
  const totals = new Map();
  for (const trade of kept) {
    const key = lower(trade.trader);
    totals.set(key, (totals.get(key) || 0n) + trade.score);
  }
  const ranked = [...totals.entries()].sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : a[1] > b[1] ? -1 : 1)).slice(0, 50);
  return ranked.map(([trader, scoreE8], index) => ({
    rank: index + 1,
    trader,
    scoreE8,
    estimatedBzb: estimatedPayout(index, capBzb),
    paidSlot: index < 25,
  }));
}

export function rewardState({ fundedBalance, posted, claimable }) {
  return {
    funded: fundedBalance > 0n,
    posted: !!posted,
    claimable: claimable > 0n ? claimable : 0n,
    estimateIsPayment: false,
  };
}

export function shareTableSums() {
  return SHARE_BPS.reduce((sum, item) => sum + item, 0);
}

export function feedFor(token) {
  return FEEDS[canonicalAsset(token)] || null;
}
