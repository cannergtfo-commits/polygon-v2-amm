// node docs/js/stake-multi-core.test.mjs
import assert from "node:assert/strict";
import {
  CURVE_PRESETS,
  GAS_FLOOR,
  GAS_FLOOR_PAYOUT,
  GAS_FLOOR_STAKE,
  LIMITS,
  aprPercent,
  curveDetail,
  curveEmitted,
  curveKind,
  curveLabel,
  curvePreviewPaths,
  curveRate,
  curveSamples,
  daysHoursToSec,
  durationLabel,
  formatApr,
  gasLimitFor,
  verifyDeployment,
  EXPECTED_DEPLOYMENT,
  parseAddressList,
  runStatus,
  startTimeFor,
  sumApr,
  toFloatUnits,
  validateNewTokens,
  validateRecover,
  validateRuns,
} from "./stake-multi-core.mjs";

let n = 0;
const test = (name, fn) => { fn(); n++; };
const E18 = 10n ** 18n;
const DAY = 86_400;
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const SELF = "0x3333333333333333333333333333333333333333";

test("curveEmitted endpoints and monotonic for every preset", () => {
  const amount = 30_000n * 10n ** 6n;
  const d = 30 * DAY;
  for (const p of Object.values(CURVE_PRESETS)) {
    assert.equal(curveEmitted(amount, d, p.startWeight, p.endWeight, 0), 0n);
    assert.equal(curveEmitted(amount, d, p.startWeight, p.endWeight, d), amount);
    assert.equal(curveEmitted(amount, d, p.startWeight, p.endWeight, d + 5), amount);
    let last = 0n;
    for (let x = 0; x <= d; x += 3_600) {
      const v = curveEmitted(amount, d, p.startWeight, p.endWeight, x);
      assert.ok(v >= last, "non-decreasing");
      assert.ok(v <= amount);
      last = v;
    }
  }
});

test("flat curve is linear; ramp up emits less early, ramp down more", () => {
  const amount = 1000n * E18;
  const d = 10 * DAY;
  assert.equal(curveEmitted(amount, d, 10_000, 10_000, d / 2), amount / 2n);
  assert.equal(curveEmitted(amount, d, 5, 5, d / 4), amount / 4n);
  assert.ok(curveEmitted(amount, d, 2_000, 10_000, d / 2) < amount / 2n);
  assert.ok(curveEmitted(amount, d, 10_000, 2_000, d / 2) > amount / 2n);
});

test("curveEmitted matches the closed form exactly (contract vectors)", () => {
  // E(x) = amount*(s*x*(2D-x) + e*x^2) / (D^2*(s+e)), floor
  const amount = 12_345n * E18 + 6789n;
  const d = 7 * DAY;
  const x = 123_457;
  const s = 2_000n;
  const e = 10_000n;
  const want = (amount * (s * BigInt(x) * (2n * BigInt(d) - BigInt(x)) + e * BigInt(x) * BigInt(x))) / (BigInt(d) * BigInt(d) * (s + e));
  assert.equal(curveEmitted(amount, d, 2_000, 10_000, x), want);
  // zero start weight (pure ramp from 0)
  assert.equal(curveEmitted(100n, 100, 0, 10_000, 50), 25n);
});

test("curveRate: flat = amount/D, ramps hit 2s/(s+e) and 2e/(s+e) of average", () => {
  const amount = 864n * E18;
  const d = DAY;
  assert.equal(curveRate(amount, d, 10_000, 10_000, 0), amount / BigInt(d));
  assert.equal(curveRate(amount, d, 10_000, 10_000, d), 0n);
  assert.equal(curveRate(amount, d, 10_000, 10_000, -1), 0n);
  const avg = amount / BigInt(d);
  const up0 = curveRate(amount, d, 2_000, 10_000, 0);
  assert.equal(up0, (avg * 2n * 2_000n) / 12_000n);
  assert.ok(curveRate(amount, d, 2_000, 10_000, d - 1) > up0);
  // rate integrates (sum per second) to ~amount
  let sum = 0n;
  const small = 1_000n * 10n ** 6n;
  for (let x = 0; x < 3_600; x++) sum += curveRate(small * 1_000_000n, 3_600, 10_000, 2_000, x);
  const total = small * 1_000_000n;
  const diff = sum > total ? sum - total : total - sum;
  assert.ok(diff < total / 1000n);
});

