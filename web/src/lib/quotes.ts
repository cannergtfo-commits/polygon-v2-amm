import { getAddress, type Address } from "viem";
import {
  algebraFactoryAbi,
  algebraQuoterAbi,
  erc20Abi,
  feeRouterAbi,
  uniFactoryAbi,
  uniQuoterAbi,
  v2FactoryAbi,
  v2PairAbi,
} from "@/lib/abis";
import { AsyncLocalStorage } from "node:async_hooks";
import { clientFor, publicClient } from "@/lib/chain";
import { mapSettled } from "@/lib/quote-budget";
import type { PublicClient } from "viem";

const rpcStore = new AsyncLocalStorage<PublicClient>();
const abortStore = new AsyncLocalStorage<AbortSignal>();

function rpc() {
  return rpcStore.getStore() ?? publicClient;
}

function rethrowIfAborted() {
  if (abortStore.getStore()?.aborted) throw new Error("Quote timed out.");
}
import { addresses, isDeployed, isNative, poolToken, registry, tokenByAddress } from "@/lib/registry";
import type { QuoteResponse, RouteQuote, Step, TokenMeta } from "@/lib/types";
import { unpaidCarried, wrapperOnSpend } from "@/lib/wrapper-fee";

const ZERO = "0x0000000000000000000000000000000000000000";
const BLAZAR_FACTORY = registry.v2.find((venue) => venue.id === "blazar")!.factory.toLowerCase();

function isBlazarFactory(factory: string | null | undefined) {
  return !!factory && factory.toLowerCase() === BLAZAR_FACTORY;
}

const MIX_HUBS = [registry.wpol, registry.tokens.find((t) => t.symbol === "USDC")!.address, registry.tokens.find((t) => t.symbol === "WETH")!.address];

type PairState = {
  pair: Address;
  token0: Address;
  reserve0: bigint;
  reserve1: bigint;
  feeBps: number;
  venue: string;
  factory: Address;
};

type Leg = { amountOut: bigint; unpaidOut: bigint; step: Step };

const bookCache = new Map<string, { at: number; book: Map<string, PairState> }>();

export function quoteV2(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: number) {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n || feeBps >= 10_000) return 0n;
  const withFee = amountIn * BigInt(10_000 - feeBps);
  const out = (withFee * reserveOut) / (reserveIn * 10_000n + withFee);
  return out > 0n && out < reserveOut ? out : 0n;
}

function key(factory: string, a: string, b: string) {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort();
  return `${factory.toLowerCase()}:${x}:${y}`;
}

function gasFor(steps: Step[]) {
  return steps.reduce((gas, step) => gas + (step.kind === "v2" ? 120_000 : 175_000), 190_000);
}

function routeId(steps: Step[]) {
  return steps.map((step) => `${step.kind}:${step.venue}:${step.feeTier ?? step.feeBps}:${step.bps}:${step.tokenIn}:${step.tokenOut}`).join(">");
}

