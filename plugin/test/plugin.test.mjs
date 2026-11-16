import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { decodeFunctionData, encodeAbiParameters } from "viem";
import { ERC20 } from "../src/abis.mjs";
import { FEE_ROUTER, USDT } from "../src/config.mjs";
import { CANONICAL, createPlugin, DEFAULT_MAX_COST_VS_MID_BPS, parseAmount } from "../src/plugin.mjs";
import { sanitizeText, symbolKey, textFlags } from "../src/text.mjs";

const OWNER = "0x1111111111111111111111111111111111111111";
const FAKE_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FAKE_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const LOOK = "0xcccccccccccccccccccccccccccccccccccccccc";

function fixture(allowance = 0n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-"));
  const tokens = [
    { address: USDT.toLowerCase(), symbol: "USDT", name: "Tether", decimals: 6, priceUsd: 1, depthUsd: 5e6, venues: ["uniswap-v3"], liquid: true },
    { address: FAKE_A, symbol: "FOO", name: "Foo", decimals: 18, priceUsd: 2, depthUsd: 900_000, venues: ["sushi"], liquid: true },
    { address: FAKE_B, symbol: "foo", name: "Foo two", decimals: 18, priceUsd: 0.1, depthUsd: 20_000, venues: ["sushi"], liquid: true },
    { address: LOOK, symbol: "USDC", name: "USD Coin", decimals: 6, priceUsd: 1, depthUsd: 1e6, venues: ["sushi"], liquid: true, textFlags: ["impersonates"] },
  ];
  fs.writeFileSync(path.join(dir, "tokens.json"), JSON.stringify({ tokens, block: 1, updatedAt: "x", minTvlUsd: 10000 }));
  const calls = [];
  const rpc = {
    stats: { requests: {} },
    async call(to, data) {
      calls.push({ to, data });
      const d = decodeFunctionData({ abi: ERC20, data });
      if (d.functionName === "allowance") return encodeAbiParameters([{ type: "uint256" }], [allowance]);
      throw new Error("unexpected call " + d.functionName);
    },
    async request() { throw new Error("no network in unit tests"); },
  };
  return { plugin: createPlugin({ dataDir: dir, rpc }), calls };
}

test("sanitizeText strips bidi, zero-width and control characters", () => {
  assert.equal(sanitizeText("US\u200bDT\u202e\u0007"), "USDT");
  assert.equal(sanitizeText("ＵＳＤＣ"), "USDC"); // NFKC folds full-width
  assert.equal(sanitizeText("x".repeat(100)).length, 32);
});

test("textFlags marks look-alikes and impersonation, not canonical tokens", () => {
  assert.deepEqual(textFlags("USDC", "USD Coin", { canonical: true }).flags, []);
  assert.ok(textFlags("USDC", "USD Coin").flags.includes("impersonates"));
  assert.ok(textFlags("USDС", "x").flags.includes("nonAscii")); // Cyrillic С
  assert.ok(textFlags("WE\u200bTH", "x").flags.includes("changed"));
  assert.deepEqual(textFlags("LINK", "ChainLink Token").flags, []);
  assert.equal(symbolKey("USDС"), null);
  assert.equal(symbolKey("Link"), "link");
});

test("parseAmount is exact and rejects junk", () => {
  assert.equal(parseAmount("1.5", 6), 1_500_000n);
  assert.throws(() => parseAmount("1e18", 18), /plain decimal/);
  assert.throws(() => parseAmount("0", 18), /greater than 0/);
  assert.throws(() => parseAmount("0.0000001", 6), /decimal places/);
});

test("read resolve: symbol picks the deepest token and lists the others", async () => {
  const { plugin } = fixture();
  const r = await plugin.resolve("FOO");
  assert.equal(r.address, FAKE_A);
  assert.equal(r.resolvedBy, "symbol");
  assert.deepEqual(r.ambiguous.map((x) => x.address), [FAKE_B]);
  assert.ok(r.warnings.some((w) => w.startsWith("AMBIGUOUS_SYMBOL")));
});

test("canonical symbols never resolve to a look-alike", async () => {
  const { plugin } = fixture();
  assert.equal(Object.keys(CANONICAL).includes("usdc"), true);
  // the look-alike token carries symbol "USDC" but USDC resolves from the fixed table
  const { plugin: p2 } = fixture();
  const list = p2.listTokens({});
  assert.ok(list.tokens.find((t) => t.address === LOOK).textFlags.includes("impersonates"));
  const r = await plugin.resolve("USDT");
  assert.equal(r.address, USDT.toLowerCase());
  assert.equal(r.resolvedBy, "canonical-symbol");
});

test("builders refuse non-canonical symbols", async () => {
  const { plugin } = fixture();
  await assert.rejects(plugin.resolve("FOO", { strict: true }), (e) => e.code === "ADDRESS_REQUIRED" && e.details.candidates.length === 2);
  await assert.rejects(plugin.buildApprove({ token: "FOO", amount: "1", owner: OWNER }), (e) => e.code === "ADDRESS_REQUIRED");
});

