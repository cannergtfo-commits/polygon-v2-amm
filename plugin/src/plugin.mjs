/**
 * Plugin facade: what an MCP / agent tool layer calls. Read-only; builders return UNSIGNED txs.
 *
 * Safety rules enforced here (not left to the caller):
 *  - Token symbols/names are untrusted on-chain text: sanitized, flagged, never used to pick a token
 *    for a build. Builders accept 0x addresses or the canonical symbols in CANONICAL only.
 *  - Read tools accept a symbol but report every other token sharing it (`ambiguous`).
 *  - Swaps are re-quoted at build time, the deadline is taken from the latest block at build time,
 *    approvals are for the exact amount (reset to 0 first when an allowance already exists).
 *  - Native POL output to a recipient with code is refused (router recipient-balance check).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFunctionResult, encodeFunctionData, formatUnits } from "viem";
import * as desk from "../../docs/js/desk-core.mjs";
import { ERC20 } from "./abis.mjs";
import { ANCHORS, BZB, DAI, FEE_ROUTER, NATIVE, ROUTE_HUBS, USDC, USDCE, USDT, VENUES, WBTC, WETH, WPOL } from "./config.mjs";
import { loadCache, refresh } from "./index.mjs";
import { lookupPools } from "./lookup.mjs";
import { lower, priceTokens, valuePool } from "./pricing.mjs";
import { buildPairIndex, quote } from "./quote.mjs";
import { executableVenues, readRouter } from "./router.mjs";
import { createRpc } from "./rpc.mjs";
import { anchorPrices, readPoolState, readTokenMeta } from "./state.mjs";
import { symbolKey } from "./text.mjs";
import { buildSwapTx } from "./tx.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Symbols that resolve from this table only. Everything else needs an address for builds. */
export const CANONICAL = {
  pol: NATIVE, matic: NATIVE, native: NATIVE,
  wpol: WPOL, wmatic: WPOL,
  usdc: USDC, "usdc.e": USDCE, usdt: USDT, weth: WETH, wbtc: WBTC, dai: DAI, bzb: BZB,
};

export class PluginError extends Error {
  constructor(code, message, hint, details) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}

export function parseAmount(raw, decimals) {
  if (!/^\d+(\.\d+)?$/.test(String(raw))) throw new PluginError("BAD_AMOUNT", "amount must be a plain decimal string", 'Human units: "1.5" = 1.5 tokens.');
  const [w, f = ""] = String(raw).split(".");
  if (f.length > decimals) throw new PluginError("BAD_AMOUNT", `too many decimal places (token has ${decimals})`);
  const v = BigInt(w + f.padEnd(decimals, "0"));
  if (v <= 0n) throw new PluginError("BAD_AMOUNT", "amount must be greater than 0");
  if (v >= (1n << 255n)) throw new PluginError("BAD_AMOUNT", "amount is too large");
  return v;
}

const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || ""));

