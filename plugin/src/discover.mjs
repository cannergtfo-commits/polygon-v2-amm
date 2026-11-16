/**
 * Pool discovery from factory creation events. Incremental: each venue keeps a block cursor.
 * Registry rows are compact arrays: [venueId, pool, token0, token1, fee|null, block].
 */
import { TOPICS, VENUES } from "./config.mjs";
import { lower } from "./pricing.mjs";

const addrFromTopic = (t) => `0x${t.slice(26)}`.toLowerCase();
const addrFromWord = (data, i) => `0x${data.slice(2 + i * 64 + 24, 2 + (i + 1) * 64)}`.toLowerCase();

export function topicFor(kind) {
  if (kind === "v2") return TOPICS.pairCreated;
  if (kind === "v3") return TOPICS.poolCreated;
  return TOPICS.algebraPool;
}

/** Decode one creation log into a registry row, or null if it is not a pool we can use. */
export function decodeCreation(venue, log) {
  if (lower(log.address) !== lower(venue.factory)) return null;
  const topic0 = log.topics[0];
  const block = parseInt(log.blockNumber, 16);
  const token0 = addrFromTopic(log.topics[1]);
  const token1 = addrFromTopic(log.topics[2]);
  if (venue.kind === "v2" && topic0 === TOPICS.pairCreated) return [venue.id, addrFromWord(log.data, 0), token0, token1, null, block];
  if (venue.kind === "v3" && topic0 === TOPICS.poolCreated) return [venue.id, addrFromWord(log.data, 1), token0, token1, parseInt(log.topics[3], 16), block];
  if ((venue.kind === "algebra" || venue.kind === "algebra4") && topic0 === TOPICS.algebraPool) return [venue.id, addrFromWord(log.data, 0), token0, token1, null, block];
  return null;
}

export function emptyRegistry() {
  return { version: 1, cursors: {}, pools: [] };
}

/**
 * Bring the registry up to `toBlock`. Venues still at their start are scanned alone (big ranges);
 * venues that are already caught up share one combined eth_getLogs call per window.
 */
export async function discover(rpc, registry, toBlock, { venues = VENUES, log = () => {} } = {}) {
  const seen = new Set(registry.pools.map((row) => row[1]));
  let added = 0;
  const target = BigInt(toBlock);
  const behind = [];
  const caughtUp = [];
  for (const venue of venues) {
    const cursor = registry.cursors[venue.id];
    const from = cursor === undefined ? BigInt(venue.fromBlock) : BigInt(cursor) + 1n;
    if (from > target) continue;
    if (target - from > 200_000n) behind.push({ venue, from });
    else caughtUp.push({ venue, from });
  }
  const push = (venue, logs) => {
    for (const l of logs) {
      const row = decodeCreation(venue, l);
      if (!row || seen.has(row[1])) continue;
      seen.add(row[1]);
      registry.pools.push(row);
      added += 1;
    }
  };
  for (const { venue, from } of behind) {
    log(`discover ${venue.id} from ${from} to ${target}`);
    const logs = await rpc.getLogs({ address: venue.factory, topics: [topicFor(venue.kind)], fromBlock: from, toBlock: target });
    push(venue, logs);
    registry.cursors[venue.id] = Number(target);
  }
  if (caughtUp.length) {
    const from = caughtUp.reduce((m, v) => (v.from < m ? v.from : m), target);
    const logs = await rpc.getLogs({
      address: caughtUp.map((v) => v.venue.factory),
      topics: [[...new Set(caughtUp.map((v) => topicFor(v.venue.kind)))]],
      fromBlock: from,
      toBlock: target,
    });
    for (const { venue } of caughtUp) {
      push(venue, logs.filter((l) => lower(l.address) === lower(venue.factory)));
      registry.cursors[venue.id] = Number(target);
    }
  }
  return { added, total: registry.pools.length };
}

export function venueById(id, venues = VENUES) {
  return venues.find((v) => v.id === id);
}

/** Expand a compact row into an object. */
export function poolObject(row, venues = VENUES) {
  const venue = venueById(row[0], venues);
  return { venue: row[0], kind: venue.kind, address: row[1], token0: row[2], token1: row[3], fee: row[4], block: row[5] };
}
