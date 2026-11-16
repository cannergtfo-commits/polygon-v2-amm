/** Live BlazarFeeRouter facts. Read every time a quote is built (cached briefly by callers). */
import { FEE_ROUTER_ABI } from "./abis.mjs";
import { FEE_ROUTER, VENUES } from "./config.mjs";
import { lower } from "./pricing.mjs";

export async function readRouter(rpc, { venues = VENUES, router = FEE_ROUTER } = {}) {
  const base = ["feeBps", "paused", "blazarFactory", "owner", "pendingOwner", "feeRecipient", "oracle", "MAX_FEE_BPS", "MAX_DEADLINE_WINDOW"];
  const items = base.map((fn) => ({ to: router, abi: FEE_ROUTER_ABI, functionName: fn }));
  const v2 = venues.filter((v) => v.kind === "v2");
  const targets = venues.filter((v) => v.kind !== "v2");
  for (const v of v2) items.push({ to: router, abi: FEE_ROUTER_ABI, functionName: "v2FeeBps", args: [v.factory] });
  for (const v of targets) items.push({ to: router, abi: FEE_ROUTER_ABI, functionName: "allowedTarget", args: [v.router] });
  const rows = await rpc.multicall(items);
  if (!rows[0].ok) throw new Error("Fee router did not answer feeBps(); wrong address or RPC problem");
  const out = { address: router, v2FeeBps: {}, allowedTarget: {} };
  base.forEach((fn, i) => {
    const v = rows[i].value;
    out[fn] = typeof v === "bigint" ? Number(v) : v;
  });
  v2.forEach((v, i) => (out.v2FeeBps[lower(v.factory)] = Number(rows[base.length + i].value ?? 0)));
  targets.forEach((v, i) => (out.allowedTarget[lower(v.router)] = rows[base.length + v2.length + i].value === true));
  out.readAt = Date.now();
  return out;
}

/** Venues the router can execute right now, with the router's own V2 fee for each factory. */
export function executableVenues(router, venues = VENUES) {
  return venues
    .map((v) => {
      if (v.kind === "v2") {
        const fee = router.v2FeeBps[lower(v.factory)] || 0;
        return fee > 0 ? { ...v, routerFeeBps: fee } : null;
      }
      return router.allowedTarget[lower(v.router)] ? { ...v } : null;
    })
    .filter(Boolean);
}
