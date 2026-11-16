/**
 * Registry-free pool lookup: ask each factory directly (getPair / getPool / poolByPair) in one
 * Multicall3 batch. Used by quotes and find_pools so they work before the first full refresh.
 * Returns registry-style rows: [venueId, pool, token0, token1, fee|null, 0].
 */
import { encodeFunctionData, parseAbi } from "viem";
import { VENUES, ZERO } from "./config.mjs";
import { lower } from "./pricing.mjs";

const V2F = parseAbi(["function getPair(address,address) view returns (address)"]);
const V3F = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const ALGF = parseAbi(["function poolByPair(address,address) view returns (address)"]);
export const V3_TIERS = [100, 500, 3000, 10000];

/** pairs: [[a, b], ...]. Returns unique rows for every existing pool on the given venues. */
export async function lookupPools(rpc, pairs, { venues = VENUES } = {}) {
  const items = [];
  const meta = [];
  const seen = new Set();
  for (const [x, y] of pairs) {
    const [a, b] = [lower(x), lower(y)].sort();
    if (a === b || seen.has(`${a}|${b}`)) continue;
    seen.add(`${a}|${b}`);
    for (const v of venues) {
      if (v.kind === "v2") {
        items.push({ to: v.factory, data: encodeFunctionData({ abi: V2F, functionName: "getPair", args: [a, b] }) });
        meta.push([v, a, b, null]);
      } else if (v.kind === "v3") {
        for (const fee of V3_TIERS) {
          items.push({ to: v.factory, data: encodeFunctionData({ abi: V3F, functionName: "getPool", args: [a, b, fee] }) });
          meta.push([v, a, b, fee]);
        }
      } else {
        items.push({ to: v.factory, data: encodeFunctionData({ abi: ALGF, functionName: "poolByPair", args: [a, b] }) });
        meta.push([v, a, b, null]);
      }
    }
  }
  if (!items.length) return [];
  const rows = await rpc.multicall(items);
  const out = [];
  rows.forEach((r, i) => {
    if (!r.ok || r.data.length < 66) return;
    const pool = `0x${r.data.slice(26, 66)}`.toLowerCase();
    if (pool === ZERO) return;
    const [v, a, b, fee] = meta[i];
    out.push([v.id, pool, a, b, fee, 0]);
  });
  return out;
}