export function createPlugin({ dataDir = process.env.BLAZAR_POLYGON_DATA_DIR || path.join(here, "..", "data"), seedFile = null, rpc = createRpc(), routerTtlMs = 60_000 } = {}) {
  let cache;
  let index;
  let tokens;
  let seeded = false;

  function load() {
    cache = loadCache(dataDir);
    seeded = false;
    if (!cache.tokens.tokens.length && seedFile && fs.existsSync(seedFile)) {
      cache.tokens = JSON.parse(fs.readFileSync(seedFile, "utf8"));
      seeded = true;
    }
    index = buildPairIndex(cache.registry.pools);
    tokens = new Map(cache.tokens.tokens.map((t) => [lower(t.address), t]));
  }
  load();

  let router = null;
  async function liveRouter() {
    if (!router || Date.now() - router.readAt > routerTtlMs) router = await readRouter(rpc);
    return router;
  }

  const prices = () => Object.fromEntries(cache.tokens.tokens.filter((t) => t.priceUsd > 0).map((t) => [lower(t.address), { usd: t.priceUsd, decimals: t.decimals }]));
  const freshness = () => ({ asOfBlock: cache.tokens.block ?? null, updatedAt: cache.tokens.updatedAt ?? null, seedSnapshot: seeded, poolsIndexed: cache.registry.pools.length });

  /** Read decimals/symbol/name for an address not in the cache (sanitized + flagged). */
  async function tokenInfo(address) {
    const a = lower(address);
    if (a === lower(NATIVE)) return { address: NATIVE, symbol: "POL", name: "Polygon (native)", decimals: 18, native: true };
    const hit = tokens.get(a);
    if (hit) return hit;
    const meta = {};
    await readTokenMeta(rpc, [a], meta);
    const m = meta[a];
    if (!m || m.bad) throw new PluginError("NOT_A_TOKEN", `${a} did not answer decimals() like an ERC-20`, "Check the address on polygonscan.com.");
    return { address: a, symbol: m.symbol, name: m.name, decimals: m.decimals, listed: false, ...(m.flags ? { textFlags: m.flags } : {}) };
  }

  /**
   * Resolve a token argument. strict = builders: address or canonical symbol only.
   * Returns { address, info, resolvedBy, warnings[], ambiguous? }.
   */
  async function resolve(arg, { strict = false, field = "token" } = {}) {
    const s = String(arg ?? "").trim();
    if (!s) throw new PluginError("BAD_INPUT", `${field} is required`);
    const warnings = [];
    if (isAddr(s)) {
      const info = await tokenInfo(s);
      if (info.textFlags?.length) warnings.push(`UNTRUSTED_TEXT: ${field} ${info.address} has on-chain symbol/name flags [${info.textFlags.join(", ")}]; its displayed symbol may imitate another token.`);
      if (info.listed === false) warnings.push(`UNLISTED: ${field} ${info.address} is not in the liquid-token list (depth < $${cache.tokens.minTvlUsd ?? 10000}).`);
      return { address: info.native ? NATIVE : lower(info.address), info, resolvedBy: "address", warnings };
    }
    const key = s.toLowerCase();
    if (CANONICAL[key]) {
      const info = await tokenInfo(CANONICAL[key]);
      return { address: CANONICAL[key] === NATIVE ? NATIVE : lower(CANONICAL[key]), info, resolvedBy: "canonical-symbol", warnings };
    }
    const sk = symbolKey(s);
    const matches = sk ? cache.tokens.tokens.filter((t) => symbolKey(t.symbol) === sk && !(t.textFlags || []).includes("impersonates")).sort((a, b) => (b.depthUsd ?? 1e18) - (a.depthUsd ?? 1e18)) : [];
    if (strict) {
      throw new PluginError("ADDRESS_REQUIRED", `${field} "${sk ?? "(non-ASCII symbol)"}" is not a canonical symbol; builders need the 0x address`, `Canonical symbols: ${Object.keys(CANONICAL).join(", ")}. Look the address up with polygon_list_tokens or polygon_get_price and pass it.`, { candidates: matches.slice(0, 5).map((t) => ({ address: t.address, depthUsd: t.depthUsd })) });
    }
    if (!matches.length) throw new PluginError("UNKNOWN_SYMBOL", `No liquid token with symbol "${sk ?? "(non-ASCII)"}"`, "Pass the token's 0x address.");
    const best = matches[0];
    const ambiguous = matches.length > 1 ? matches.slice(1, 6).map((t) => ({ address: t.address, depthUsd: t.depthUsd, priceUsd: t.priceUsd })) : undefined;
    warnings.push(`RESOLVED_BY_SYMBOL: "${sk}" -> ${best.address} (deepest of ${matches.length}). Symbols are untrusted on-chain text; confirm the address.`);
    if (ambiguous) warnings.push(`AMBIGUOUS_SYMBOL: ${matches.length} liquid tokens use "${sk}". Others: ${ambiguous.map((x) => x.address).join(", ")}.`);
    return { address: lower(best.address), info: best, resolvedBy: "symbol", warnings, ambiguous };
  }

  /** Candidate pool rows for a quote: registry index merged with a live factory lookup. */
  async function candidateIndex(a, b, hubs) {
    const sell = lower(desk.poolToken(a));
    const buy = lower(desk.poolToken(b));
    const pairs = [[sell, buy], ...hubs.map(lower).filter((h) => h !== sell && h !== buy).flatMap((h) => [[sell, h], [h, buy]])];
    const live = await lookupPools(rpc, pairs);
    const rows = new Map();
    for (const [x, y] of pairs) {
      const [p, q] = [x, y].sort();
      for (const r of index.get(`${p}|${q}`) || []) rows.set(r[1], r);
    }
    for (const r of live) rows.set(r[1], r);
    return buildPairIndex([...rows.values()]);
  }

  async function runQuote({ tokenIn, tokenOut, amount, amountIsBaseUnits = false, strict = false, hubs = ROUTE_HUBS, onlyVenues = null }) {
    const a = await resolve(tokenIn, { strict, field: "tokenIn" });
    const b = await resolve(tokenOut, { strict, field: "tokenOut" });
    if (desk.sameAsset(a.address, b.address)) throw new PluginError("SAME_TOKEN", "tokenIn and tokenOut are the same asset (POL and WPOL count as one)");
    const amountIn = amountIsBaseUnits ? BigInt(amount) : parseAmount(amount, a.info.decimals);
    if (amountIn <= 0n) throw new PluginError("BAD_AMOUNT", "amount must be greater than 0");
    const r = await liveRouter();
    if (r.paused) throw new PluginError("ROUTER_PAUSED", "BlazarFeeRouter is paused; swaps would revert", "Try later; polygon_get_router_info shows the state.");
    const [idx, gasHex] = await Promise.all([candidateIndex(a.address, b.address, hubs), rpc.request("eth_gasPrice", [])]);
    const q = await quote({ rpc, index: idx, router: r, tokenIn: a.address, tokenOut: b.address, amountIn, gasPrice: BigInt(gasHex), prices: prices(), hubs, onlyVenues });
    return { q, a, b, router: r, quotedAt: Date.now() };
  }

  function quoteJson({ q, a, b }) {
    if (q.wrap) return { wrap: q.wrap, amountOut: q.amountOut.toString(), note: q.note };
    if (!q.steps) return { route: null, note: q.note, warnings: [...a.warnings, ...b.warnings] };
    const fmt = (v, t) => formatUnits(v, t.info.decimals);
    return {
      tokenIn: { address: q.tokenIn, symbol: a.info.symbol, decimals: a.info.decimals, resolvedBy: a.resolvedBy },
      tokenOut: { address: q.tokenOut, symbol: b.info.symbol, decimals: b.info.decimals, resolvedBy: b.resolvedBy },
      amountIn: q.amountIn.toString(),
      amountInFormatted: fmt(q.amountIn, a),
      amountOut: q.amountOut.toString(),
      amountOutFormatted: fmt(q.amountOut, b),
      route: q.label,
      hops: q.steps.map((s) => ({ venue: s.venue, kind: s.kind, pool: s.pool, tokenIn: s.tokenIn, tokenOut: s.tokenOut, feeTier: s.feeTier ?? null, sharePct: s.bps / 100, chained: !!s.useBalance, wrapperFee: s.wrapperFee.toString() })),
      feeRouter: FEE_ROUTER,
      routerFeeBps: q.routerFeeBps,
      wrapperFees: q.wrapperFees.map((f) => ({ token: f.token, amount: f.amount.toString() })),
      gasUnitsEstimate: q.gasUnits,
      costVsMidBps: q.costVsMidBps,
      alternatives: q.alternatives.map((x) => ({ route: x.label, amountOut: x.amountOut.toString() })),
      routesConsidered: q.routesConsidered,
      warnings: [...a.warnings, ...b.warnings, ...(q.costVsMidBps !== null && q.costVsMidBps > 300 ? [`HIGH_COST: output is ${(q.costVsMidBps / 100).toFixed(2)}% below the cached mid price (impact + fees). Trade smaller or check liquidity.`] : [])],
      ...(a.ambiguous ? { ambiguousTokenIn: a.ambiguous } : {}),
      ...(b.ambiguous ? { ambiguousTokenOut: b.ambiguous } : {}),
      prices: freshness(),
    };
  }

  async function erc20Read(token, fn, args) {
    const raw = await rpc.call(token, encodeFunctionData({ abi: ERC20, functionName: fn, args }));
    return decodeFunctionResult({ abi: ERC20, functionName: fn, data: raw });
  }

  /** Exact-amount approval steps for `owner`: none, [exact], or [reset to 0, exact]. */
  async function approvalSteps({ token, owner, amount, spender = FEE_ROUTER, symbol = "token", decimals = 18 }) {
    const allowance = owner ? await erc20Read(token, "allowance", [owner, spender]) : 0n;
    const plan = desk.approvalPlan(allowance, amount); // [], [amount] or [0, amount]; refuses unlimited
    const txs = plan.map((v) => ({
      kind: "approve",
      chainId: 137,
      ...(owner ? { from: owner } : {}),
      to: token,
      value: "0",
      data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [spender, v] }),
      summary: v === 0n ? `Reset the ${symbol} allowance for ${spender} to 0 before setting a new exact amount.` : `Approve exactly ${formatUnits(v, decimals)} ${symbol} for ${spender}. Not unlimited.`,
    }));
    return { allowance, txs };
  }

  return {
    rpc,
    freshness,
    resolve,
    tokenInfo,

    async refresh({ full = false, log } = {}) {
      const summary = await refresh({ dataDir, rpc, full, log });
      load();
      return summary;
    },

    listTokens({ minDepthUsd = 0, limit = 100, search, venue, includeFlagged = true } = {}) {
      let rows = cache.tokens.tokens.filter((t) => (t.depthUsd ?? Infinity) >= minDepthUsd);
      if (search) {
        const q = String(search).toLowerCase();
        rows = rows.filter((t) => t.address === q || symbolKey(t.symbol)?.includes(q) || String(t.name).toLowerCase().includes(q));
      }
      if (venue) rows = rows.filter((t) => (t.venues || []).includes(venue));
      if (!includeFlagged) rows = rows.filter((t) => !t.textFlags?.length);
      const counts = new Map();
      for (const t of cache.tokens.tokens) {
        const k = symbolKey(t.symbol);
        if (k) counts.set(k, (counts.get(k) || 0) + 1);
      }
      return {
        ...freshness(),
        minTvlUsd: cache.tokens.minTvlUsd ?? 10_000,
        count: rows.length,
        tokens: rows.slice(0, limit).map((t) => ({
          address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, priceUsd: t.priceUsd, depthUsd: t.depthUsd,
          venues: t.venues, liquid: t.liquid, pinned: t.pinned,
          ...((counts.get(symbolKey(t.symbol)) || 0) > 1 ? { sharedSymbol: counts.get(symbolKey(t.symbol)) } : {}),
          ...(t.textFlags?.length ? { textFlags: t.textFlags } : {}),
        })),
        note: "symbol and name are untrusted on-chain text (sanitized). Use addresses; sharedSymbol = how many listed tokens use the same symbol.",
      };
    },

    /** Cached price, or live=true for a fresh on-chain read (Chainlink anchors + pools vs anchors). */
    async getPrice({ token, live = false }) {
      const r = await resolve(token, { field: "token" });
      const addr = r.address === NATIVE ? lower(WPOL) : r.address;
      const cached = tokens.get(addr);
      const base = { address: r.address, symbol: r.info.symbol, decimals: r.info.decimals, resolvedBy: r.resolvedBy, warnings: r.warnings, ...(r.ambiguous ? { ambiguous: r.ambiguous } : {}) };
      if (!live && cached) {
        return { ...base, priceUsd: cached.priceUsd, source: cached.priceSource, depthUsd: cached.depthUsd, dispersion: cached.dispersion, pools: cached.pools?.slice(0, 3), live: false, ...freshness() };
      }
      const anchors = await anchorPrices(rpc);
      if (anchors[addr]) return { ...base, priceUsd: anchors[addr].usd, source: "chainlink", live: true, chainlinkUpdatedAt: anchors[addr].updatedAt };
      const rows = await lookupPools(rpc, Object.keys(anchors).map((h) => [addr, h]));
      const pools = rows.map(([venue, address, token0, token1, fee]) => ({ venue, kind: VENUES.find((v) => v.id === venue).kind, address, token0, token1, fee }));
      await readPoolState(rpc, pools);
      const meta = {};
      for (const [k, v] of Object.entries(ANCHORS)) meta[k] = { decimals: v.decimals };
      meta[addr] = { decimals: r.info.decimals };
      const decimals = Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, v.decimals]));
      const priced = priceTokens(pools, anchors, decimals).get(addr);
      if (!priced) return { ...base, priceUsd: null, live: true, note: "No pool against WPOL/USDC/USDC.e/USDT/WETH/WBTC/DAI on the covered DEXes." };
      return {
        ...base,
        priceUsd: priced.best.priceUsd,
        source: `${priced.best.venue}:${priced.best.pool}`,
        depthUsd: Math.round(priced.best.depthUsd),
        dispersion: Number(priced.dispersion.toFixed(4)),
        pools: priced.candidates.slice(0, 3).map((c) => ({ pool: c.pool, venue: c.venue, hub: c.hub, depthUsd: Math.round(c.depthUsd), priceUsd: c.priceUsd })),
        live: true,
        ...(priced.best.depthUsd < 10_000 ? { warnings: [...r.warnings, `THIN: best pool depth is about $${Math.round(priced.best.depthUsd)}; the price is easy to move.`] } : {}),
      };
    },

    /** Live pools for a token (vs every route hub) or a token pair, with depth and executability. */
    async findPools({ tokenA, tokenB }) {
      const a = await resolve(tokenA, { field: "tokenA" });
      const b = tokenB ? await resolve(tokenB, { field: "tokenB" }) : null;
      const ta = lower(desk.poolToken(a.address));
      const pairs = b ? [[ta, lower(desk.poolToken(b.address))]] : ROUTE_HUBS.map((h) => [ta, lower(h)]).filter(([x, y]) => x !== y);
      const [rows, r, anchors] = await Promise.all([lookupPools(rpc, pairs), liveRouter(), anchorPrices(rpc)]);
      const pools = rows.map(([venue, address, token0, token1, fee]) => ({ venue, kind: VENUES.find((v) => v.id === venue).kind, address, token0, token1, fee }));
      await readPoolState(rpc, pools);
      const meta = {};
      await readTokenMeta(rpc, pools.flatMap((p) => [p.token0, p.token1]), meta);
      const decimals = Object.fromEntries(Object.entries(meta).filter(([, m]) => !m.bad).map(([k, m]) => [k, m.decimals]));
      const usd = (t) => anchors[t]?.usd ?? tokens.get(t)?.priceUsd ?? null;
      const allowed = new Set(executableVenues(r).map((v) => v.id));
      const out = pools.map((p) => {
        let depthUsd = null;
        let priceOf0In1 = null;
        for (const [tok, hub] of [[p.token0, p.token1], [p.token1, p.token0]]) {
          const h = usd(hub);
          if (!h) continue;
          const v = valuePool(p, tok, hub, decimals, h);
          if (v && (depthUsd === null || v.depthUsd > depthUsd)) depthUsd = v.depthUsd;
          if (v && tok === p.token0) priceOf0In1 = v.priceInHub;
        }
        return {
          venue: p.venue,
          pool: p.address,
          token0: { address: p.token0, symbol: meta[p.token0]?.symbol ?? "?", ...(meta[p.token0]?.flags ? { textFlags: meta[p.token0].flags } : {}) },
          token1: { address: p.token1, symbol: meta[p.token1]?.symbol ?? "?", ...(meta[p.token1]?.flags ? { textFlags: meta[p.token1].flags } : {}) },
          feeTier: p.fee ?? null,
          depthUsd: depthUsd === null ? null : Math.round(depthUsd),
          price0in1: priceOf0In1,
          executableViaFeeRouter: allowed.has(p.venue),
          ...(p.stateError ? { stateError: true } : {}),
        };
      });
      out.sort((x, y) => (y.depthUsd ?? -1) - (x.depthUsd ?? -1));
      return { token: a.address, pair: b ? b.address : null, count: out.length, pools: out, warnings: [...a.warnings, ...(b ? b.warnings : [])], note: "Live factory lookups (getPair/getPool/poolByPair), not the cache. depthUsd = 2 x min(side USD); null when neither side has a known USD price. Symbols are untrusted text." };
    },

    async routerInfo() {
      const r = await liveRouter();
      const live = executableVenues(r);
      return {
        address: r.address,
        feeBps: r.feeBps,
        maxFeeBps: r.MAX_FEE_BPS,
        feeRecipient: r.feeRecipient,
        owner: r.owner,
        pendingOwner: r.pendingOwner,
        paused: r.paused,
        oracle: r.oracle,
        blazarFactory: r.blazarFactory,
        maxDeadlineWindowSeconds: r.MAX_DEADLINE_WINDOW,
        venues: VENUES.map((v) => ({ id: v.id, name: v.name, kind: v.kind, factory: v.factory, ...(v.router ? { router: v.router } : {}), allowed: live.some((x) => x.id === v.id), ...(v.kind === "v2" ? { routerFeeBps: r.v2FeeBps[lower(v.factory)] || 0 } : {}) })),
        feeModel: "Wrapper fee feeBps of principal, charged once, on the first leg that is not a BlazarSwap pool, in that leg's spend token, sent straight to feeRecipient. BlazarSwap-only paths pay no wrapper fee.",
        readAt: new Date(r.readAt).toISOString(),
      };
    },

    async quote(args) {
      return quoteJson(await runQuote(args));
    },

    /**
     * Fresh quote + unsigned txs. Addresses or canonical symbols only. Returns kit-style
     * { action, summary, txs[], warnings[], guards, details } plus the raw swap for simulation.
     */
    async buildSwap({ tokenIn, tokenOut, amount, amountIsBaseUnits = false, from, recipient, slippageBps = 50, deadlineSeconds = 120, maxCostVsMidBps = 3000 }) {
      if (!isAddr(from)) throw new PluginError("BAD_ADDRESS", "from must be a 0x address");
      const to = recipient ?? from;
      if (!isAddr(to)) throw new PluginError("BAD_ADDRESS", "recipient must be a 0x address");
      if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 300) throw new PluginError("BAD_SLIPPAGE", "slippageBps must be 1..300");
      if (!Number.isInteger(deadlineSeconds) || deadlineSeconds < 30 || deadlineSeconds > 170) throw new PluginError("BAD_DEADLINE", "deadlineSeconds must be 30..170", "The router rejects deadlines more than 180 s past the block it runs in.");
      const forbidden = new Set([lower(FEE_ROUTER), lower(WPOL)]);
      if (forbidden.has(lower(to))) throw new PluginError("BAD_RECIPIENT", "recipient cannot be the fee router or the WPOL contract");
      const res = await runQuote({ tokenIn, tokenOut, amount, amountIsBaseUnits, strict: true });
      const { q, a, b } = res;
      if (q.wrap) throw new PluginError("WRAP_NOT_SWAP", "POL <-> WPOL is a 1:1 wrap at the WPOL contract, not a router swap", "Call WPOL deposit()/withdraw(amount) directly.");
      if (!q.steps) throw new PluginError("NO_ROUTE", q.note || "No route on the fee-router allowlist", "Check polygon_find_pools; the token may only trade on venues the router cannot reach.");
      if (forbidden.has(lower(to)) || lower(to) === lower(q.tokenOut) || lower(to) === lower(q.tokenIn)) throw new PluginError("BAD_RECIPIENT", "recipient cannot be a token contract or the router");
      if (q.costVsMidBps !== null && q.costVsMidBps > maxCostVsMidBps) throw new PluginError("PRICE_IMPACT_TOO_HIGH", `Output is ${(q.costVsMidBps / 100).toFixed(2)}% below the mid price`, "Trade smaller, or raise maxCostVsMidBps if intended.");
      const warnings = [...a.warnings, ...b.warnings];
      const code = await rpc.request("eth_getCode", [to, "latest"]);
      const recipientHasCode = !!code && code !== "0x";
      if (recipientHasCode && q.tokenOut === NATIVE) {
        throw new PluginError("RECIPIENT_HAS_CODE", "Recipient has contract code; native POL output can revert (the router checks the recipient's POL balance rose, and contracts or EIP-7702 wallets may forward it)", "Use tokenOut WPOL instead, or a recipient without code.");
      }
      if (recipientHasCode) warnings.push("RECIPIENT_IS_CONTRACT: recipient has code (contract or EIP-7702 delegated wallet). Make sure it can use the output token.");
      // Fresh deadline: from the latest block, at build time.
      const block = await rpc.block("latest");
      const blockTime = Number(BigInt(block.timestamp));
      // desk.swapPlan sets deadline = blockTime + 90; shift the base so deadline = latest block + deadlineSeconds.
      const tx = buildSwapTx({ quote: q, recipient: to, blockTime: blockTime + (deadlineSeconds - desk.DEADLINE_SEC), slippageBps, feeRouter: FEE_ROUTER });
      const txs = [];
      let allowance = null;
      if (tx.approval) {
        const ap = await approvalSteps({ token: q.tokenIn, owner: from, amount: BigInt(tx.approval.amount), symbol: a.info.symbol, decimals: a.info.decimals });
        allowance = ap.allowance;
        txs.push(...ap.txs);
        const bal = await erc20Read(q.tokenIn, "balanceOf", [from]);
        if (bal < q.amountIn) warnings.push(`INSUFFICIENT_BALANCE: ${from} holds ${formatUnits(bal, a.info.decimals)} ${a.info.symbol}, needs ${formatUnits(q.amountIn, a.info.decimals)}.`);
      } else {
        const bal = BigInt(await rpc.request("eth_getBalance", [from, "latest"]));
        if (bal < q.amountIn) warnings.push(`INSUFFICIENT_BALANCE: ${from} holds ${formatUnits(bal, 18)} POL, needs ${formatUnits(q.amountIn, 18)} plus gas.`);
      }
      const minOut = tx.minAmountOut;
      txs.push({
        kind: "swap",
        chainId: 137,
        from,
        to: FEE_ROUTER,
        data: tx.data,
        value: tx.value.toString(),
        summary: `Swap ${formatUnits(q.amountIn, a.info.decimals)} ${a.info.symbol} for at least ${formatUnits(minOut, b.info.decimals)} ${b.info.symbol} (expected ${formatUnits(q.amountOut, b.info.decimals)}) via ${q.label} through BlazarFeeRouter to ${lower(to) === lower(from) ? "the sender" : to}. Reverts after ${new Date(Number(tx.deadline) * 1000).toISOString()}.`,
      });
      txs.forEach((t, i) => (t.step = i + 1));
      return {
        action: "swap",
        summary: `${txs.length} unsigned tx${txs.length > 1 ? "s" : ""}: ${txs.map((t) => t.kind).join(" -> ")}. ${formatUnits(q.amountIn, a.info.decimals)} ${a.info.symbol} -> >= ${formatUnits(minOut, b.info.decimals)} ${b.info.symbol} via ${q.label}.`,
        chainId: 137,
        from,
        txs,
        warnings,
        quote: quoteJson(res),
        guards: {
          exactApproval: true,
          currentAllowance: allowance === null ? "n/a (POL input)" : allowance.toString(),
          slippageBps,
          minAmountOut: minOut.toString(),
          deadline: tx.deadline.toString(),
          deadlineIso: new Date(Number(tx.deadline) * 1000).toISOString(),
          deadlineFromBlock: blockTime,
          recipient: to,
          recipientHasCode,
          builtAt: new Date().toISOString(),
          gasHint: tx.gasHint.toString(),
        },
        simulate: { from, to: FEE_ROUTER, data: tx.data, value: tx.value, tokenGrant: tx.approval ? { token: q.tokenIn, spender: FEE_ROUTER, amount: BigInt(tx.approval.amount) } : null },
        next: `Sign and send txs[] in order before ${new Date(Number(tx.deadline) * 1000).toISOString()} (about ${deadlineSeconds}s). If that passes, call the builder again; do not edit the calldata.`,
        signing: "UNSIGNED. Sign with your own wallet. Nothing was signed or sent.",
      };
    },

    /** Exact-amount approval for the fee router (or another spender). Address or canonical symbol only. */
    async buildApprove({ token, amount, amountIsBaseUnits = false, owner, spender = FEE_ROUTER }) {
      const t = await resolve(token, { strict: true, field: "token" });
      if (t.address === NATIVE) throw new PluginError("NATIVE_NO_APPROVAL", "Native POL needs no approval");
      if (!isAddr(spender)) throw new PluginError("BAD_ADDRESS", "spender must be a 0x address");
      if (owner !== undefined && !isAddr(owner)) throw new PluginError("BAD_ADDRESS", "owner must be a 0x address");
      const value = amountIsBaseUnits ? BigInt(amount) : parseAmount(amount, t.info.decimals);
      if (value <= 0n || value >= desk.MAX_UINT) throw new PluginError("BAD_AMOUNT", "Exact, non-zero, non-unlimited amounts only");
      const warnings = [...t.warnings];
      if (lower(spender) !== lower(FEE_ROUTER)) warnings.push(`UNKNOWN_SPENDER: ${spender} is not BlazarFeeRouter. Only approve contracts you trust.`);
      const ap = await approvalSteps({ token: t.address, owner, amount: value, spender, symbol: t.info.symbol, decimals: t.info.decimals });
      ap.txs.forEach((x, i) => (x.step = i + 1));
      return {
        action: "approve",
        summary: ap.txs.length ? `${ap.txs.length} unsigned tx${ap.txs.length > 1 ? "s" : ""}: exact approval of ${formatUnits(value, t.info.decimals)} ${t.info.symbol} for ${spender}.` : `No tx needed: the current allowance already covers ${formatUnits(value, t.info.decimals)} ${t.info.symbol}.`,
        chainId: 137,
        ...(owner ? { from: owner } : {}),
        txs: ap.txs,
        warnings: owner ? warnings : [...warnings, "NO_OWNER: allowance not checked; if an allowance already exists, approve(0) first for USDT-style tokens."],
        guards: { exactApproval: true, amount: value.toString(), currentAllowance: owner ? ap.allowance.toString() : "unknown (no owner)", spender },
        signing: "UNSIGNED. Sign with your own wallet. Nothing was signed or sent.",
      };
    },
  };
}
