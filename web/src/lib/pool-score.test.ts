import { scorePools } from "./pool-score";

function assert(cond: unknown, message: string) {
  if (!cond) throw new Error(message);
}

const day = 86_400;

const deepYoung = scorePools([
  { address: "deep", liquidityUsd: 1_000_000, ageSeconds: 1 * day },
  { address: "thin", liquidityUsd: 10_000, ageSeconds: 1000 * day },
]);
assert(deepYoung[0].address === "deep", "liquidity should outweigh a much older thin pool");
assert(Math.abs(deepYoung[0].score - (0.7 + 0.3 * (1 / 1000))) < 1e-9, "deep score");

const close = scorePools([
  { address: "newer", liquidityUsd: 100, ageSeconds: 10 * day },
  { address: "older", liquidityUsd: 95, ageSeconds: 1000 * day },
]);
assert(close[0].address === "older", "a slightly thinner pool with a much longer history should win");

const olderWins = scorePools([
  { address: "a", liquidityUsd: 50, ageSeconds: 10 },
  { address: "b", liquidityUsd: 50, ageSeconds: 20 },
]);
assert(olderWins[0].address === "b", "equal liquidity prefers the older pool");
assert(olderWins[0].score > olderWins[1].score, "the older pool scores higher because age is inside the score");

// Same score, different liquidity: 0.70 * 1 + 0.30 * 0 = 0.70 * (40/70) + 0.30 * 1.
const tiedScore = scorePools([
  { address: "deeper", liquidityUsd: 70, ageSeconds: 0 },
  { address: "older", liquidityUsd: 40, ageSeconds: 100 },
]);
assert(tiedScore[0].score === tiedScore[1].score, "constructed scores match");
assert(tiedScore[0].address === "deeper", "a tied score prefers more liquidity");

const empty = scorePools([]);
assert(empty.length === 0, "empty");

const junk = scorePools([{ address: "z", liquidityUsd: Number.NaN, ageSeconds: -5 }]);
assert(junk[0].liquidityUsd === 0 && junk[0].ageSeconds === 0, "bad numbers become zero");

console.log("pool score tests ok");
