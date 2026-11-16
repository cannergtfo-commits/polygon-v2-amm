import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData } from "viem";
import { FEE_ROUTER_ABI } from "../src/abis.mjs";
import { FEE_ROUTER, NATIVE, VENUES, WPOL } from "../src/config.mjs";
import { buildPairIndex, quote } from "../src/quote.mjs";
import { executableVenues } from "../src/router.mjs";
import { buildApproveTx, buildSwapTx, encodeTarget } from "../src/tx.mjs";
import * as desk from "../../docs/js/desk-core.mjs";

const w = WPOL.toLowerCase();
const X = "0x00000000000000000000000000000000000000f1"; // test token, sorts below WPOL
const v = (id) => VENUES.find((x) => x.id === id);

function routerState(over = {}) {
  const v2FeeBps = {};
  const allowedTarget = {};
  for (const x of VENUES) {
    if (x.kind === "v2") v2FeeBps[x.factory.toLowerCase()] = 30;
    else allowedTarget[x.router.toLowerCase()] = true;
  }
  return { address: FEE_ROUTER, feeBps: 5, paused: false, blazarFactory: v("blazar").factory, v2FeeBps, allowedTarget, readAt: Date.now(), ...over };
}

/** Fake rpc: answers getReserves by pool address; every quoter call fails (no concentrated pools). */
function fakeRpc(reserves) {
  return {
    async multicall(items) {
      return items.map((it) => {
        const r = reserves[it.to.toLowerCase()];
        if (!r || it.abi) return { ok: false, data: "0x" };
        const hex = (n) => n.toString(16).padStart(64, "0");
        return { ok: true, data: `0x${hex(r[0])}${hex(r[1])}${hex(0n)}` };
      });
    },
  };
}

test("executableVenues follows the live allowlist", () => {
  const r = routerState();
  r.v2FeeBps[v("apeswap").factory.toLowerCase()] = 0;
  r.allowedTarget[v("quickswap-v4").router.toLowerCase()] = false;
  const ids = executableVenues(r).map((x) => x.id);
  assert.ok(!ids.includes("apeswap"));
  assert.ok(!ids.includes("quickswap-v4"));
  assert.ok(ids.includes("blazar") && ids.includes("uniswap-v3"));
});

test("quote picks the deeper V2 pool, charges 5 bps on external principal, none on Blazar", async () => {
  const rows = [
    ["quickswap-v2", "0x00000000000000000000000000000000000000a1", X, w, null, 1],
    ["blazar", "0x00000000000000000000000000000000000000a2", X, w, null, 1],
  ];
  const index = buildPairIndex(rows);
  // QuickSwap deep, Blazar shallow
  const rpc = fakeRpc({ [rows[0][1]]: [10n ** 24n, 10n ** 24n], [rows[1][1]]: [10n ** 20n, 10n ** 20n] });
  const q = await quote({ rpc, index, router: routerState(), tokenIn: NATIVE, tokenOut: X, amountIn: 10n ** 18n, hubs: [] });
  assert.equal(q.steps[0].venue, "QuickSwap v2");
  assert.equal(q.wrapperFees[0].amount, 5n * 10n ** 14n);
  const expected = desk.quoteV2(10n ** 18n - 5n * 10n ** 14n, 10n ** 24n, 10n ** 24n, 30);
  assert.equal(q.amountOut, expected);

  // make Blazar the deep one: it wins and pays no wrapper fee
  const rpc2 = fakeRpc({ [rows[0][1]]: [10n ** 20n, 10n ** 20n], [rows[1][1]]: [10n ** 24n, 10n ** 24n] });
  const q2 = await quote({ rpc: rpc2, index, router: routerState(), tokenIn: NATIVE, tokenOut: X, amountIn: 10n ** 18n, hubs: [] });
  assert.equal(q2.steps[0].venue, "BlazarSwap");
  assert.equal(q2.wrapperFees.length, 0);
});

