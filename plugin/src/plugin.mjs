/**
 * Plugin facade: the functions an MCP/agent tool layer calls. Read-only; returns unsigned txs.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FEE_ROUTER, NATIVE, WPOL } from "./config.mjs";
import { loadCache, refresh } from "./index.mjs";
import { lower } from "./pricing.mjs";
import { buildPairIndex, quote } from "./quote.mjs";
import { readRouter } from "./router.mjs";
import { createRpc } from "./rpc.mjs";
import { buildApproveTx, buildSwapTx } from "./tx.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

export function createPlugin({ dataDir = path.join(here, "..", "data"), rpc = createRpc(), routerTtlMs = 60_000 } = {}) {
  let cache = loadCache(dataDir);
  let index = buildPairIndex(cache.registry.pools);
  let router = null;

  const tokenMap = () => new Map(cache.tokens.tokens.map((t) => [t.address, t]));
  const prices = () => Object.fromEntries(cache.tokens.tokens.map((t) => [t.address, { usd: t.priceUsd, decimals: t.decimals }]));

  function resolve(token) {
    if (!token) throw new Error("token required");
    const s = String(token).trim();
    if (/^(pol|matic|native)$/i.test(s)) return { address: NATIVE, symbol: "POL", decimals: 18 };
    if (/^0x[0-9a-fA-F]{40}$/.test(s)) {
      const hit = tokenMap().get(lower(s));
      return hit || { address: lower(s), symbol: null, decimals: null, unknown: true };
    }
    const hits = cache.tokens.tokens.filter((t) => t.symbol.toLowerCase() === s.toLowerCase()).sort((a, b) => (b.depthUsd ?? 1e18) - (a.depthUsd ?? 1e18));
    if (!hits.length) throw new Error(`Unknown symbol ${s}; pass the token address`);
    return { ...hits[0], ambiguous: hits.length > 1 ? hits.slice(1).map((h) => h.address) : undefined };
  }

  async function liveRouter() {
    if (!router || Date.now() - router.readAt > routerTtlMs) router = await readRouter(rpc);
    return router;
  }

  return {
    async refresh(opts = {}) {
      const summary = await refresh({ dataDir, rpc, ...opts });
      cache = loadCache(dataDir);
      index = buildPairIndex(cache.registry.pools);
      return summary;
    },
    listTokens({ minDepthUsd = 0, limit = 100, search } = {}) {
      let rows = cache.tokens.tokens.filter((t) => (t.depthUsd ?? Infinity) >= minDepthUsd);
      if (search) rows = rows.filter((t) => `${t.symbol} ${t.name} ${t.address}`.toLowerCase().includes(String(search).toLowerCase()));
      return { updatedAt: cache.tokens.updatedAt, block: cache.tokens.block, minTvlUsd: cache.tokens.minTvlUsd, count: rows.length, tokens: rows.slice(0, limit) };
    },
    getPrice(token) {
      const t = resolve(token);
      const addr = t.address === NATIVE ? lower(WPOL) : t.address;
      const row = tokenMap().get(addr);
      if (!row) return { token: t.address, priced: false, note: "Not in the liquid list; pass refresh or quote it directly." };
      return { ...row, updatedAt: cache.tokens.updatedAt, block: cache.tokens.block };
    },
    router: liveRouter,
    async quote({ tokenIn, tokenOut, amount, amountIsBaseUnits = false, onlyVenues = null, hubs }) {
      const a = resolve(tokenIn);
      const b = resolve(tokenOut);
      const decIn = a.decimals ?? null;
      if (!amountIsBaseUnits && decIn === null) throw new Error("Unknown tokenIn decimals; pass amountIsBaseUnits");
      const amountIn = amountIsBaseUnits ? BigInt(amount) : parseAmount(String(amount), decIn);
      const r = await liveRouter();
      const gasPrice = BigInt(await rpc.request("eth_gasPrice", []));
      return quote({ rpc, index, router: r, tokenIn: a.address, tokenOut: b.address, amountIn, gasPrice, prices: prices(), onlyVenues, ...(hubs ? { hubs } : {}) });
    },
    async buildSwapTx({ quote: q, recipient, slippageBps = 50 }) {
      if (q?.tokenOut === NATIVE && /^0x[0-9a-fA-F]{40}$/.test(recipient || "")) {
        // The router checks the recipient's POL balance rose by minAmountOut. A contract or an
        // EIP-7702-delegated wallet that forwards POL makes the swap revert, so ask for WPOL instead.
        const code = await rpc.request("eth_getCode", [recipient, "latest"]);
        if (code && code !== "0x") throw new Error("Recipient has contract code; native POL output can revert. Quote with tokenOut WPOL instead.");
      }
      const block = await rpc.block("latest");
      return buildSwapTx({ quote: q, recipient, blockTime: Number(BigInt(block.timestamp)), slippageBps, feeRouter: FEE_ROUTER });
    },
    buildApproveTx,
    get rpcStats() {
      return rpc.stats;
    },
  };
}

export function parseAmount(raw, decimals) {
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error("amount must be a plain decimal");
  const [w, f = ""] = raw.split(".");
  if (f.length > decimals) throw new Error("too many decimal places");
  return BigInt(w + f.padEnd(decimals, "0"));
}
