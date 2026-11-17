/**
 * Pure helpers for the multi-reward Stake BZB tab (BlazarMultiRewardStaking).
 * Curve math mirrors the contract exactly (BigInt), plus APR, gas and input checks.
 * No network, no DOM.
 */

export const LIMITS = Object.freeze({
  MAX_REWARD_TOKENS: 5,
  MAX_RUNS_PER_TOKEN: 5,
  MIN_DURATION: 86_400,
  MAX_DURATION: 365 * 86_400,
  MAX_START_DELAY: 30 * 86_400,
  MAX_WEIGHT: 10_000,
  MAX_RUN_AMOUNT: (1n << 128n) - 1n,
  MIN_STAKE: 10n ** 15n,
});

/** A future start must be at least this far out so the tx is mined before it (contract: start >= block.timestamp). */
export const MIN_FUTURE_DELAY = 15 * 60;
export const YEAR = 365 * 86_400;

export const CURVE_PRESETS = Object.freeze({
  flat: Object.freeze({ label: "Flat", startWeight: 10_000, endWeight: 10_000 }),
  up: Object.freeze({ label: "Ramping up", startWeight: 2_000, endWeight: 10_000 }),
  down: Object.freeze({ label: "Ramping down", startWeight: 10_000, endWeight: 2_000 }),
});

/**
 * Gas: every write sends estimate + 25%, raised to a floor for the paths that must never run out of gas.
 *  - withdraw, emergencyWithdraw, checkpoint: at least 1.1M (SECURITY.md RV-01).
 *  - stake, stakeFor, stakeWithPermit2, compound: at least 1.2M (security review of aeaf3e6).
 *  - claim, claimTo: at least 1.1M (security L-5; a short limit only reverts, but keep it consistent).
 *  - claimManyTo: at least 2.2M (can pay up to 5 reward tokens, like claimAll).
 *  - exit, claimAll, claimAllSkipping, exitSkipping: at least 2.2M. They pay up to 5 reward tokens, and on
 *    multireward-agent (aeaf3e6) the skipping variants revert InsufficientGas rather than skip on a short limit.
 */
export const GAS_FLOOR = 1_100_000n;
export const GAS_FLOOR_STAKE = 1_200_000n;
export const GAS_FLOOR_PAYOUT = 2_200_000n;
export const GAS_FLOORS = Object.freeze({
  withdraw: GAS_FLOOR,
  emergencyWithdraw: GAS_FLOOR,
  checkpoint: GAS_FLOOR,
  claim: GAS_FLOOR,
  claimTo: GAS_FLOOR,
  claimManyTo: GAS_FLOOR_PAYOUT,
  stake: GAS_FLOOR_STAKE,
  stakeFor: GAS_FLOOR_STAKE,
  stakeWithPermit2: GAS_FLOOR_STAKE,
  compound: GAS_FLOOR_STAKE,
  claimAll: GAS_FLOOR_PAYOUT,
  exit: GAS_FLOOR_PAYOUT,
  claimAllSkipping: GAS_FLOOR_PAYOUT,
  exitSkipping: GAS_FLOOR_PAYOUT,
});

const big = (v) => BigInt(v ?? 0);

/** Contract `curveEmitted`: cumulative emission after `elapsed` seconds, rounded down. */
export function curveEmitted(amount, duration, startWeight, endWeight, elapsed) {
  const a = big(amount);
  const d = big(duration);
  const s = big(startWeight);
  const e = big(endWeight);
  const x = big(elapsed);
  if (a === 0n || x <= 0n) return 0n;
  if (x >= d) return a;
  const num = s * x * (2n * d - x) + e * x * x;
  const den = d * d * (s + e);
  return (a * num) / den;
}

/** Contract `_rateAt`: instantaneous wei/second at `elapsed` seconds into the run, rounded down. */
export function curveRate(amount, duration, startWeight, endWeight, elapsed) {
  const a = big(amount);
  const d = big(duration);
  const s = big(startWeight);
  const e = big(endWeight);
  const x = big(elapsed);
  if (a === 0n || x < 0n || x >= d) return 0n;
  return (a * 2n * (s * (d - x) + e * x)) / (d * d * (s + e));
}

export function curveKind(startWeight, endWeight) {
  const s = Number(startWeight);
  const e = Number(endWeight);
  if (s === e) return "flat";
  return e > s ? "up" : "down";
}

export function curveLabel(startWeight, endWeight) {
  return CURVE_PRESETS[curveKind(startWeight, endWeight)].label;
}

/** Ratio of the last-moment rate to the first-moment rate, e.g. "5× by the end". */
export function curveDetail(startWeight, endWeight) {
  const s = Number(startWeight);
  const e = Number(endWeight);
  if (s === e) return "Same rate the whole run";
  if (s === 0) return "Starts at zero and rises";
  if (e === 0) return "Falls to zero at the end";
  const r = e / s;
  return r > 1 ? `Ends ${trimNum(r)}× faster than it starts` : `Ends at ${trimNum(r * 100)}% of the start rate`;
}