test("curve labels and detail", () => {
  assert.equal(curveKind(10_000, 10_000), "flat");
  assert.equal(curveKind(2_000, 10_000), "up");
  assert.equal(curveKind(10_000, 2_000), "down");
  assert.equal(curveLabel(1, 1), "Flat");
  assert.equal(curveLabel(0, 1), "Ramping up");
  assert.equal(curveLabel(9, 1), "Ramping down");
  assert.equal(curveDetail(2_000, 10_000), "Ends 5× faster than it starts");
  assert.equal(curveDetail(10_000, 2_000), "Ends at 20% of the start rate");
  assert.equal(curveDetail(0, 10_000), "Starts at zero and rises");
  assert.equal(curveDetail(10_000, 0), "Falls to zero at the end");
});

test("curve preview samples and SVG paths", () => {
  const up = curveSamples(2_000, 10_000, 8);
  assert.equal(up.length, 9);
  assert.equal(up[0].rate, 0.2);
  assert.equal(up[8].rate, 1);
  assert.equal(up[0].cum, 0);
  assert.equal(up[8].cum, 1);
  const flat = curveSamples(10_000, 10_000, 4);
  assert.deepEqual(flat.map((p) => p.cum), [0, 0.25, 0.5, 0.75, 1]);
  assert.ok(flat.every((p) => p.rate === 1));
  const paths = curvePreviewPaths(10_000, 2_000, { width: 100, height: 50, pad: 0 });
  assert.ok(paths.rateLine.startsWith("M0.0 6.0"), paths.rateLine);
  assert.ok(paths.rateLine.endsWith("L100.0 41.2"), paths.rateLine);
  assert.ok(paths.rateArea.endsWith("L100.0 50.0 L0.0 50.0 Z"));
  assert.ok(paths.cumLine.startsWith("M0.0 50.0") && paths.cumLine.endsWith("L100.0 6.0"));
});

test("APR math", () => {
  // 1 USDC/s paid, 1,000,000 BZB staked at $0.01 => $31.536M/yr over $10k = 315,360%
  const apr = aprPercent({ ratePerSecond: 10n ** 6n, rewardDecimals: 6, rewardPriceUsd: 1, totalStaked: 1_000_000n * E18, stakePriceUsd: 0.01 });
  assert.ok(Math.abs(apr - 315_360) < 1e-6);
  // 100 BZB/day to 36,500 BZB staked, same token => 100%
  const same = aprPercent({ ratePerSecond: (100n * E18) / 86_400n, rewardDecimals: 18, rewardPriceUsd: 0.02, totalStaked: 36_500n * E18, stakePriceUsd: 0.02 });
  assert.ok(Math.abs(same - 100) < 0.01);
  assert.equal(aprPercent({ ratePerSecond: 1n, rewardDecimals: 18, rewardPriceUsd: null, totalStaked: E18, stakePriceUsd: 1 }), null);
  assert.equal(aprPercent({ ratePerSecond: 1n, rewardDecimals: 18, rewardPriceUsd: 1, totalStaked: 0n, stakePriceUsd: 1 }), null);
  assert.equal(aprPercent({ ratePerSecond: 0n, rewardDecimals: 18, rewardPriceUsd: 1, totalStaked: E18, stakePriceUsd: 1 }), null);
  assert.equal(sumApr([null, 1.5, 2]), 3.5);
  assert.equal(sumApr([null]), null);
  assert.equal(formatApr(null), "—");
  assert.equal(formatApr(12.345), "12.3%");
  assert.equal(formatApr(1.234), "1.23%");
  assert.equal(formatApr(12_345.6), "12,346%");
  assert.equal(formatApr(0.001), "<0.01%");
  assert.equal(toFloatUnits(1_500_000n, 6), 1.5);
});

