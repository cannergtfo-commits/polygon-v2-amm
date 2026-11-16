/** Live state reads, all batched through Multicall3. */
import { decodeFunctionResult, encodeFunctionData, hexToString } from "viem";
import { ALGEBRA_GLOBAL_STATE_SELECTOR, ERC20, FEED, V2_PAIR, V3_POOL } from "./abis.mjs";
import { ANCHORS } from "./config.mjs";
import { lower } from "./pricing.mjs";

const RESERVES = encodeFunctionData({ abi: V2_PAIR, functionName: "getReserves" });
const SLOT0 = encodeFunctionData({ abi: V3_POOL, functionName: "slot0" });
const balData = (who) => encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [who] });

/** USD per whole anchor token from Chainlink (8 decimals on Polygon feeds). */
export async function anchorPrices(rpc, anchors = ANCHORS) {
  const keys = Object.keys(anchors);
  const rows = await rpc.multicall(keys.map((k) => ({ to: anchors[k].feed, abi: FEED, functionName: "latestRoundData" })));
  const out = {};
  const now = Math.floor(Date.now() / 1000);
  keys.forEach((k, i) => {
    const r = rows[i];
    if (!r.ok) return;
    const answer = Number(r.value[1]) / 1e8;
    const updatedAt = Number(r.value[3]);
    if (!(answer > 0) || now - updatedAt > 2 * 86_400) return;
    out[k] = { usd: answer, decimals: anchors[k].decimals, symbol: anchors[k].symbol, updatedAt };
  });
  return out;
}

/**
 * Read state for pool objects in place. V2: reserves. Concentrated: sqrt price + both token balances.
 * Pools that fail (self-destructed, non-standard) get `stateError`.
 */
export async function readPoolState(rpc, pools) {
  const items = [];
  const index = [];
  for (const p of pools) {
    if (p.kind === "v2") {
      index.push([p, "res", items.length]);
      items.push({ to: p.address, data: RESERVES });
    } else {
      index.push([p, "px", items.length]);
      items.push({ to: p.address, data: p.kind === "v3" ? SLOT0 : ALGEBRA_GLOBAL_STATE_SELECTOR });
      index.push([p, "b0", items.length]);
      items.push({ to: p.token0, data: balData(p.address) });
      index.push([p, "b1", items.length]);
      items.push({ to: p.token1, data: balData(p.address) });
    }
  }
  const rows = items.length ? await rpc.multicall(items) : [];
  for (const [p, what, i] of index) {
    const r = rows[i];
    if (!r?.ok || r.data.length < 66) {
      p.stateError = true;
      continue;
    }
    if (what === "res") {
      if (r.data.length < 2 + 64 * 2) {
        p.stateError = true;
        continue;
      }
      p.reserve0 = BigInt(`0x${r.data.slice(2, 66)}`);
      p.reserve1 = BigInt(`0x${r.data.slice(66, 130)}`);
    } else if (what === "px") p.sqrtPriceX96 = BigInt(`0x${r.data.slice(2, 66)}`);
    else if (what === "b0") p.bal0 = BigInt(`0x${r.data.slice(2, 66)}`);
    else if (what === "b1") p.bal1 = BigInt(`0x${r.data.slice(2, 66)}`);
  }
  for (const p of pools) if (p.reserve0 !== undefined || p.sqrtPriceX96 !== undefined) delete p.stateError;
  return pools;
}

function decodeSymbol(data) {
  if (!data || data === "0x") return null;
  try {
    return decodeFunctionResult({ abi: ERC20, functionName: "symbol", data });
  } catch {
    try {
      return hexToString(data.slice(0, 66), { size: 32 }).replace(/\0+$/, "");
    } catch {
      return null;
    }
  }
}

/** Fill decimals/symbol/name for addresses not already in `meta`. */
export async function readTokenMeta(rpc, addresses, meta) {
  const todo = [...new Set(addresses.map(lower))].filter((a) => !meta[a]);
  const items = [];
  for (const a of todo) {
    items.push({ to: a, data: encodeFunctionData({ abi: ERC20, functionName: "decimals" }) });
    items.push({ to: a, data: encodeFunctionData({ abi: ERC20, functionName: "symbol" }) });
    items.push({ to: a, data: encodeFunctionData({ abi: ERC20, functionName: "name" }) });
  }
  const rows = items.length ? await rpc.multicall(items) : [];
  todo.forEach((a, i) => {
    const d = rows[i * 3];
    const s = rows[i * 3 + 1];
    const n = rows[i * 3 + 2];
    const decimals = d?.ok && d.data.length >= 66 ? Number(BigInt(`0x${d.data.slice(2, 66)}`)) : null;
    if (decimals === null || decimals > 36) {
      meta[a] = { bad: true };
      return;
    }
    const clean = (x) => (x ? String(x).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64) : null);
    meta[a] = { decimals, symbol: clean(s?.ok ? decodeSymbol(s.data) : null) || "?", name: clean(n?.ok ? decodeSymbol(n.data) : null) || "" };
  });
  return meta;
}
