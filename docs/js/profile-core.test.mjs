// node docs/js/profile-core.test.mjs
import assert from "node:assert/strict";
import {
  AAVE_V3,
  NATIVE,
  WPOL,
  aaveLines,
  blockscoutErc20s,
  capByDepth,
  fmtRaw,
  fmtPrice,
  dexBatches,
  fmtAmount,
  fmtUsd,
  groupPositions,
  healthLabel,
  isAddress,
  oraclePrice,
  pickDexPrice,
  priceKey,
  protocolOf,
  rankTokens,
  recentDayIds,
  sumPieces,
  usdOf,
} from "./profile-core.mjs";

const YGG = "0x82617aA52dddf5Ed9Bb7B370ED777b3182A30fd1";

// USD math keeps precision for 6- and 18-decimal tokens.
assert.equal(usdOf(2_500_000n, 6, 1), 2.5);
assert.ok(Math.abs(usdOf(871n * 10n ** 18n, 18, 0.12) - 104.52) < 1e-9);
assert.equal(usdOf(0n, 18, 5), 0);
assert.equal(usdOf(10n, 18, null), null);

// Native POL prices as WPOL.
assert.equal(priceKey(NATIVE), WPOL.toLowerCase());
assert.equal(priceKey(YGG), YGG.toLowerCase());

// DexScreener: deepest pool wins; quote-side pools invert through priceNative.
const pairs = [
  { chainId: "polygon", baseToken: { address: YGG }, quoteToken: { address: WPOL }, priceUsd: "0.0205", priceNative: "0.25", liquidity: { usd: 130 } },
  { chainId: "polygon", baseToken: { address: "0x1111111111111111111111111111111111111111" }, quoteToken: { address: YGG }, priceUsd: "2", priceNative: "100", liquidity: { usd: 5000 } },
  { chainId: "ethereum", baseToken: { address: YGG }, priceUsd: "9", liquidity: { usd: 1e9 } },
];
const pick = pickDexPrice(pairs, YGG.toLowerCase());
assert.equal(pick.price, 0.02);
assert.equal(pick.thin, false);
assert.equal(pickDexPrice(pairs.slice(0, 1), YGG).thin, true);
assert.equal(pickDexPrice([], YGG), null);
assert.equal(pickDexPrice(null, YGG), null);