test("gas: estimate + 25% with the 1.1M / 2.2M floors", () => {
  assert.equal(GAS_FLOOR, 1_100_000n);
  assert.equal(gasLimitFor(400_000n, "withdraw"), 1_100_000n);
  assert.equal(gasLimitFor(400_000n, "emergencyWithdraw"), 1_100_000n);
  assert.equal(gasLimitFor(400_000n, "checkpoint"), 1_100_000n);
  assert.equal(gasLimitFor(1_000_000n, "emergencyWithdraw"), 1_250_000n);
  assert.equal(GAS_FLOOR_PAYOUT, 2_200_000n);
  assert.equal(GAS_FLOOR_STAKE, 1_200_000n);
  for (const a of ["stake", "stakeFor", "stakeWithPermit2", "compound"]) {
    assert.equal(gasLimitFor(150_000n, a), 1_200_000n, a);
    assert.equal(gasLimitFor(1_000_000n, a), 1_250_000n, a);
  }
  for (const a of ["claimAll", "exit", "claimAllSkipping", "exitSkipping"]) {
    assert.equal(gasLimitFor(400_000n, a), 2_200_000n, a);
    assert.equal(gasLimitFor(2_000_001n, a), 2_500_002n, a);
  }
  // L-5: claim/claimTo get the 1.1M floor, claimManyTo the 2.2M payout floor; owner calls have none.
  assert.equal(gasLimitFor(100_000n, "claim"), 1_100_000n);
  assert.equal(gasLimitFor(100_000n, "claimTo"), 1_100_000n);
  assert.equal(gasLimitFor(400_000n, "claimManyTo"), 2_200_000n);
  assert.equal(gasLimitFor(100_000n, "addRewardToken"), 125_000n);
});

test("run status and start time", () => {
  const run = { start: 100, end: 200 };
  assert.equal(runStatus(run, 99), "scheduled");
  assert.equal(runStatus(run, 100), "live");
  assert.equal(runStatus(run, 200), "finished");
  assert.equal(startTimeFor(0, 1000), 0n);
  assert.equal(startTimeFor(3_600, 1000), 4_600n);
  assert.equal(daysHoursToSec(1, 6), 108_000);
  assert.ok(Number.isNaN(daysHoursToSec(-1)));
  assert.equal(durationLabel(30 * DAY), "30d");
  assert.equal(durationLabel(DAY + 7_200), "1d 2h");
  assert.equal(durationLabel(5_400), "1h 30m");
});

test("validateNewTokens enforces the 5-token cap, self and duplicates", () => {
  assert.deepEqual(parseAddressList(`${A}, ${B}\n`), [A, B]);
  assert.ok(validateNewTokens([A, B], { listed: [], self: SELF }).ok);
  assert.ok(!validateNewTokens([SELF], { self: SELF }).ok);
  assert.ok(!validateNewTokens([A, A]).ok);
  assert.ok(!validateNewTokens([A], { listed: [A] }).ok);
  assert.ok(!validateNewTokens(["0x123"]).ok);
  assert.ok(!validateNewTokens(["0x0000000000000000000000000000000000000000"]).ok);
  assert.ok(!validateNewTokens([A], { hasCode: { [A]: false } }).ok);
  const four = [4, 5, 6, 7].map((i) => `0x${String(i).repeat(40)}`);
  const r = validateNewTokens([A, B], { listed: four });
  assert.ok(!r.ok && /At most 5/.test(r.errors.join(" ")));
  assert.ok(!validateNewTokens([]).ok);
});

