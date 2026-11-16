/**
 * Best executable route through BlazarFeeRouter, net of the router's wrapper fee.
 * Only venues on the live router allowlist are considered. Route maths and calldata plans reuse
 * docs/js/desk-core.mjs, the same code the live blazarforce.net swap desk signs with.
 */
import { encodeFunctionData } from "viem";
import * as desk from "../../docs/js/desk-core.mjs";
import { ALGEBRA4_QUOTER, ALGEBRA_QUOTER, UNI_QUOTER, V2_PAIR } from "./abis.mjs";
import { FEE_ROUTER, NATIVE, ROUTE_HUBS, VENUES, WPOL, ZERO } from "./config.mjs";
import { lower } from "./pricing.mjs";
import { executableVenues } from "./router.mjs";

const RESERVES = encodeFunctionData({ abi: V2_PAIR, functionName: "getReserves" });

/** Pair index over the registry rows: "a|b" (sorted, lowercase) -> pool rows. */
export function buildPairIndex(rows) {
  const map = new Map();
  for (const row of rows) {
    const [a, b] = [row[2], row[3]].sort();
    const key = `${a}|${b}`;
    let list = map.get(key);
    if (!list) map.set(key, (list = []));
    list.push(row);
  }
  return map;
}

function poolsFor(index, a, b, venueIds) {
  const [x, y] = [lower(a), lower(b)].sort();
  return (index.get(`${x}|${y}`) || []).filter((row) => venueIds.has(row[0]));
}

function quoterItem(venue, pool, tokenIn, tokenOut, amount) {
  if (venue.kind === "v3") {
    return { to: venue.quoter, abi: UNI_QUOTER, functionName: "quoteExactInputSingle", args: [{ tokenIn, tokenOut, amountIn: amount, fee: pool[4], sqrtPriceLimitX96: 0n }] };
  }
  if (venue.kind === "algebra") return { to: venue.quoter, abi: ALGEBRA_QUOTER, functionName: "quoteExactInputSingle", args: [tokenIn, tokenOut, amount, 0n] };
  return { to: venue.quoter, abi: ALGEBRA4_QUOTER, functionName: "quoteExactInputSingle", args: [tokenIn, tokenOut, ZERO, amount, 0n] };
}

function firstWord(value) {
  if (typeof value === "bigint") return value;
  if (Array.isArray(value)) return BigInt(value[0]);
  return 0n;
}

/**
 * Quote concentrated legs in one multicall. jobs: [{ venue, pool, tokenIn, tokenOut, gross, unpaid, useBalance }].
 * Returns desk-style routes (one step each) priced on the amount left after the wrapper fee.
 */
async function quoteConcentrated(rpc, jobs, feeBps) {
  const items = [];
  const meta = [];
  for (const job of jobs) {
    const charged = desk.wrapperOnSpend(job.gross, job.unpaid, true, feeBps);
    if (charged.net <= 0n) continue;
    items.push(quoterItem(job.venue, job.pool, job.tokenIn, job.tokenOut, charged.net));
    meta.push(job);
  }
  if (!items.length) return [];
  const rows = await rpc.multicall(items, { chunk: 25 });
  const out = [];
  rows.forEach((row, i) => {
    const job = meta[i];
    const quotedOut = row.ok ? firstWord(row.value) : 0n;
    if (quotedOut <= 0n) return;
    const route = desk.pricedExternal({
      tokenIn: job.tokenIn,
      tokenOut: job.tokenOut,
      gross: job.gross,
      unpaid: job.unpaid,
      feeBps,
      quotedOut,
      venue: job.venue.name,
      router: job.venue.router,
      kind: job.venue.kind,
      feeTier: job.venue.kind === "v3" ? job.pool[4] : null,
      pool: job.pool[1],
      useBalance: job.useBalance,
    });
    if (route) out.push({ ...route, venueId: job.venue.id });
  });
  return out;
}