function trimNum(n) {
  return n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

/** Sampled curve shape: rate is normalised to the larger weight (0..1), cum is the share emitted (0..1). */
export function curveSamples(startWeight, endWeight, n = 32) {
  const s = Number(startWeight);
  const e = Number(endWeight);
  const steps = Math.max(2, Math.floor(n));
  const top = Math.max(s, e) || 1;
  const sum = s + e;
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const rate = (s + (e - s) * t) / top;
    const cum = sum > 0 ? (s * t * (2 - t) + e * t * t) / sum : 0;
    out.push({ t, rate, cum });
  }
  return out;
}

/** SVG paths for a small curve preview: rate area + line, and the cumulative emission line. */
export function curvePreviewPaths(startWeight, endWeight, { width = 240, height = 80, pad = 4 } = {}) {
  const pts = curveSamples(startWeight, endWeight, 32);
  const w = width - pad * 2;
  const h = height - pad * 2;
  const X = (t) => (pad + t * w).toFixed(1);
  // Peak sits at 88% of the height so a flat line never hides under the chart border.
  const Y = (v) => (pad + (1 - v * 0.88) * h).toFixed(1);
  const rateLine = pts.map((p, i) => `${i ? "L" : "M"}${X(p.t)} ${Y(p.rate)}`).join(" ");
  const rateArea = `${rateLine} L${X(1)} ${Y(0)} L${X(0)} ${Y(0)} Z`;
  const cumLine = pts.map((p, i) => `${i ? "L" : "M"}${X(p.t)} ${Y(p.cum)}`).join(" ");
  return { rateLine, rateArea, cumLine, width, height };
}

/** Float of a token amount (precision is fine for display / APR). */
export function toFloatUnits(amount, decimals) {
  const a = big(amount);
  const d = Number(decimals);
  const base = 10n ** BigInt(d);
  return Number(a / base) + Number(a % base) / 10 ** d;
}

/**
 * Estimated APR (percent) for one reward stream: yearly USD paid at `ratePerSecond` divided by the USD
 * value of all staked BZB. Null when there is no price, no stake, or no rate.
 */
export function aprPercent({ ratePerSecond, rewardDecimals, rewardPriceUsd, totalStaked, stakeDecimals = 18, stakePriceUsd }) {
  const rate = big(ratePerSecond);
  const staked = big(totalStaked);
  if (rate <= 0n || staked <= 0n) return null;
  const rp = Number(rewardPriceUsd);
  const sp = Number(stakePriceUsd);
  if (!Number.isFinite(rp) || rp <= 0 || !Number.isFinite(sp) || sp <= 0) return null;
  const yearlyUsd = toFloatUnits(rate * BigInt(YEAR), rewardDecimals) * rp;
  const stakedUsd = toFloatUnits(staked, stakeDecimals) * sp;
  if (stakedUsd <= 0) return null;
  const apr = (yearlyUsd / stakedUsd) * 100;
  return Number.isFinite(apr) ? apr : null;
}

/** Sum of APRs that are known; null if none are. */
export function sumApr(list) {
  const known = list.filter((v) => v != null && Number.isFinite(v));
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

export function formatApr(apr) {
  if (apr == null || !Number.isFinite(apr)) return "—";
  if (apr >= 1_000_000) return ">999,999%";
  if (apr >= 1000) return `${Math.round(apr).toLocaleString("en-US")}%`;
  if (apr >= 10) return `${apr.toFixed(1)}%`;
  if (apr >= 0.01) return `${apr.toFixed(2)}%`;
  return "<0.01%";
}

/** estimateGas + 25% (rounded up), never below the action's floor. */
export function gasLimitFor(estimate, action) {
  const est = big(estimate);
  const padded = (est * 125n + 99n) / 100n;
  const floor = GAS_FLOORS[action] ?? 0n;
  return padded > floor ? padded : floor;
}

export function runStatus(run, now) {
  const t = Number(now);
  if (t < Number(run.start)) return "scheduled";
  if (t >= Number(run.end)) return "finished";
  return "live";
}

/** 0 = start now; otherwise an absolute start time `chainNow + delay`. */
export function startTimeFor(delaySec, chainNow) {
  const d = Math.floor(Number(delaySec) || 0);
  if (d <= 0) return 0n;
  return BigInt(Math.floor(Number(chainNow))) + BigInt(d);
}

export function isAddressLike(text) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(text || "").trim());
}