test("validateRuns enforces duration, delay, weights, 5 unfinished runs, balance", () => {
  const ok = { token: A, amount: 10n * E18, delaySec: 0, durationSec: 30 * DAY, startWeight: 10_000, endWeight: 10_000 };
  const ctx = { listed: [A], activeRuns: {}, balances: { [A]: 100n * E18 } };
  assert.ok(validateRuns([ok], ctx).ok);
  assert.ok(!validateRuns([], ctx).ok);
  assert.ok(!validateRuns([{ ...ok, token: B }], ctx).ok);
  assert.ok(!validateRuns([{ ...ok, amount: 0n }], ctx).ok);
  assert.ok(!validateRuns([{ ...ok, amount: LIMITS.MAX_RUN_AMOUNT + 1n }], { ...ctx, balances: {} }).ok);
  assert.ok(!validateRuns([{ ...ok, durationSec: DAY - 1 }], ctx).ok);
  assert.ok(validateRuns([{ ...ok, durationSec: DAY }], ctx).ok);
  assert.ok(validateRuns([{ ...ok, durationSec: 365 * DAY }], ctx).ok);
  assert.ok(!validateRuns([{ ...ok, durationSec: 365 * DAY + 1 }], ctx).ok);
  assert.ok(validateRuns([{ ...ok, delaySec: 30 * DAY }], ctx).ok);
  assert.ok(!validateRuns([{ ...ok, delaySec: 30 * DAY + 1 }], ctx).ok);
  assert.ok(!validateRuns([{ ...ok, delaySec: 60 }], ctx).ok);
  assert.ok(!validateRuns([{ ...ok, startWeight: 0, endWeight: 0 }], ctx).ok);
  assert.ok(!validateRuns([{ ...ok, startWeight: 10_001 }], ctx).ok);
  assert.ok(validateRuns([{ ...ok, startWeight: 0 }], ctx).ok);
  assert.ok(!validateRuns([ok], { ...ctx, paused: true }).ok);
  // 3 unfinished + 2 new = 5 ok, + 3 new = 6 not ok
  assert.ok(validateRuns([ok, ok], { ...ctx, activeRuns: { [A.toLowerCase()]: 3 } }).ok);
  const over = validateRuns([ok, ok, ok], { ...ctx, activeRuns: { [A.toLowerCase()]: 3 } });
  assert.ok(!over.ok && /5-run limit/.test(over.errors.join(" ")));
  const poor = validateRuns([ok, { ...ok, amount: 95n * E18 }], ctx);
  assert.ok(!poor.ok && /balance/.test(poor.errors.join(" ")));
  assert.equal(validateRuns([ok, ok], ctx).perTokenAmount[A.toLowerCase()], 20n * E18);
});

test("validateRecover caps at the surplus", () => {
  assert.ok(validateRecover({ amount: 5n, recoverable: 5n, to: A }).ok);
  assert.ok(!validateRecover({ amount: 6n, recoverable: 5n, to: A }).ok);
  assert.ok(!validateRecover({ amount: 0n, recoverable: 5n, to: A }).ok);
  assert.ok(!validateRecover({ amount: 1n, recoverable: 5n, to: "nope" }).ok);
});

test("B-3: verifyDeployment fails closed", () => {
  const BZB = "0x462D8d82C2B2D2DDabf7f8a93928De09d47A5807";
  const exp = { bzb: BZB, owner: EXPECTED_DEPLOYMENT.owner, minStake: EXPECTED_DEPLOYMENT.minStake };
  const good = { code: "0x6080", stakingToken: BZB.toLowerCase(), owner: EXPECTED_DEPLOYMENT.owner.toLowerCase(), minStake: 10n ** 18n };
  assert.ok(verifyDeployment(good, exp).ok);
  assert.ok(!verifyDeployment({ ...good, code: "0x" }, exp).ok);
  assert.ok(!verifyDeployment({ ...good, code: undefined }, exp).ok);
  assert.ok(!verifyDeployment({ ...good, stakingToken: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" }, exp).ok);
  assert.ok(!verifyDeployment({ ...good, owner: "0xB452329B7b9d55a82f10a4e60E22748De6e490F2" }, exp).ok);
  assert.ok(!verifyDeployment({ ...good, minStake: 10n ** 15n }, exp).ok);
  assert.ok(!verifyDeployment({ ...good, minStake: undefined }, exp).ok);
  assert.ok(!verifyDeployment(undefined, exp).ok);
  assert.equal(EXPECTED_DEPLOYMENT.owner, "0x6F47aa396215ab22647dDB3E86b4663DFe11dB14");
});

console.log(`stake-multi-core: ${n} tests passed`);
