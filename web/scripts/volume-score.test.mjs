import { canonicalAsset, subtractRoundTrips } from "./volume-score.mjs";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const wpol = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const usdc = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const zero = "0x0000000000000000000000000000000000000000";
const native = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

assert(canonicalAsset(zero, wpol) === wpol.toLowerCase(), "zero address is WPOL");
assert(canonicalAsset(native, wpol) === wpol.toLowerCase(), "native sentinel is WPOL");
assert(canonicalAsset(wpol.toUpperCase(), wpol) === wpol.toLowerCase(), "WPOL case folds");
assert(canonicalAsset(usdc, wpol) === usdc.toLowerCase(), "USDC stays itself");

function pair(tokenIn, tokenOut, trader, time, score) {
  return { trader, tokenIn, tokenOut, time, score, raw: tokenIn };
}

const windowSec = 600;
const cancel = subtractRoundTrips(
  [pair(wpol, usdc, "alice", 1_000, 100), pair(usdc, zero, "alice", 1_100, 100)],
  windowSec,
  wpol,
);
assert(cancel[0].score === 0 && cancel[1].score === 0, "WPOL to USDC reversed by USDC to native POL cancels");
assert(cancel[0].tokenIn === wpol && cancel[1].tokenOut === zero, "raw endpoints stay on the trade");

const otherWay = subtractRoundTrips(
  [pair(native, usdc, "alice", 1_000, 80), pair(usdc, wpol, "alice", 1_200, 80)],
  windowSec,
  wpol,
);
assert(otherWay.every((trade) => trade.score === 0), "native to USDC reversed by USDC to WPOL cancels");

const cased = subtractRoundTrips(
  [pair(wpol.toUpperCase(), usdc.toUpperCase(), "alice", 1_000, 10), pair(usdc, native.toLowerCase(), "alice", 1_010, 10)],
  windowSec,
  wpol,
);
assert(cased.every((trade) => trade.score === 0), "mixed case still matches");

const accounts = subtractRoundTrips(
  [pair(wpol, usdc, "alice", 1_000, 100), pair(zero, wpol, "bob", 1_000, 100)],
  windowSec,
  wpol,
);
assert(accounts[0].score === 100 && accounts[1].score === 100, "different accounts are not subtracted");

const edge = subtractRoundTrips(
  [pair(wpol, usdc, "alice", 1_000, 50), pair(usdc, zero, "alice", 1_600, 50)],
  windowSec,
  wpol,
);
assert(edge.every((trade) => trade.score === 0), "a gap equal to the window still matches");

const outside = subtractRoundTrips(
  [pair(wpol, usdc, "alice", 1_000, 50), pair(usdc, zero, "alice", 1_601, 50)],
  windowSec,
  wpol,
);
assert(outside.every((trade) => trade.score === 50), "one second past the window is kept");

const uneven = subtractRoundTrips(
  [pair(wpol, usdc, "alice", 1_000, 100), pair(usdc, native, "alice", 1_050, 40)],
  windowSec,
  wpol,
);
assert(uneven[0].score === 60 && uneven[1].score === 0, "only the overlapping score is removed");

const sameWay = subtractRoundTrips(
  [pair(wpol, usdc, "alice", 1_000, 20), pair(zero, usdc, "alice", 1_010, 20)],
  windowSec,
  wpol,
);
assert(sameWay.every((trade) => trade.score === 20), "the same direction is not a reverse");

console.log("volume score tests ok");