/** Split a comma / whitespace / newline separated list of addresses. */
export function parseAddressList(text) {
  return String(text || "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Validate reward tokens to list. `listed` are current reward tokens. Returns { ok, errors, tokens }.
 * `hasCode` is an optional map lowercased address -> bool.
 */
export function validateNewTokens(list, { listed = [], self = "", hasCode = null, max = LIMITS.MAX_REWARD_TOKENS } = {}) {
  const errors = [];
  const seen = new Set(listed.map((a) => a.toLowerCase()));
  const tokens = [];
  if (!list.length) errors.push("Enter at least one token address.");
  for (const raw of list) {
    if (!isAddressLike(raw)) {
      errors.push(`${raw} is not an address.`);
      continue;
    }
    const key = raw.toLowerCase();
    if (/^0x0{40}$/.test(key)) errors.push("The zero address can't be a reward token.");
    else if (self && key === self.toLowerCase()) errors.push("The staking contract can't list itself.");
    else if (seen.has(key)) errors.push(`${raw} is already listed or repeated.`);
    else if (hasCode && hasCode[key] === false) errors.push(`${raw} has no contract code.`);
    else {
      seen.add(key);
      tokens.push(raw);
    }
  }
  if (listed.length + tokens.length > max) {
    errors.push(`At most ${max} reward tokens can ever be listed (${listed.length} already). Listing is permanent.`);
  }
  return { ok: errors.length === 0, errors, tokens };
}

/**
 * Validate a batch of run drafts against the contract limits.
 * draft: { token, amount (bigint, raw units), delaySec, durationSec, startWeight, endWeight, symbol? }
 * ctx: { listed: string[], activeRuns: {lowerAddr: n}, balances: {lowerAddr: bigint}, paused }
 */
export function validateRuns(drafts, ctx = {}) {
  const errors = [];
  const listed = new Set((ctx.listed || []).map((a) => a.toLowerCase()));
  const active = ctx.activeRuns || {};
  const balances = ctx.balances || {};
  const perTokenRuns = {};
  const perTokenAmount = {};
  if (ctx.paused) errors.push("The contract is paused. Unpause it before creating runs.");
  if (!drafts.length) errors.push("Add at least one run.");
  drafts.forEach((d, i) => {
    const n = `Run ${i + 1}`;
    const key = String(d.token || "").toLowerCase();
    if (!key || !listed.has(key)) errors.push(`${n}: pick a listed reward token.`);
    const amount = big(d.amount);
    if (amount <= 0n) errors.push(`${n}: enter an amount above zero.`);
    if (amount > LIMITS.MAX_RUN_AMOUNT) errors.push(`${n}: amount is above the per-run cap.`);
    const dur = Number(d.durationSec);
    if (!Number.isInteger(dur) || dur < LIMITS.MIN_DURATION || dur > LIMITS.MAX_DURATION) errors.push(`${n}: duration must be 1 to 365 days.`);
    const delay = Number(d.delaySec);
    if (!Number.isFinite(delay) || delay < 0 || delay > LIMITS.MAX_START_DELAY) errors.push(`${n}: start delay must be 0 to 30 days.`);
    else if (delay > 0 && delay < MIN_FUTURE_DELAY) errors.push(`${n}: a delayed start must be at least 15 minutes out (or start now).`);
    const s = Number(d.startWeight);
    const e = Number(d.endWeight);
    const okW = (w) => Number.isInteger(w) && w >= 0 && w <= LIMITS.MAX_WEIGHT;
    if (!okW(s) || !okW(e)) errors.push(`${n}: curve weights must be whole numbers 0 to 10,000.`);
    else if (s + e === 0) errors.push(`${n}: start and end weight can't both be zero.`);
    if (key) {
      perTokenRuns[key] = (perTokenRuns[key] || 0) + 1;
      perTokenAmount[key] = (perTokenAmount[key] || 0n) + (amount > 0n ? amount : 0n);
    }
  });
  for (const [key, count] of Object.entries(perTokenRuns)) {
    const now = Number(active[key] || 0);
    if (now + count > LIMITS.MAX_RUNS_PER_TOKEN) {
      errors.push(`${key.slice(0, 6)}…${key.slice(-4)}: ${now} unfinished run${now === 1 ? "" : "s"} + ${count} new is over the ${LIMITS.MAX_RUNS_PER_TOKEN}-run limit.`);
    }
    if (balances[key] !== undefined && perTokenAmount[key] > big(balances[key])) {
      errors.push(`${key.slice(0, 6)}…${key.slice(-4)}: wallet balance is below the total for these runs.`);
    }
  }
  return { ok: errors.length === 0, errors, perTokenAmount };
}

/** Validate an owner recover. */
export function validateRecover({ amount, recoverable, to }) {
  const errors = [];
  const a = big(amount);
  if (a <= 0n) errors.push("Enter an amount above zero.");
  if (a > big(recoverable)) errors.push("That is more than the recoverable surplus.");
  if (!isAddressLike(to) || /^0x0{40}$/i.test(String(to))) errors.push("Enter a destination address.");
  return { ok: errors.length === 0, errors };
}

/** Days + hours -> seconds (inputs as entered). */
export function daysHoursToSec(days, hours = 0) {
  const d = Number(days || 0);
  const h = Number(hours || 0);
  if (!Number.isFinite(d) || !Number.isFinite(h) || d < 0 || h < 0) return NaN;
  return Math.round(d * 86_400 + h * 3_600);
}

/** Short duration label: "30d", "6h", "2d 4h". */
export function durationLabel(sec) {
  const s = Math.max(0, Math.floor(Number(sec)));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d && h) return `${d}d ${h}h`;
  if (d) return `${d}d`;
  if (h) return `${h}h${m ? ` ${m}m` : ""}`;
  return `${m}m`;
}
