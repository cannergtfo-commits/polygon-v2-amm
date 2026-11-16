import assert from "node:assert/strict";
import test from "node:test";
import { TOPICS, VENUES } from "../src/config.mjs";
import { decodeCreation, discover, emptyRegistry } from "../src/discover.mjs";

const pad = (a) => `0x${a.slice(2).padStart(64, "0")}`;
const T0 = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270";
const T1 = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const POOL = "0x00000000000000000000000000000000000000aa";
const v = (id) => VENUES.find((x) => x.id === id);

test("decodes V2 PairCreated, V3 PoolCreated and Algebra Pool logs", () => {
  const v2 = decodeCreation(v("quickswap-v2"), { address: v("quickswap-v2").factory, blockNumber: "0x10", topics: [TOPICS.pairCreated, pad(T0), pad(T1)], data: `${pad(POOL)}${"0".repeat(63)}1` });
  assert.deepEqual(v2, ["quickswap-v2", POOL, T0, T1, null, 16]);
  const v3 = decodeCreation(v("uniswap-v3"), { address: v("uniswap-v3").factory, blockNumber: "0x11", topics: [TOPICS.poolCreated, pad(T0), pad(T1), pad("0x1f4")], data: `${pad("0xa")}${pad(POOL).slice(2)}` });
  assert.deepEqual(v3, ["uniswap-v3", POOL, T0, T1, 500, 17]);
  const alg = decodeCreation(v("quickswap-v4"), { address: v("quickswap-v4").factory, blockNumber: "0x12", topics: [TOPICS.algebraPool, pad(T0), pad(T1)], data: pad(POOL) });
  assert.deepEqual(alg, ["quickswap-v4", POOL, T0, T1, null, 18]);
});

test("rejects logs from another factory or the wrong event", () => {
  assert.equal(decodeCreation(v("sushi"), { address: v("quickswap-v2").factory, blockNumber: "0x1", topics: [TOPICS.pairCreated, pad(T0), pad(T1)], data: pad(POOL) }), null);
  assert.equal(decodeCreation(v("uniswap-v3"), { address: v("uniswap-v3").factory, blockNumber: "0x1", topics: [TOPICS.pairCreated, pad(T0), pad(T1)], data: pad(POOL) }), null);
});

test("discover is incremental, dedupes, and uses one combined call once caught up", async () => {
  const venues = [v("quickswap-v2"), v("uniswap-v3")];
  const calls = [];
  const rpc = {
    async getLogs(q) {
      calls.push(q);
      const addrs = [].concat(q.address).map((a) => a.toLowerCase());
      const out = [];
      if (addrs.includes(venues[0].factory.toLowerCase())) out.push({ address: venues[0].factory, blockNumber: "0x64", topics: [TOPICS.pairCreated, pad(T0), pad(T1)], data: `${pad(POOL)}${"0".repeat(64)}` });
      return out;
    },
  };
  const reg = emptyRegistry();
  const first = await discover(rpc, reg, 30_000_000n, { venues });
  assert.equal(first.added, 1);
  assert.equal(calls.length, 2); // both venues behind: scanned separately
  const again = await discover(rpc, reg, 30_000_100n, { venues });
  assert.equal(again.added, 0); // same pool returned again is deduped
  assert.equal(calls.length, 3); // caught up: one combined call
  assert.ok(Array.isArray(calls[2].address) && calls[2].address.length === 2);
  assert.equal(calls[2].fromBlock, 30_000_001n);
  assert.equal(reg.cursors["uniswap-v3"], 30_000_100);
});
