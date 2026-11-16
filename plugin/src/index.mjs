/**
 * Refresh pipeline: discover pools -> read state -> price -> filter -> cache.
 * Full sweep reads every pool that touches an anchor (and pass-2 hubs). Incremental refresh
 * reads only the hot set (pools near or above the liquidity bar) plus newly created pools.
 */
import fs from "node:fs";
import path from "node:path";
import { ANCHORS, MIN_TVL_USD, PINNED, VENUES, WATCH_FRACTION } from "./config.mjs";
import { discover, emptyRegistry, poolObject } from "./discover.mjs";
import { alchemyCuOf, createRpc } from "./rpc.mjs";
import { hubSideUsd, lower, priceTokens, secondaryHubs } from "./pricing.mjs";
import { anchorPrices, readPoolState, readTokenMeta } from "./state.mjs";

export const FULL_SWEEP_MS = 24 * 3600 * 1000;

export function paths(dataDir) {
  return {
    registry: path.join(dataDir, "pools.json"),
    state: path.join(dataDir, "state.json"),
    tokens: path.join(dataDir, "tokens.json"),
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  fs.renameSync(tmp, file);
}

export function loadCache(dataDir) {
  const p = paths(dataDir);
  return {
    registry: readJson(p.registry, emptyRegistry()),
    state: readJson(p.state, { meta: {}, hot: [], lastFull: 0, block: 0 }),
    tokens: readJson(p.tokens, { tokens: [] }),
  };
}

const anchorMeta = () => Object.fromEntries(Object.entries(ANCHORS).map(([a, v]) => [a, { decimals: v.decimals, symbol: v.symbol, name: v.symbol }]));

/** Run pricing over pools that already carry state, with anchors then pass-2 hubs. */
export async function pricePools(rpc, pools, anchors, meta, { minTvl = MIN_TVL_USD, pinned = new Set(PINNED.map(lower)) } = {}) {
  const watch = minTvl * WATCH_FRACTION;
  const live = pools.filter((p) => !p.stateError);
  const prefilter = (hubs) =>
    live.filter((p) => {
      if (pinned.has(lower(p.token0)) || pinned.has(lower(p.token1))) {
        if (hubs[lower(p.token0)] || hubs[lower(p.token1)]) return true;
      }
      for (const t of [p.token0, p.token1]) {
        const h = hubs[lower(t)];
        if (h && meta[lower(t)] && hubSideUsd(p, t, meta[lower(t)].decimals, h.usd) >= watch / 2) return true;
      }
      return false;
    });
  const cand1 = prefilter(anchors);
  await readTokenMeta(rpc, cand1.flatMap((p) => [p.token0, p.token1]), meta);
  const decimals = Object.fromEntries(Object.entries(meta).filter(([, m]) => !m.bad).map(([a, m]) => [a, m.decimals]));
  const priced1 = priceTokens(cand1, anchors, decimals);
  const second = secondaryHubs(priced1, anchors);
  const cand2 = prefilter(second);
  await readTokenMeta(rpc, cand2.flatMap((p) => [p.token0, p.token1]), meta);
  Object.entries(meta).forEach(([a, m]) => !m.bad && (decimals[a] = m.decimals));
  const priced2 = priceTokens(cand2, second, decimals);
  const merged = new Map(priced1);
  for (const [token, entry] of priced2) {
    if (anchors[token]) continue;
    const cur = merged.get(token);
    if (!cur) merged.set(token, entry);
    else {
      const all = [...cur.candidates, ...entry.candidates].sort((a, b) => b.depthUsd - a.depthUsd).slice(0, 4);
      merged.set(token, { ...cur, best: all[0], candidates: all, totalDepthUsd: cur.totalDepthUsd + entry.totalDepthUsd });
    }
  }
  // pinned tokens with no anchor/secondary pool: price them against any token already priced
  const missing = [...pinned].filter((t) => !merged.has(t));
  if (missing.length) {
    const hubs3 = {};
    for (const [t, e] of merged) if (e.best.depthUsd >= minTvl * WATCH_FRACTION) hubs3[t] = { usd: e.best.priceUsd };
    for (const [a, v] of Object.entries(anchors)) hubs3[a] = v;
    const cand3 = live.filter((p) => missing.includes(lower(p.token0)) || missing.includes(lower(p.token1)));
    await readTokenMeta(rpc, cand3.flatMap((p) => [p.token0, p.token1]), meta);
    Object.entries(meta).forEach(([a, m]) => !m.bad && (decimals[a] = m.decimals));
    const priced3 = priceTokens(cand3, hubs3, decimals);
    for (const t of missing) if (priced3.has(t)) merged.set(t, priced3.get(t));
  }
  return { merged, second, cand: [...new Set([...cand1, ...cand2])] };
}

/**
 * Refresh the cache. Returns a summary including RPC usage.
 * opts: { dataDir, full, rpc, log, minTvl }
 */
export async function refresh({ dataDir, full = false, rpc = createRpc(), log = () => {}, minTvl = MIN_TVL_USD, venues = VENUES } = {}) {
  const t0 = Date.now();
  const cache = loadCache(dataDir);
  const { registry, state } = cache;
  state.meta = { ...anchorMeta(), ...state.meta };
  const latest = await rpc.blockNumber();
  const before = new Set(registry.pools.map((r) => r[1]));
  // stay a few blocks behind head: public log endpoints lag the call endpoint slightly
  const disc = await discover(rpc, registry, latest - 5n, { venues, log });
  writeJson(paths(dataDir).registry, registry);
  const anchors = await anchorPrices(rpc);
  if (!anchors[lower(ANCHORS && Object.keys(ANCHORS)[0])]) throw new Error("WPOL Chainlink price unavailable");
  const doFull = full || !state.lastFull || Date.now() - state.lastFull > FULL_SWEEP_MS;
  const all = registry.pools.map((r) => poolObject(r, venues));
  const anchorSet = new Set(Object.keys(anchors));
  const prevSecondary = new Set(state.secondary || []);
  const hot = new Set(state.hot || []);
  const pinnedSet = new Set(PINNED.map(lower));
  let selected;
  if (doFull) {
    selected = all.filter((p) => anchorSet.has(p.token0) || anchorSet.has(p.token1));
  } else {
    selected = all.filter(
      (p) => hot.has(p.address) || (!before.has(p.address) && (anchorSet.has(p.token0) || anchorSet.has(p.token1) || prevSecondary.has(p.token0) || prevSecondary.has(p.token1))),
    );
  }
  // pinned tokens always get their anchor pools read so they stay priced
  const extra = all.filter((p) => (pinnedSet.has(p.token0) || pinnedSet.has(p.token1)) && !selected.includes(p));
  selected = [...selected, ...extra];
  log(`${doFull ? "full" : "incremental"} sweep: reading ${selected.length} pools`);
  await readPoolState(rpc, selected);
  let { merged, second } = await pricePools(rpc, selected, anchors, state.meta, { minTvl });
  if (doFull) {
    const secSet = new Set(Object.keys(second));
    const done = new Set(selected.map((p) => p.address));
    const pass2 = all.filter((p) => !done.has(p.address) && (secSet.has(p.token0) || secSet.has(p.token1)));
    log(`pass 2: ${Object.keys(second).length} secondary hubs, reading ${pass2.length} more pools`);
    await readPoolState(rpc, pass2);
    selected = [...selected, ...pass2];
    ({ merged, second } = await pricePools(rpc, selected, anchors, state.meta, { minTvl }));
  }
  const tokens = [];
  const nextHot = new Set();
  for (const [token, entry] of merged) {
    const m = state.meta[token];
    if (!m || m.bad) continue;
    const liquid = entry.best.depthUsd >= minTvl;
    const pinned = pinnedSet.has(token);
    if (entry.best.depthUsd >= minTvl * WATCH_FRACTION || pinned) for (const c of entry.candidates) nextHot.add(c.pool);
    if (!liquid && !pinned && !anchors[token]) continue;
    tokens.push({
      address: token,
      symbol: m.symbol,
      name: m.name,
      decimals: m.decimals,
      priceUsd: anchors[token] ? anchors[token].usd : entry.best.priceUsd,
      priceSource: anchors[token] ? "chainlink" : `${entry.best.venue}:${entry.best.pool}`,
      depthUsd: Math.round(entry.best.depthUsd),
      totalDepthUsd: Math.round(entry.totalDepthUsd),
      hub: state.meta[entry.best.hub]?.symbol || entry.best.hub,
      dispersion: Number(entry.dispersion.toFixed(4)),
      venues: [...new Set(entry.candidates.map((c) => c.venue))],
      pools: entry.candidates.map((c) => ({ pool: c.pool, venue: c.venue, hub: c.hub, depthUsd: Math.round(c.depthUsd), priceUsd: c.priceUsd })),
      liquid,
      pinned,
    });
  }
  for (const [a, v] of Object.entries(anchors)) {
    if (!tokens.some((t) => t.address === a)) tokens.push({ address: a, symbol: v.symbol, name: v.symbol, decimals: v.decimals, priceUsd: v.usd, priceSource: "chainlink", depthUsd: null, liquid: true, pinned: false, venues: [], pools: [] });
  }
  tokens.sort((a, b) => (b.depthUsd ?? Infinity) - (a.depthUsd ?? Infinity));
  // keep hot pools for every anchor-pair pool on the hot list too, so anchors' own depth stays fresh
  state.hot = [...nextHot];
  state.secondary = Object.keys(second);
  state.block = Number(latest);
  if (doFull) state.lastFull = Date.now();
  const summary = {
    mode: doFull ? "full" : "incremental",
    block: Number(latest),
    poolsKnown: registry.pools.length,
    poolsAdded: disc.added,
    poolsRead: selected.length,
    tokensPriced: merged.size,
    liquidTokens: tokens.filter((t) => t.liquid).length,
    hotPools: state.hot.length,
    minTvlUsd: minTvl,
    rpc: { ...rpc.stats, alchemyCuEquivalent: alchemyCuOf(rpc.stats) },
    ms: Date.now() - t0,
  };
  writeJson(paths(dataDir).state, state);
  writeJson(paths(dataDir).tokens, { updatedAt: new Date().toISOString(), block: Number(latest), minTvlUsd: minTvl, anchors, tokens, summary });
  return summary;
}