async function loadV2(rpc, rows, venuesById) {
  if (!rows.length) return [];
  const res = await rpc.multicall(rows.map((row) => ({ to: row[1], data: RESERVES })));
  const pairs = [];
  rows.forEach((row, i) => {
    const r = res[i];
    if (!r.ok || r.data.length < 130) return;
    const venue = venuesById[row[0]];
    const reserve0 = BigInt(`0x${r.data.slice(2, 66)}`);
    const reserve1 = BigInt(`0x${r.data.slice(66, 130)}`);
    if (reserve0 === 0n || reserve1 === 0n) return;
    pairs.push({ factory: venue.factory, venue: venue.name, feeBps: venue.routerFeeBps, pair: row[1], tokenA: row[2], tokenB: row[3], token0: row[2], reserve0, reserve1 });
  });
  return pairs;
}

/**
 * quote({ rpc, index, router, tokenIn, tokenOut, amountIn, gasPrice?, prices?, hubs? })
 * prices: lower(address) -> { usd, decimals } used for gas-in-output and price impact only.
 */
export async function quote({ rpc, index, router, tokenIn, tokenOut, amountIn, gasPrice = 0n, prices = {}, hubs = ROUTE_HUBS, venues = VENUES, onlyVenues = null, maxRoutes = 3 }) {
  if (router.paused) throw new Error("BlazarFeeRouter is paused; swaps would revert");
  const amount = BigInt(amountIn);
  if (amount <= 0n) throw new Error("amountIn must be positive");
  const wrap = desk.wrapDirection(tokenIn, tokenOut);
  if (wrap) return { wrap, amountOut: amount, note: "POL and WPOL wrap 1:1 at the WPOL contract; no router, no fee." };
  const sell = lower(desk.poolToken(tokenIn));
  const buy = lower(desk.poolToken(tokenOut));
  if (sell === buy) throw new Error("tokenIn and tokenOut are the same asset");
  const feeBps = router.feeBps;
  const live = executableVenues(router, venues).filter((v) => !onlyVenues || onlyVenues.includes(v.id));
  const ids = new Set(live.map((v) => v.id));
  const byId = Object.fromEntries(live.map((v) => [v.id, v]));
  const v2Venues = live.filter((v) => v.kind === "v2").map((v) => ({ id: v.id, name: v.name, factory: v.factory, feeBps: v.routerFeeBps }));
  const hubList = hubs.map(lower).filter((h) => h !== sell && h !== buy);

  // Gather every pool on the direct pair and on sell->hub / hub->buy.
  const legPairs = [[sell, buy], ...hubList.flatMap((h) => [[sell, h], [h, buy]])];
  const v2Rows = [];
  const concRows = [];
  for (const [a, b] of legPairs) {
    for (const row of poolsFor(index, a, b, ids)) (byId[row[0]].kind === "v2" ? v2Rows : concRows).push({ row, a, b });
  }
  const directConc = concRows.filter((x) => (x.a === sell && x.b === buy));
  const firstConc = concRows.filter((x) => x.a === sell && x.b !== buy);
  const [pairs, concA] = await Promise.all([
    loadV2(rpc, [...new Map(v2Rows.map((x) => [x.row[1], x.row])).values()], byId),
    quoteConcentrated(
      rpc,
      [...directConc, ...firstConc].map((x) => ({ venue: byId[x.row[0]], pool: x.row, tokenIn: sell, tokenOut: x.b, gross: amount, unpaid: amount, useBalance: false })),
      feeBps,
    ),
  ]);

  const routes = desk.collectRoutes({ pairs, tokenIn: sell, tokenOut: buy, hubs: hubList, amountIn: amount, feeBps, blazarFactory: router.blazarFactory, venues: v2Venues, concentrated: [] });
  for (const r of concA) if (lower(r.steps[0].tokenOut) === buy) routes.push(r);

  // Best first leg into each hub (V2 or concentrated), then the second leg on any venue.
  const second = [];
  const firstByHub = new Map();
  for (const h of hubList) {
    const cands = [];
    const v2 = desk.bestV2(pairs, sell, h, amount, feeBps, amount, router.blazarFactory, v2Venues);
    if (v2) cands.push({ amountOut: v2.amountOut, unpaidOut: v2.unpaidOut, step: v2.step });
    for (const r of concA) if (lower(r.steps[0].tokenOut) === h) cands.push({ amountOut: r.amountOut, unpaidOut: 0n, step: r.steps[0] });
    cands.sort((x, y) => (y.amountOut > x.amountOut ? 1 : y.amountOut < x.amountOut ? -1 : 0));
    if (!cands.length) continue;
    firstByHub.set(h, cands[0]);
    const nextV2 = desk.bestV2(pairs, h, buy, cands[0].amountOut, feeBps, cands[0].unpaidOut, router.blazarFactory, v2Venues);
    if (nextV2) routes.push({ amountOut: nextV2.amountOut, steps: [cands[0].step, { ...nextV2.step, useBalance: true }] });
    for (const x of concRows.filter((c) => c.a === h && c.b === buy)) {
      second.push({ venue: byId[x.row[0]], pool: x.row, tokenIn: h, tokenOut: buy, gross: cands[0].amountOut, unpaid: cands[0].unpaidOut, useBalance: true, first: cands[0] });
    }
  }
  const concB = await quoteConcentrated(rpc, second, feeBps);
  for (const r of concB) {
    const first = firstByHub.get(lower(r.steps[0].tokenIn));
    if (first) routes.push({ amountOut: r.amountOut, steps: [first.step, r.steps[0]] });
  }

  // Gas priced in the output token from cached USD prices.
  let outputPerPol = null;
  const pOut = prices[buy];
  const pPol = prices[lower(WPOL)];
  if (pOut?.usd > 0 && pPol?.usd > 0 && gasPrice > 0n) {
    const ratio = pPol.usd / pOut.usd; // output tokens per POL
    outputPerPol = (BigInt(Math.floor(ratio * 1e12)) * 10n ** BigInt(pOut.decimals)) / 10n ** 12n;
    if (outputPerPol <= 0n) outputPerPol = null;
  }
  const ranked = desk.rankRoutes(routes, { gasPrice: BigInt(gasPrice), outputPerPol });
  if (!ranked.length) return { tokenIn, tokenOut, amountIn: amount, best: null, routesConsidered: 0, note: "No route on the fee-router allowlist for this pair." };
  const best = ranked[0];
  const wrapperFees = best.steps.filter((s) => s.wrapperFee > 0n).map((s) => ({ token: lower(desk.poolToken(s.tokenIn)), amount: s.wrapperFee }));
  let midOut = null;
  let impactBps = null;
  const pIn = prices[sell];
  if (pIn?.usd > 0 && pOut?.usd > 0) {
    const inUsd = Number(amount) / 10 ** pIn.decimals * pIn.usd;
    const outUsd = Number(best.amountOut) / 10 ** pOut.decimals * pOut.usd;
    midOut = inUsd / pOut.usd;
    impactBps = Math.round((1 - outUsd / inUsd) * 10_000);
  }
  return {
    feeRouter: router.address || FEE_ROUTER,
    tokenIn: desk.isNative(tokenIn) ? NATIVE : tokenIn,
    tokenOut: desk.isNative(tokenOut) ? NATIVE : tokenOut,
    amountIn: amount,
    amountOut: best.amountOut,
    routerFeeBps: feeBps,
    wrapperFees,
    label: desk.routeLabel(best.steps),
    steps: best.steps,
    gasUnits: desk.gasUnits(best.steps),
    gasCostOut: best.gasCost,
    netOfGas: best.net,
    costVsMidBps: impactBps,
    midOutFloat: midOut,
    routesConsidered: ranked.length,
    alternatives: ranked.slice(1, maxRoutes).map((r) => ({ label: desk.routeLabel(r.steps), amountOut: r.amountOut, net: r.net })),
  };
}