test("listTokens reports shared symbols", () => {
  const { plugin } = fixture();
  const foo = plugin.listTokens({ search: "foo" }).tokens;
  assert.equal(foo.length, 2);
  assert.ok(foo.every((t) => t.sharedSymbol === 2));
});

test("buildApprove: exact amount, unsigned, no reset when allowance is 0", async () => {
  const { plugin } = fixture(0n);
  const r = await plugin.buildApprove({ token: USDT, amount: "25.5", owner: OWNER });
  assert.equal(r.txs.length, 1);
  const d = decodeFunctionData({ abi: ERC20, data: r.txs[0].data });
  assert.equal(d.functionName, "approve");
  assert.equal(d.args[0].toLowerCase(), FEE_ROUTER.toLowerCase());
  assert.equal(d.args[1], 25_500_000n);
  assert.match(r.signing, /UNSIGNED/);
  assert.equal("signature" in r.txs[0], false);
});

test("buildApprove: resets to 0 first when an allowance exists (USDT style)", async () => {
  const { plugin } = fixture(7n);
  const r = await plugin.buildApprove({ token: USDT, amount: "1", owner: OWNER });
  const vals = r.txs.map((t) => decodeFunctionData({ abi: ERC20, data: t.data }).args[1]);
  assert.deepEqual(vals, [0n, 1_000_000n]);
});

test("buildApprove: rejects unlimited and warns on unknown spender", async () => {
  const { plugin } = fixture();
  await assert.rejects(plugin.buildApprove({ token: USDT, amount: (2n ** 256n - 1n).toString(), amountIsBaseUnits: true, owner: OWNER }));
  const r = await plugin.buildApprove({ token: USDT, amount: "1", owner: OWNER, spender: OWNER });
  assert.ok(r.warnings.some((w) => w.startsWith("UNKNOWN_SPENDER")));
});

test("buildSwap input validation happens before any network call", async () => {
  const { plugin } = fixture();
  await assert.rejects(plugin.buildSwap({ tokenIn: USDT, tokenOut: FAKE_A, amount: "1", from: "nope" }), (e) => e.code === "BAD_ADDRESS");
  await assert.rejects(plugin.buildSwap({ tokenIn: USDT, tokenOut: FAKE_A, amount: "1", from: OWNER, deadlineSeconds: 600 }), (e) => e.code === "BAD_DEADLINE");
  await assert.rejects(plugin.buildSwap({ tokenIn: USDT, tokenOut: FAKE_A, amount: "1", from: OWNER, slippageBps: 1000 }), (e) => e.code === "BAD_SLIPPAGE");
  await assert.rejects(plugin.buildSwap({ tokenIn: USDT, tokenOut: FAKE_A, amount: "1", from: OWNER, recipient: FEE_ROUTER }), (e) => e.code === "BAD_RECIPIENT");
});

test("price-impact ceiling defaults to 300 bps and is validated", async () => {
  assert.equal(DEFAULT_MAX_COST_VS_MID_BPS, 300);
  const { plugin } = fixture();
  for (const bad of [0, 10_001, 1.5, -1]) {
    await assert.rejects(plugin.buildSwap({ tokenIn: USDT, tokenOut: FAKE_A, amount: "1", from: OWNER, maxCostVsMidBps: bad }), (e) => e.code === "BAD_INPUT");
  }
});

const LIVE = process.env.POLYGON_LIVE === "1";
test("live: a 60k USDC -> LINK swap (~7% below mid) is refused by default, allowed with an explicit opt-in", { skip: !LIVE }, async () => {
  const p = createPlugin();
  const LINK = "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39";
  await assert.rejects(p.buildSwap({ tokenIn: "USDC", tokenOut: LINK, amount: "60000", from: OWNER }), (e) => e.code === "PRICE_IMPACT_TOO_HIGH" && e.details.maxCostVsMidBps === 300);
  const ok = await p.buildSwap({ tokenIn: "USDC", tokenOut: LINK, amount: "60000", from: OWNER, maxCostVsMidBps: 1500 });
  assert.ok(ok.txs.length >= 1);
});
test("live: native output to a recipient with code is refused; fresh deadline", { skip: !LIVE }, async () => {
  const p = createPlugin();
  const LINK = "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39";
  await assert.rejects(p.buildSwap({ tokenIn: LINK, tokenOut: "POL", amount: "1", from: OWNER, recipient: "0x6F47aa396215ab22647dDB3E86b4663DFe11dB14" /* has code */ }), (e) => e.code === "RECIPIENT_HAS_CODE");
  const b = await p.buildSwap({ tokenIn: "USDC", tokenOut: LINK, amount: "10", from: OWNER, deadlineSeconds: 60 });
  assert.equal(Number(b.guards.deadline) - b.guards.deadlineFromBlock, 60);
  assert.equal(b.txs.at(-1).to, FEE_ROUTER);
  assert.ok(BigInt(b.guards.minAmountOut) > 0n);
});
