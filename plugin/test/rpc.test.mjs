import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeFunctionResult, parseAbi } from "viem";
import { alchemyCuOf, createRpc } from "../src/rpc.mjs";

const MC = parseAbi(["struct Result { bool success; bytes returnData; }", "function aggregate3((address,bool,bytes)[] calls) payable returns (Result[] returnData)"]);

function fakeFetch(handler) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const result = await handler(url, body.method, body.params);
    const text = JSON.stringify(result.error ? { jsonrpc: "2.0", id: body.id, error: result.error } : { jsonrpc: "2.0", id: body.id, result: result.ok });
    return { status: 200, text: async () => text };
  };
}

test("getLogs shrinks the window on range errors and covers the whole span", async () => {
  const seen = [];
  const rpc = createRpc({
    logUrls: [{ url: "http://a", maxRange: 100_000 }],
    fetchImpl: fakeFetch((url, m, [q]) => {
      const span = Number(BigInt(q.toBlock) - BigInt(q.fromBlock)) + 1;
      if (span > 30_000) return { error: { code: -32000, message: "range too large" } };
      seen.push([Number(BigInt(q.fromBlock)), Number(BigInt(q.toBlock))]);
      return { ok: [] };
    }),
  });
  await rpc.getLogs({ address: "0x1", topics: [], fromBlock: 0n, toBlock: 99_999n });
  seen.sort((a, b) => a[0] - b[0]);
  assert.equal(seen[0][0], 0);
  assert.equal(seen[seen.length - 1][1], 99_999);
  for (let i = 1; i < seen.length; i++) assert.equal(seen[i][0], seen[i - 1][1] + 1);
});

test("getLogs falls back to the next endpoint", async () => {
  const rpc = createRpc({
    logUrls: [{ url: "http://bad", maxRange: 5000 }, { url: "http://good", maxRange: 5000 }],
    fetchImpl: fakeFetch((url) => (url.includes("bad") ? { error: { code: -1, message: "down" } } : { ok: [{ x: 1 }] })),
  });
  const out = await rpc.getLogs({ address: "0x1", topics: [], fromBlock: 0n, toBlock: 10n });
  assert.equal(out.length, 1);
});

test("multicall decodes per-item success and failure and counts requests", async () => {
  const rpc = createRpc({
    callUrls: ["http://a"],
    fetchImpl: fakeFetch((url, method) => {
      assert.equal(method, "eth_call");
      const data = encodeFunctionResult({
        abi: MC,
        functionName: "aggregate3",
        result: [
          { success: true, returnData: encodeAbiParameters([{ type: "uint256" }], [42n]) },
          { success: false, returnData: "0x" },
        ],
      });
      return { ok: data };
    }),
  });
  const abi = parseAbi(["function decimals() view returns (uint8)"]);
  const rows = await rpc.multicall([
    { to: "0x0000000000000000000000000000000000000001", abi, functionName: "decimals" },
    { to: "0x0000000000000000000000000000000000000002", abi, functionName: "decimals" },
  ]);
  assert.equal(rows[0].ok, true);
  assert.equal(rows[0].value, 42);
  assert.equal(rows[1].ok, false);
  assert.equal(rpc.stats.requests.eth_call, 1);
  assert.equal(alchemyCuOf(rpc.stats), 26);
});

test("call endpoints fail over but a revert is not retried", async () => {
  let hits = 0;
  const rpc = createRpc({
    callUrls: ["http://a", "http://b"],
    fetchImpl: fakeFetch(() => {
      hits += 1;
      return { error: { code: 3, message: "execution reverted" } };
    }),
  });
  await assert.rejects(rpc.call("0x1", "0x"));
  assert.equal(hits, 1);
});