// Batching drops native, dedupes, and splits at 30.
const many = Array.from({ length: 65 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
const batches = dexBatches([...many, many[0].toUpperCase().replace("0X", "0x"), NATIVE]);
assert.deepEqual(batches.map((b) => b.length), [30, 30, 5]);

assert.equal(oraclePrice(8_085_300n, 8), 0.080853);
assert.equal(oraclePrice(0n), null);

// Token ranking: priced first, dust hidden, top N with expand.
const rows = [
  { symbol: "YGG", amount: 3070n, usd: 57.3 },
  { symbol: "POL", amount: 5n, usd: 12 },
  { symbol: "DUST", amount: 1n, usd: 0.2 },
  { symbol: "SPAM", amount: 9n, usd: null },
  { symbol: "ZERO", amount: 0n, usd: 0 },
  ...Array.from({ length: 7 }, (_, i) => ({ symbol: `T${i}`, amount: 1n, usd: 2 + i })),
];
const ranked = rankTokens(rows);
assert.equal(ranked.shown.length, 6);
assert.equal(ranked.shown[0].symbol, "YGG");
assert.equal(ranked.count, 9);
assert.equal(ranked.more, 3);
assert.equal(ranked.hiddenSmall, 2);
assert.equal(rankTokens(rows, { expanded: true }).shown.length, 9);
const withSmall = rankTokens(rows, { showSmall: true, expanded: true });
assert.equal(withSmall.shown.length, 11);
assert.equal(withSmall.shown.at(-1).symbol, "SPAM");
assert.ok(Math.abs(withSmall.total - (57.3 + 12 + 0.2 + 2 + 3 + 4 + 5 + 6 + 7 + 8)) < 1e-9);

// Protocol mapping and grouping.
assert.equal(protocolOf("quickswap-v4"), "quickswap");
assert.equal(protocolOf("quickswap"), "quickswap");
assert.equal(protocolOf("uniswap-v3"), "uniswap");
assert.equal(protocolOf("blazar"), "blazar");
const groups = groupPositions([
  { protocol: "quickswap", usd: 100 },
  { protocol: "quickswap", usd: 50 },
  { protocol: "aave", usd: 300 },
  { protocol: "aave", usd: -120 },
  { protocol: "blazar", usd: null },
]);
assert.deepEqual(groups.map((g) => g.id), ["aave", "quickswap", "blazar"]);
assert.equal(groups[0].usd, 180);
assert.equal(groups[1].positions[0].usd, 100);
assert.equal(groups[2].unpriced, 1);

// Partial pricing is flagged.
const pieces = sumPieces([
  { amount: 10n ** 18n, decimals: 18, price: 2 },
  { amount: 5n, decimals: 0, price: null },
  { amount: 0n, decimals: 0, price: null },
]);
assert.equal(pieces.usd, 2);
assert.equal(pieces.partial, true);

// Aave: supplied, borrowed, net.
const reserves = [
  { asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", symbol: "USDC", decimals: 6, price: 1 },
  { asset: WPOL, symbol: "WPOL", decimals: 18, price: 0.1 },
];
const lines = aaveLines(reserves, [
  [5_739_113_578n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, true],
  [0n, 0n, 1000n * 10n ** 18n, 0n, 0n, 0n, 0n, 0n, false],
]);
assert.equal(lines.supplied.length, 1);
assert.equal(lines.borrowed.length, 1);
assert.ok(Math.abs(lines.suppliedUsd - 5739.113578) < 1e-6);
assert.equal(lines.borrowedUsd, 100);
assert.ok(Math.abs(lines.netUsd - 5639.113578) < 1e-6);
assert.equal(lines.supplied[0].collateral, true);
assert.equal(healthLabel((1n << 256n) - 1n), "No debt");
assert.equal(healthLabel(1_523_400_000_000_000_000n), "Health 1.52");
assert.match(AAVE_V3.pool, /^0x794a61358D6845594F94dc1DB02A252b5b4814aD$/);

assert.deepEqual(recentDayIds(86400 * 10 + 5, 3), [10, 9, 8]);

assert.equal(fmtUsd(1234.5), "$1,235");
assert.equal(fmtUsd(12.345), "$12.35");
assert.equal(fmtUsd(0.004), "<$0.01");
assert.equal(fmtUsd(-120), "-$120.00");
assert.equal(fmtUsd(null), "—");
assert.equal(fmtAmount(3070.833), "3070.83");
assert.equal(fmtAmount(12345), "12.3K");
assert.equal(fmtAmount(0.0042), "0.0042");

assert.ok(isAddress("0x6F47aa396215ab22647dDB3E86b4663DFe11dB14"));
assert.ok(!isAddress("0x6F47"));

assert.deepEqual(
  blockscoutErc20s([
    { token: { type: "ERC-20", address_hash: YGG } },
    { token: { type: "ERC-721", address_hash: WPOL } },
    { token: { type: "ERC-20", address: WPOL } },
    { token: {} },
  ]),
  [YGG, WPOL],
);

// Thin pools cap wallet value at half the pool's USD liquidity.
assert.deepEqual(capByDepth(1458, 266.84), { usd: 133.42, capped: true });
assert.deepEqual(capByDepth(50, 266.84), { usd: 50, capped: false });
assert.deepEqual(capByDepth(50, undefined), { usd: 50, capped: false });
assert.deepEqual(capByDepth(null, 10), { usd: null, capped: false });
assert.equal(fmtRaw(1n, 8), "<0.0001");
assert.equal(fmtRaw(0n, 8), "0");
assert.equal(fmtRaw(150000000n, 8), "1.5");

assert.equal(fmtPrice(0.006886), "$0.00689");
assert.equal(fmtPrice(2.609e-9), "$2.61e-9");
assert.equal(fmtPrice(0.0805), "$0.08");
assert.equal(fmtPrice(null), "—");

console.log("profile-core tests ok");
