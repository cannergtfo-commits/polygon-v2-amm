// node docs/js/lp-positions.test.mjs
import assert from "node:assert/strict";
import {
  BZB,
  DEFAULT_HUBS,
  LP_NFT_MANAGERS,
  LP_V2_FACTORIES,
  MAX_TICK,
  MIN_TICK,
  NO_ROUTE_VENUES,
  Q96,
  WPOL,
  amountsForLiquidity,
  countLabel,
  feeLabel,
  getSqrtRatioAtTick,
  inRange,
  isFullRange,
  isOpenPosition,
  manageUrl,
  rangeLabel,
  v2CandidateQueries,
  v2ShareAndAmounts,
} from "./lp-positions.mjs";

assert.equal(getSqrtRatioAtTick(0), Q96);

// A live price sits inside its tick, not necessarily at the tick boundary.
const liveSqrt = 155284609216271881270630352564n;
assert.ok(liveSqrt >= getSqrtRatioAtTick(13459) && liveSqrt < getSqrtRatioAtTick(13460));

const liquidity = 1422292699752019448334n;
const amounts = amountsForLiquidity(liveSqrt, MIN_TICK, MAX_TICK, liquidity);
// Pool reserves were ~725.68 WPOL and ~2787.65 YGG; this NFT is the sole LP.
assert.ok(amounts.amount0 > 700n * 10n ** 18n && amounts.amount0 < 750n * 10n ** 18n, String(amounts.amount0));
assert.ok(amounts.amount1 > 2700n * 10n ** 18n && amounts.amount1 < 2900n * 10n ** 18n, String(amounts.amount1));

assert.equal(inRange(13459, MIN_TICK, MAX_TICK), true);
assert.equal(inRange(-10, 0, 100), false);
assert.equal(inRange(100, 0, 100), false);
assert.equal(isFullRange(MIN_TICK, MAX_TICK), true);
assert.equal(isFullRange(-100, 100), false);
assert.equal(isOpenPosition(0n, 0n, 0n), false);
assert.equal(isOpenPosition(1n, 0n, 0n), true);
assert.equal(isOpenPosition(0n, 1n, 0n), true);

const share = v2ShareAndAmounts(25n, 100n, 400n, 100n);
assert.equal(share.amount0, 25n);
assert.equal(share.amount1, 100n);
assert.equal(share.shareBps, 25);
assert.deepEqual(v2ShareAndAmounts(0n, 1n, 1n, 1n), { amount0: 0n, amount1: 0n, shareBps: 0 });

assert.equal(feeLabel(500), "0.05%");
assert.equal(feeLabel(3000), "0.3%");
assert.equal(feeLabel(10000), "1%");
assert.equal(rangeLabel({ tickLower: MIN_TICK, tickUpper: MAX_TICK, tick: 0, inRange: true }), "Full range · in range");
assert.match(rangeLabel({ tickLower: -100, tickUpper: 100, tick: 200, inRange: false }), /out of range/);

assert.equal(manageUrl("uniswap-v3", { tokenId: 198 }), "https://app.uniswap.org/positions/v3/polygon/198");
assert.equal(manageUrl("quickswap-v4", { tokenId: 850 }), "https://quickswap.exchange/#/pool/850");
assert.match(manageUrl("quickswap", { token0: WPOL, token1: BZB }), /remove/);

assert.equal(LP_NFT_MANAGERS.length, 3);
assert.equal(LP_NFT_MANAGERS[2].manager, "0x7219C5d9928DB34973b5397d0b6ef00622dD3E8f");
assert.equal(LP_NFT_MANAGERS[2].factory, "0x134c1dBE4860A9cAaf89002574fFe814772D9904");
assert.ok(LP_V2_FACTORIES.some((row) => row.id === "quickswap"));

const queries = v2CandidateQueries([WPOL, BZB, "0x82617aA52dddf5Ed9Bb7B370ED777b3182A30fd1"], DEFAULT_HUBS);
const yggWpol = queries.filter((q) =>
  q.venueId === "quickswap"
  && [q.a, q.b].map((a) => a.toLowerCase()).includes("0x82617aa52dddf5ed9bb7b370ed777b3182a30fd1")
  && [q.a, q.b].map((a) => a.toLowerCase()).includes(WPOL.toLowerCase())
);
assert.equal(yggWpol.length, 1);
// No duplicate unordered pairs.
const keys = new Set(queries.map((q) => q.key));
assert.equal(keys.size, queries.length);
// Blazar is excluded from the candidate scan (listed via allPairs).
assert.equal(queries.some((q) => q.venueId === "blazar"), false);

assert.equal(countLabel([]), "No liquidity in this wallet yet.");
assert.equal(countLabel([{ venue: "QuickSwap v4" }, { venue: "QuickSwap v4" }, { venue: "Uniswap v3" }]), "2 QuickSwap v4 · 1 Uniswap v3");
assert.match(NO_ROUTE_VENUES, /QuickSwap v4/);

console.log("lp-positions tests ok");
