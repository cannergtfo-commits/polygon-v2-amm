import { quoteIsStale, quoteRequestKey, selectBuyToken, slippageBpsOf } from "./trade-selection";
import { hopFloor } from "./execute";

function assert(cond: unknown, message: string) {
  if (!cond) throw new Error(message);
}

const wpol = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const bzb = { address: "0x462D8d82C2B2D2DDabf7f8a93928De09d47A5807", symbol: "BZB" };
const usdc = { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", symbol: "USDC" };
const pol = { address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", symbol: "POL" };
const wrapped = { address: wpol, symbol: "WPOL" };

const kept = selectBuyToken(bzb, usdc, wrapped, [bzb, usdc, pol], wpol);
assert(kept?.pay.symbol === "BZB" && kept.buy.symbol === "WPOL", "trending fills the buy side and keeps the pay token");

const swapped = selectBuyToken(usdc, bzb, usdc, [bzb, usdc, pol], wpol);
assert(swapped?.pay.symbol === "BZB" && swapped.buy.symbol === "USDC", "pay token moves when it would match the new buy token");

const native = selectBuyToken(pol, bzb, wrapped, [usdc], wpol);
assert(native?.pay.symbol === "BZB" && native.buy.symbol === "WPOL", "POL and WPOL are the same asset");

const none = selectBuyToken(usdc, usdc, usdc, [usdc], wpol);
assert(none === null, "identical sides are refused when no other pay token exists");

const now = 1_000_000;
assert(quoteIsStale(0, now), "a cleared quote is stale");
assert(quoteIsStale(now - 45_001, now), "a quote older than 45 seconds is stale");
assert(!quoteIsStale(now - 10_000, now), "a fresh quote can be reviewed");
assert(hopFloor("1000", 50) === 995n, "hop minimum applies slippage and is not zero");
assert(slippageBpsOf("0.50") === 50, "half a percent");
assert(slippageBpsOf("9") === null && slippageBpsOf("abc") === null, "slippage is bounded");
const keyA = quoteRequestKey({ chainId: 137, account: "0xA", sell: "0x1", buy: "0x2", amount: "5", slippageBps: 50 });
const keyB = quoteRequestKey({ chainId: 137, account: "0xA", sell: "0x1", buy: "0x2", amount: "6", slippageBps: 50 });
assert(keyA !== keyB, "a new amount is a new quote");

console.log("trade selection tests ok");