function labelFor(steps: Step[]) {
  const split = steps.length === 2 && !steps[0].useBalance && !steps[1].useBalance && steps[0].tokenOut.toLowerCase() === steps[1].tokenOut.toLowerCase();
  if (split) return `${steps[0].venue} ${steps[0].bps / 100}% + ${steps[1].venue} ${(10_000 - steps[0].bps) / 100}%`;
  return steps
    .map((step) => {
      if (step.kind === "v3" && step.feeTier) return `${step.venue} ${(step.feeTier / 10_000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
      if (step.kind === "algebra") return `${step.venue} dynamic`;
      return step.venue;
    })
    .join(" → ");
}

async function mapPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>) {
  return mapSettled(items, size, (item) => fn(item));
}

async function resolveMeta(address: string): Promise<TokenMeta> {
  if (isNative(address)) {
    const pol = registry.tokens.find((token) => token.native)!;
    return { address: pol.address, symbol: pol.symbol, name: pol.name, decimals: pol.decimals, logo: pol.logo };
  }
  const known = tokenByAddress(address);
  if (known) return { address: getAddress(known.address), symbol: known.symbol, name: known.name, decimals: known.decimals, logo: known.logo };
  const checksum = getAddress(address);
  try {
    const [symbol, name, decimals] = await Promise.all([
      rpc().readContract({ address: checksum, abi: erc20Abi, functionName: "symbol" }),
      rpc().readContract({ address: checksum, abi: erc20Abi, functionName: "name" }),
      rpc().readContract({ address: checksum, abi: erc20Abi, functionName: "decimals" }),
    ]);
    return { address: checksum, symbol, name, decimals };
  } catch {
    rethrowIfAborted();
    return { address: checksum, symbol: `${checksum.slice(0, 6)}…${checksum.slice(-4)}`, name: "Custom token", decimals: 18 };
  }
}

async function loadBook(tokens: string[]) {
  const cacheKey = tokens.map((token) => token.toLowerCase()).sort().join(",");
  const hit = bookCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 15_000) return hit.book;
  const queries: { factory: Address; venue: string; feeBps: number; a: Address; b: Address }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      for (const venue of registry.v2) {
        queries.push({
          factory: venue.factory as Address,
          venue: venue.name,
          feeBps: venue.feeBps,
          a: tokens[i] as Address,
          b: tokens[j] as Address,
        });
      }
    }
  }
  const pairs = await rpc().multicall({
    allowFailure: true,
    contracts: queries.map((query) => ({
      address: query.factory,
      abi: v2FactoryAbi,
      functionName: "getPair" as const,
      args: [query.a, query.b] as const,
    })),
  });
  const found = queries
    .map((query, index) => ({ query, pair: pairs[index]?.status === "success" ? (pairs[index].result as Address) : ZERO }))
    .filter((row) => row.pair.toLowerCase() !== ZERO);
  const details = await rpc().multicall({
    allowFailure: true,
    contracts: found.flatMap((row) => [
      { address: row.pair, abi: v2PairAbi, functionName: "token0" as const },
      { address: row.pair, abi: v2PairAbi, functionName: "getReserves" as const },
    ]),
  });
  const book = new Map<string, PairState>();
  found.forEach((row, index) => {
    const token0 = details[index * 2];
    const reserves = details[index * 2 + 1];
    if (token0?.status !== "success" || reserves?.status !== "success") return;
    const [reserve0, reserve1] = reserves.result as readonly [bigint, bigint, number];
    if (reserve0 === 0n || reserve1 === 0n) return;
    const state: PairState = {
      pair: row.pair,
      token0: token0.result as Address,
      reserve0,
      reserve1,
      feeBps: row.query.feeBps,
      venue: row.query.venue,
      factory: row.query.factory,
    };
    book.set(key(row.query.factory, row.query.a, row.query.b), state);
  });
  if (bookCache.size > 32) {
    const oldest = [...bookCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) bookCache.delete(oldest[0]);
  }
  bookCache.set(cacheKey, { at: Date.now(), book });
  return book;
}

function stateFor(book: Map<string, PairState>, factory: string, a: string, b: string) {
  return book.get(key(factory, a, b)) ?? null;
}

function quoteState(state: PairState, tokenIn: string, amountIn: bigint) {
  const inIs0 = tokenIn.toLowerCase() === state.token0.toLowerCase();
  return quoteV2(amountIn, inIs0 ? state.reserve0 : state.reserve1, inIs0 ? state.reserve1 : state.reserve0, state.feeBps);
}

function v2Step(state: PairState, tokenIn: string, tokenOut: string, bps: number, useBalance: boolean, wrapperFee: bigint, quotedOut: bigint): Step {
  return {
    kind: "v2",
    venue: state.venue,
    factory: state.factory,
    router: null,
    feeTier: null,
    feeBps: state.feeBps,
    tokenIn,
    tokenOut,
    pool: state.pair,
    bps,
    useBalance,
    wrapperFee: wrapperFee.toString(),
    quotedOut: quotedOut.toString(),
  };
}

function bestV2(book: Map<string, PairState>, tokenIn: string, tokenOut: string, amountIn: bigint, feeBps: number, unpaid: bigint): Leg | null {
  let best: Leg | null = null;
  for (const venue of registry.v2) {
    const state = stateFor(book, venue.factory, tokenIn, tokenOut);
    if (!state) continue;
    const blazar = isBlazarFactory(venue.factory);
    const charged = wrapperOnSpend(amountIn, unpaid, !blazar, feeBps);
    const amountOut = quoteState(state, tokenIn, charged.net);
    if (amountOut <= 0n) continue;
    if (!best || amountOut > best.amountOut) {
      best = {
        amountOut,
        unpaidOut: unpaidCarried(!blazar, amountIn, amountOut, charged.unpaidTaken),
        step: v2Step(state, tokenIn, tokenOut, 10_000, false, charged.fee, amountOut),
      };
    }
  }
  return best;
}

function allV2(book: Map<string, PairState>, tokenIn: string, tokenOut: string, amountIn: bigint, feeBps: number, unpaid: bigint) {
  const legs: Leg[] = [];
  for (const venue of registry.v2) {
    const state = stateFor(book, venue.factory, tokenIn, tokenOut);
    if (!state) continue;
    const blazar = isBlazarFactory(venue.factory);
    const charged = wrapperOnSpend(amountIn, unpaid, !blazar, feeBps);
    const amountOut = quoteState(state, tokenIn, charged.net);
    if (amountOut > 0n) {
      legs.push({
        amountOut,
        unpaidOut: unpaidCarried(!blazar, amountIn, amountOut, charged.unpaidTaken),
        step: v2Step(state, tokenIn, tokenOut, 10_000, false, charged.fee, amountOut),
      });
    }
  }
  return legs.sort((a, b) => (a.amountOut > b.amountOut ? -1 : 1));
}

async function quoteUni(tokenIn: string, tokenOut: string, amountIn: bigint, fee: number) {
  try {
    const result = await rpc().readContract({
      address: registry.uniswapV3.quoter as Address,
      abi: uniQuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn: tokenIn as Address, tokenOut: tokenOut as Address, amountIn, fee, sqrtPriceLimitX96: 0n }],
    });
    return result[0];
  } catch {
    rethrowIfAborted();
    return 0n;
  }
}

async function quoteAlgebra(tokenIn: string, tokenOut: string, amountIn: bigint) {
  try {
    const result = await rpc().readContract({
      address: registry.algebra.quoter as Address,
      abi: algebraQuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [tokenIn as Address, tokenOut as Address, amountIn, 0n],
    });
    return { amountOut: result[0], fee: Number(result[1]) };
  } catch {
    rethrowIfAborted();
    return { amountOut: 0n, fee: 0 };
  }
}

async function poolForV3(tokenIn: string, tokenOut: string, fee: number) {
  try {
    const pool = await rpc().readContract({
      address: registry.uniswapV3.factory as Address,
      abi: uniFactoryAbi,
      functionName: "getPool",
      args: [tokenIn as Address, tokenOut as Address, fee],
    });
    return pool.toLowerCase() === ZERO ? null : pool;
  } catch {
    rethrowIfAborted();
    return null;
  }
}

async function poolForAlgebra(tokenIn: string, tokenOut: string) {
  try {
    const pool = await rpc().readContract({
      address: registry.algebra.factory as Address,
      abi: algebraFactoryAbi,
      functionName: "poolByPair",
      args: [tokenIn as Address, tokenOut as Address],
    });
    return pool.toLowerCase() === ZERO ? null : pool;
  } catch {
    rethrowIfAborted();
    return null;
  }
}

async function quoteConcentrated(tokenIn: string, tokenOut: string, amountIn: bigint, feeBps: number, unpaid: bigint): Promise<Leg[]> {
  const charged = wrapperOnSpend(amountIn, unpaid, true, feeBps);
  const tiers = tokenIn.toLowerCase() === registry.wpol.toLowerCase() || tokenOut.toLowerCase() === registry.wpol.toLowerCase() ? [100, 500, 3000] : [500, 3000];
  const jobs: Promise<Leg | null>[] = [
    ...tiers.map(async (fee) => {
      const amountOut = await quoteUni(tokenIn, tokenOut, charged.net, fee);
      if (amountOut <= 0n) return null;
      const pool = await poolForV3(tokenIn, tokenOut, fee);
      const step: Step = {
        kind: "v3",
        venue: registry.uniswapV3.name,
        factory: null,
        router: registry.uniswapV3.router,
        feeTier: fee,
        feeBps: fee / 100,
        tokenIn,
        tokenOut,
        pool,
        bps: 10_000,
        useBalance: false,
        wrapperFee: charged.fee.toString(),
        quotedOut: amountOut.toString(),
      };
      return { amountOut, unpaidOut: 0n, step };
    }),
    (async () => {
      const quoted = await quoteAlgebra(tokenIn, tokenOut, charged.net);
      if (quoted.amountOut <= 0n) return null;
      const pool = await poolForAlgebra(tokenIn, tokenOut);
      const step: Step = {
        kind: "algebra",
        venue: registry.algebra.name,
        factory: null,
        router: registry.algebra.router,
        feeTier: null,
        feeBps: quoted.fee ? Math.round(quoted.fee / 100) : null,
        tokenIn,
        tokenOut,
        pool,
        bps: 10_000,
        useBalance: false,
        wrapperFee: charged.fee.toString(),
        quotedOut: quoted.amountOut.toString(),
      };
      return { amountOut: quoted.amountOut, unpaidOut: 0n, step };
    })(),
  ];
  const legs = await mapPool(jobs, 4, (job) => job);
  return legs.filter((leg): leg is Leg => !!leg);
}

function pushRoute(list: RouteQuote[], steps: Step[], amountOut: bigint) {
  if (amountOut <= 0n) return;
  list.push({
    id: routeId(steps),
    label: labelFor(steps),
    amountOut: amountOut.toString(),
    steps,
    gasUnits: gasFor(steps),
  });
}

function splitRoutes(book: Map<string, PairState>, tokenIn: string, tokenOut: string, amountIn: bigint, feeBps: number) {
  const directs = allV2(book, tokenIn, tokenOut, amountIn, feeBps, amountIn);
  if (directs.length < 2) return [];
  const [a, b] = directs;
  const stateA = stateFor(book, a.step.factory!, tokenIn, tokenOut)!;
  const stateB = stateFor(book, b.step.factory!, tokenIn, tokenOut)!;
  let bestOut = 0n;
  let bestBps = 0;
  let feeA = 0n;
  let feeB = 0n;
  let outA = 0n;
  let outB = 0n;
  for (const bps of [1500, 3000, 4000, 5000, 6000, 7000, 8500]) {
    const first = (amountIn * BigInt(bps)) / 10_000n;
    const second = amountIn - first;
    const chargedA = wrapperOnSpend(first, first, !isBlazarFactory(stateA.factory), feeBps);
    const chargedB = wrapperOnSpend(second, second, !isBlazarFactory(stateB.factory), feeBps);
    const left = quoteState(stateA, tokenIn, chargedA.net);
    const right = quoteState(stateB, tokenIn, chargedB.net);
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
  if (bestOut * 10_000n <= single * 10_015n) return [];
  const stepA = { ...a.step, bps: bestBps, useBalance: false, wrapperFee: feeA.toString(), quotedOut: outA.toString() };
  const stepB = { ...b.step, bps: 10_000, useBalance: false, wrapperFee: feeB.toString(), quotedOut: outB.toString() };
  return [{ steps: [stepA, stepB], amountOut: bestOut }];
}

async function referenceQuote(tokenIn: TokenMeta, tokenOut: TokenMeta, amountIn: bigint) {
  const controller = new AbortController();
  const parent = abortStore.getStore();
  const onAbort = () => controller.abort();
  parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    rethrowIfAborted();
    const src = isNative(tokenIn.address) ? registry.native : tokenIn.address;
    const dest = isNative(tokenOut.address) ? registry.native : tokenOut.address;
    const url = new URL("https://apiv5.paraswap.io/prices");
    url.searchParams.set("srcToken", src);
    url.searchParams.set("destToken", dest);
    url.searchParams.set("amount", amountIn.toString());
    url.searchParams.set("srcDecimals", String(tokenIn.decimals));
    url.searchParams.set("destDecimals", String(tokenOut.decimals));
    url.searchParams.set("side", "SELL");
    url.searchParams.set("network", "137");
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const body = (await response.json()) as { priceRoute?: { destAmount?: string } };
    const destAmount = body.priceRoute?.destAmount;
    if (!destAmount || !/^\d+$/.test(destAmount)) return null;
    return { source: "ParaSwap", amountOut: destAmount };
  } catch {
    rethrowIfAborted();
    return null;
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onAbort);
  }
}

async function currentFeeBps() {
  if (!isDeployed(addresses.feeRouter)) return registry.fee.aggregatorBps;
  try {
    const fee = await rpc().readContract({
      address: addresses.feeRouter as Address,
      abi: feeRouterAbi,
      functionName: "feeBps",
    });
    return Number(fee);
  } catch {
    rethrowIfAborted();
    return registry.fee.aggregatorBps;
  }
}

function marginal(state: PairState, tokenIn: string, amountIn: bigint) {
  const inIs0 = tokenIn.toLowerCase() === state.token0.toLowerCase();
  const reserveIn = inIs0 ? state.reserve0 : state.reserve1;
  const reserveOut = inIs0 ? state.reserve1 : state.reserve0;
  if (reserveIn === 0n) return 0n;
  return (amountIn * BigInt(10_000 - state.feeBps) * reserveOut) / (reserveIn * 10_000n);
}

async function impactFor(steps: Step[], amountIn: bigint, amountOut: bigint) {
  if (amountOut <= 0n) return null;
  const split = steps.length === 2 && !steps[0].useBalance && !steps[1].useBalance;
  if (steps.every((step) => step.kind === "v2") && !split) {
    let mid = amountIn;
    for (const step of steps) {
      const venue = registry.v2.find((item) => item.name === step.venue);
      if (!venue || !step.pool) return null;
      const [token0, reserves] = await Promise.all([
        rpc().readContract({ address: step.pool as Address, abi: v2PairAbi, functionName: "token0" }),
        rpc().readContract({ address: step.pool as Address, abi: v2PairAbi, functionName: "getReserves" }),
      ]);
      const state: PairState = {
        pair: step.pool as Address,
        token0,
        reserve0: reserves[0],
        reserve1: reserves[1],
        feeBps: step.feeBps ?? 30,
        venue: step.venue,
        factory: venue.factory as Address,
      };
      mid = marginal(state, step.tokenIn, mid);
    }
    if (mid <= amountOut) return 0;
    return Number(((mid - amountOut) * 10_000n) / mid);
  }
  const tiny = amountIn / 1000n;
  if (tiny <= 0n) return null;
  let cursor = tiny;
  for (const step of steps) {
    const spend = step.useBalance ? cursor : (tiny * BigInt(step.bps)) / 10_000n;
    if (step.kind === "v2" && step.pool) {
      const [token0, reserves] = await Promise.all([
        rpc().readContract({ address: step.pool as Address, abi: v2PairAbi, functionName: "token0" }),
        rpc().readContract({ address: step.pool as Address, abi: v2PairAbi, functionName: "getReserves" }),
      ]);
      const inIs0 = step.tokenIn.toLowerCase() === token0.toLowerCase();
      cursor = quoteV2(spend, inIs0 ? reserves[0] : reserves[1], inIs0 ? reserves[1] : reserves[0], step.feeBps ?? 30);
    } else if (step.kind === "v3") {
      cursor = await quoteUni(step.tokenIn, step.tokenOut, spend, step.feeTier ?? 500);
    } else {
      cursor = (await quoteAlgebra(step.tokenIn, step.tokenOut, spend)).amountOut;
    }
    if (!step.useBalance && steps.filter((item) => !item.useBalance).length > 1) {
      // Split legs are priced on the original input, then summed below.
      continue;
    }
  }
  const isSplit = steps.length > 1 && steps.every((step) => !step.useBalance);
  if (isSplit) {
    let sum = 0n;
    for (const step of steps) {
      const spend = (tiny * BigInt(step.bps === 10_000 && step !== steps[0] ? 10_000 - steps[0].bps : step.bps)) / 10_000n;
      if (!step.pool) return null;
      const [token0, reserves] = await Promise.all([
        rpc().readContract({ address: step.pool as Address, abi: v2PairAbi, functionName: "token0" }),
        rpc().readContract({ address: step.pool as Address, abi: v2PairAbi, functionName: "getReserves" }),
      ]);
      const inIs0 = step.tokenIn.toLowerCase() === token0.toLowerCase();
      sum += quoteV2(spend, inIs0 ? reserves[0] : reserves[1], inIs0 ? reserves[1] : reserves[0], step.feeBps ?? 30);
    }
    cursor = sum;
  }
  if (cursor <= 0n) return null;
  const mid = (cursor * amountIn) / tiny;
  if (mid <= amountOut) return 0;
  return Number(((mid - amountOut) * 10_000n) / mid);
}

export async function findBestRoute(rawIn: string, rawOut: string, amountIn: bigint, signal?: AbortSignal): Promise<QuoteResponse> {
  if (signal && !rpcStore.getStore()) {
    if (signal.aborted) throw new Error("Quote timed out.");
    return rpcStore.run(clientFor(signal), () => abortStore.run(signal, () => findBestRoute(rawIn, rawOut, amountIn)));
  }
  rethrowIfAborted();
  if (amountIn <= 0n) throw new Error("Enter an amount");
  const [tokenIn, tokenOut] = await Promise.all([resolveMeta(rawIn), resolveMeta(rawOut)]);
  const sell = poolToken(tokenIn.address);
  const buy = poolToken(tokenOut.address);
  const feeBps = await currentFeeBps();
  const routeAmount = amountIn;
  const notes = [
    `Wrapper fee is ${(feeBps / 100).toFixed(2)}% of external-routed principal, charged once along a path. A later hop does not charge that principal again. BlazarSwap-only paths pay the pool fee alone.`,
    "Pool fees are already reflected in the quoted output.",
  ];
  if (sell.toLowerCase() === buy.toLowerCase()) {
    throw new Error("Choose two different tokens. POL and WPOL are the same asset once wrapped.");
  }
  const hubs = [...new Set([...MIX_HUBS, ...registry.hubs])]
    .map((hub) => getAddress(hub))
    .filter((hub) => hub.toLowerCase() !== sell.toLowerCase() && hub.toLowerCase() !== buy.toLowerCase());
  const bookTokens = [...new Set([sell, buy, ...hubs])];
  const optional = new AbortController();
  const parentAbort = abortStore.getStore();
  const cancelOptional = () => optional.abort();
  if (parentAbort?.aborted) cancelOptional();
  else parentAbort?.addEventListener("abort", cancelOptional, { once: true });
  // Handler attached before any later await, so an abort cannot reject this unobserved.
  const referenceTask = abortStore.run(optional.signal, () =>
    referenceQuote(tokenIn, tokenOut, amountIn).then(
      (value) => value,
      () => null,
    ),
  );
  let hopTask: Promise<void> = Promise.resolve();
  try {
  const book = await loadBook(bookTokens);
  const routes: RouteQuote[] = [];

  for (const leg of allV2(book, sell, buy, routeAmount, feeBps, routeAmount)) pushRoute(routes, [leg.step], leg.amountOut);
  for (const split of splitRoutes(book, sell, buy, routeAmount, feeBps)) pushRoute(routes, split.steps, split.amountOut);

  for (const hub of hubs) {
    const first = bestV2(book, sell, hub, routeAmount, feeBps, routeAmount);
    if (!first) continue;
    const second = bestV2(book, hub, buy, first.amountOut, feeBps, first.unpaidOut);
    if (!second) continue;
    const step2 = { ...second.step, useBalance: true };
    pushRoute(routes, [first.step, step2], second.amountOut);
  }

  const concentratedDirect = await quoteConcentrated(sell, buy, routeAmount, feeBps, routeAmount);
  for (const leg of concentratedDirect) pushRoute(routes, [leg.step], leg.amountOut);

  const majors = new Set(
    ["WPOL", "USDC", "USDC.e", "USDT", "WETH", "WBTC"].map(
      (symbol) => registry.tokens.find((token) => token.symbol === symbol)!.address.toLowerCase(),
    ),
  );
  const exotic = !majors.has(sell.toLowerCase()) || !majors.has(buy.toLowerCase());
  const hopList = (exotic ? [getAddress(registry.wpol)] : hubs.slice(0, 3)).filter(
    (hub) => hub.toLowerCase() !== sell.toLowerCase() && hub.toLowerCase() !== buy.toLowerCase(),
  );
  const hopJobs = hopList.map(async (hub) => {
    const v2In = bestV2(book, sell, hub, routeAmount, feeBps, routeAmount);
    const outLegs: { steps: Step[]; amountOut: bigint }[] = [];
    if (v2In) {
      const next = await quoteConcentrated(hub, buy, v2In.amountOut, feeBps, v2In.unpaidOut);
      for (const leg of next) outLegs.push({ steps: [v2In.step, { ...leg.step, useBalance: true }], amountOut: leg.amountOut });
    }
    const v3In = await quoteConcentrated(sell, hub, routeAmount, feeBps, routeAmount);
    for (const leg of v3In) {
      const v2Out = bestV2(book, hub, buy, leg.amountOut, feeBps, leg.unpaidOut);
      if (v2Out) outLegs.push({ steps: [leg.step, { ...v2Out.step, useBalance: true }], amountOut: v2Out.amountOut });
    }
    return outLegs;
  });
  hopTask = Promise.all(hopJobs.map((job) => job.then(() => undefined, () => undefined))).then(() => undefined);
  for (const group of await Promise.all(hopJobs)) {
    for (const route of group) pushRoute(routes, route.steps, route.amountOut);
  }

  routes.sort((a, b) => {
    const ao = BigInt(a.amountOut);
    const bo = BigInt(b.amountOut);
    if (ao === bo) return a.steps.length - b.steps.length;
    return ao > bo ? -1 : 1;
  });
  const best = routes[0] ?? null;
  const alternatives = routes.filter((route) => route.id !== best?.id).slice(0, 3);
  const inputToken = sell.toLowerCase();
  const feeAmount = (best?.steps ?? []).reduce((sum, step) => {
    if (step.tokenIn.toLowerCase() !== inputToken) return sum;
    return sum + BigInt(step.wrapperFee || "0");
  }, 0n);
  const otherFees = (best?.steps ?? []).filter(
    (step) => BigInt(step.wrapperFee || "0") > 0n && step.tokenIn.toLowerCase() !== inputToken,
  );
  for (const step of otherFees) {
    notes.push(`External principal pays one wrapper fee of ${step.wrapperFee} raw units of ${step.tokenIn}.`);
  }
  const reference = await referenceTask;
  rethrowIfAborted();
  if (reference && best) {
    const ref = BigInt(reference.amountOut);
    const ours = BigInt(best.amountOut);
    if (ref > (ours * 10_050n) / 10_000n) {
      notes.push("ParaSwap sees a higher output. This desk still executes on allowlisted pools so the fee and BZB routes stay on-chain.");
    }
  }
  let priceImpactBps: number | null = null;
  let gasPrice = 0n;
  let polUsdE8: bigint | null = null;
  if (best) {
    priceImpactBps = await impactFor(best.steps, routeAmount, BigInt(best.amountOut)).catch(() => null);
  }
  try {
    gasPrice = await rpc().getGasPrice();
  } catch {
    rethrowIfAborted();
    gasPrice = 0n;
  }
  try {
    const wpolUsdc = bestV2(book, registry.wpol, registry.tokens.find((token) => token.symbol === "USDC")!.address, 10n ** 18n, 0, 0n);
    if (wpolUsdc) polUsdE8 = wpolUsdc.amountOut * 100n;
  } catch {
    rethrowIfAborted();
    polUsdE8 = null;
  }
  const gasUsdE8 = best && polUsdE8 !== null && gasPrice > 0n ? (gasPrice * BigInt(best.gasUnits) * polUsdE8) / 10n ** 18n : null;
  if (!best) notes.push("No route on BlazarSwap, QuickSwap v2, SushiSwap, ApeSwap, Uniswap v3, or QuickSwap v3.");

  return {
    tokenIn,
    tokenOut,
    amountIn: amountIn.toString(),
    feeBps,
    feeAmount: feeAmount.toString(),
    routeAmount: routeAmount.toString(),
    best,
    alternatives,
    reference,
    priceImpactBps,
    gasPrice: gasPrice.toString(),
    polUsdE8: polUsdE8?.toString() ?? null,
    gasUsdE8: gasUsdE8?.toString() ?? null,
    notes,
  };
  } finally {
    cancelOptional();
    parentAbort?.removeEventListener("abort", cancelOptional);
    await referenceTask;
    await hopTask;
  }
}