test("quote ignores venues the router does not allow", async () => {
  const rows = [["sushi", "0x00000000000000000000000000000000000000a3", X, w, null, 1]];
  const r = routerState();
  r.v2FeeBps[v("sushi").factory.toLowerCase()] = 0;
  const q = await quote({ rpc: fakeRpc({ [rows[0][1]]: [10n ** 24n, 10n ** 24n] }), index: buildPairIndex(rows), router: r, tokenIn: NATIVE, tokenOut: X, amountIn: 10n ** 18n, hubs: [] });
  assert.equal(q.best, null);
});

test("quote refuses while the router is paused", async () => {
  await assert.rejects(quote({ rpc: fakeRpc({}), index: new Map(), router: routerState({ paused: true }), tokenIn: NATIVE, tokenOut: X, amountIn: 1n }), /paused/);
});

test("buildSwapTx encodes a router swap with a deadline inside the 180 s window", async () => {
  const rows = [["quickswap-v2", "0x00000000000000000000000000000000000000a1", X, w, null, 1]];
  const q = await quote({ rpc: fakeRpc({ [rows[0][1]]: [10n ** 24n, 10n ** 24n] }), index: buildPairIndex(rows), router: routerState(), tokenIn: NATIVE, tokenOut: X, amountIn: 10n ** 18n, hubs: [] });
  const recipient = "0x1111111111111111111111111111111111111111";
  const tx = buildSwapTx({ quote: q, recipient, blockTime: 1_000_000, slippageBps: 50 });
  assert.equal(tx.to, FEE_ROUTER);
  assert.equal(tx.value, 10n ** 18n);
  assert.equal(tx.approval, null);
  const d = decodeFunctionData({ abi: FEE_ROUTER_ABI, data: tx.data });
  assert.equal(d.functionName, "swap");
  const [tokenIn, tokenOut, amountIn, minOut, rcpt, deadline, unwrap, calls] = d.args;
  assert.equal(tokenIn, NATIVE);
  assert.equal(tokenOut.toLowerCase(), X);
  assert.equal(amountIn, 10n ** 18n);
  assert.equal(minOut, (q.amountOut * 9950n) / 10000n);
  assert.equal(rcpt.toLowerCase(), recipient);
  assert.ok(deadline > 1_000_000n && deadline <= 1_000_180n);
  assert.equal(unwrap, false);
  assert.equal(calls[0].kind, 1);
  assert.equal(calls[0].target.toLowerCase(), v("quickswap-v2").factory.toLowerCase());
  assert.ok(calls[0].minBuy > 0n);
});

test("buildSwapTx rejects a bad recipient and slippage over 20%", async () => {
  const rows = [["quickswap-v2", "0x00000000000000000000000000000000000000a1", X, w, null, 1]];
  const q = await quote({ rpc: fakeRpc({ [rows[0][1]]: [10n ** 24n, 10n ** 24n] }), index: buildPairIndex(rows), router: routerState(), tokenIn: NATIVE, tokenOut: X, amountIn: 10n ** 18n, hubs: [] });
  assert.throws(() => buildSwapTx({ quote: q, recipient: "0x123", blockTime: 1 }));
  assert.throws(() => buildSwapTx({ quote: q, recipient: "0x1111111111111111111111111111111111111111", blockTime: 1, slippageBps: 2500 }));
});

test("encodeTarget offsets match for all three concentrated adapters", () => {
  for (const kind of ["v3", "algebra", "algebra4"]) {
    const step = { kind, router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", tokenIn: WPOL, tokenOut: X, feeTier: 500 };
    const plan = desk.targetPlan(step, FEE_ROUTER, 123n, 777n);
    const data = encodeTarget(plan);
    const word = (off) => BigInt(`0x${data.slice(2 + Number(off) * 2, 2 + Number(off) * 2 + 64)}`);
    assert.equal(word(plan.amountOffset), 0n, kind);
    assert.equal(word(plan.minOffset), 777n, kind);
  }
});

test("approval is exact, never unlimited", () => {
  const tx = buildApproveTx({ token: X, amount: 123n });
  assert.ok(tx.data.endsWith("7b"));
  assert.throws(() => buildApproveTx({ token: X, amount: (1n << 256n) - 1n }));
});
