import assert from "node:assert/strict";
import test from "node:test";
import { isLiquid, priceFromReserves, priceFromSqrt, priceTokens, secondaryHubs, toFloat, valuePool } from "../src/pricing.mjs";

const A = "0x000000000000000000000000000000000000000a";
const H = "0x00000000000000000000000000000000000000ff";
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`);

test("toFloat handles small, large and many-decimal amounts", () => {
  close(toFloat(1_500_000n, 6), 1.5);
  close(toFloat(123456789012345678901234567890n, 18), 123456789012.34568, 1e-12);
  assert.equal(toFloat(0n, 18), 0);
});

test("sqrt price converts with decimals (WETH 18 / USDC 6 at $2000)", () => {
  // price token0(WETH) in token1(USDC) raw = 2000 * 1e6 / 1e18 = 2e-9; sqrt * 2^96
  const sqrt = BigInt(Math.round(Math.sqrt(2e-9) * 2 ** 96));
  close(priceFromSqrt(sqrt, 18, 6), 2000, 1e-6);
  close(priceFromSqrt(2n ** 96n, 18, 18), 1);
});

test("reserve price", () => {
  close(priceFromReserves(10n ** 18n, 2000n * 10n ** 6n, 18, 6), 2000);
});

test("valuePool uses the smaller side for depth (lopsided concentrated pool counts low)", () => {
  const dec = { [A]: 18, [H]: 6 };
  // token A at 2 hub units; pool holds 1 A (= $2) and 1,000,000 hub (= $1M)
  const sqrt = BigInt(Math.round(Math.sqrt(2 * 1e6 / 1e18) * 2 ** 96));
  const v = valuePool({ kind: "v3", token0: A, token1: H, sqrtPriceX96: sqrt, bal0: 10n ** 18n, bal1: 10n ** 12n }, A, H, dec, 1);
  close(v.priceUsd, 2, 1e-6);
  close(v.hubSideUsd, 1_000_000, 1e-9);
  close(v.depthUsd, 4, 1e-6);
});

test("valuePool orientation: token as token1", () => {
  const dec = { [A]: 18, [H]: 6 };
  // token0 = hub (H < A lexically is false here, but valuePool trusts the pool's own order)
  const v = valuePool({ kind: "v2", token0: H, token1: A, reserve0: 5000n * 10n ** 6n, reserve1: 2500n * 10n ** 18n }, A, H, dec, 1);
  close(v.priceUsd, 2);
  close(v.depthUsd, 10_000);
});

test("priceTokens picks the deepest pool and reports dispersion", () => {
  const dec = { [A]: 18, [H]: 18 };
  const pools = [
    { address: "0x1", venue: "x", kind: "v2", token0: A, token1: H, reserve0: 300n * 10n ** 18n, reserve1: 600n * 10n ** 18n },
    { address: "0x2", venue: "y", kind: "v2", token0: A, token1: H, reserve0: 1000n * 10n ** 18n, reserve1: 2100n * 10n ** 18n },
  ];
  const out = priceTokens(pools, { [H]: { usd: 1 } }, dec);
  const e = out.get(A);
  assert.equal(e.best.pool, "0x2");
  close(e.best.priceUsd, 2.1);
  close(e.dispersion, Math.abs(2 / 2.1 - 1), 1e-9);
  assert.ok(isLiquid(e, 1000));
  assert.ok(!isLiquid(e, 10_000));
});

test("secondaryHubs needs depth and low dispersion and skips anchors", () => {
  const priced = new Map([
    [A, { best: { depthUsd: 300_000, priceUsd: 3 }, dispersion: 0.01 }],
    ["0xb", { best: { depthUsd: 300_000, priceUsd: 3 }, dispersion: 0.2 }],
    [H, { best: { depthUsd: 9e9, priceUsd: 1 }, dispersion: 0 }],
  ]);
  assert.deepEqual(Object.keys(secondaryHubs(priced, { [H]: {} })), [A]);
});
