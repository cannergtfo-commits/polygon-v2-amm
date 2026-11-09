import { examples, feePolicy, forbiddenMcpTools, mcpToolNames, searchTokens, toBaseUnits, tokenDetails, unsignedPreview, chartVersusRouting, assertQuoteInput, BotLimiter } from "./bot";
import { quoteRequestKey } from "./trade-selection";

function assert(cond: unknown, message: string) {
  if (!cond) throw new Error(message);
}

const bzb = searchTokens("BZB");
assert(bzb.length === 1 && bzb[0].decimals === 18, "BZB search");
assert(searchTokens("usdc").some((token) => token.symbol === "USDC"), "USDC search");
assert(tokenDetails("0x462D8d82C2B2D2DDabf7f8a93928De09d47A5807").known === true, "known token");
let unknown = false;
try {
  tokenDetails("not-an-address");
} catch {
  unknown = true;
}
assert(unknown, "bad address rejected");
assert(tokenDetails("0x1111111111111111111111111111111111111111").known === false, "unknown address is not fetched");

assert(toBaseUnits("1000", 18) === `${"1"}${"0".repeat(21)}`, "1000 BZB base units");
assert(toBaseUnits("10", 6) === "10000000", "10 USDC base units");
assert(toBaseUnits("0.2", 18) === `2${"0".repeat(17)}`, "0.2 POL base units");
assert(examples[0].amountIn === toBaseUnits("1000", 18), "example uses base units");

const fees = feePolicy();
assert(fees.exampleOn10000.externalFee === "5", "5 bps of 10000 is 5");
assert(fees.exampleOn10000.blazarFactoryFee === "0", "own pool wrapper fee is zero");

const ranked = chartVersusRouting([
  { address: "0xchart", liquidityUsd: 1_000_000, ageSeconds: 86_400 },
  { address: "0xother", liquidityUsd: 10, ageSeconds: 10 },
]);
const key = quoteRequestKey({ chainId: 137, sell: examples[0].tokenIn, buy: examples[0].tokenOut, amount: examples[0].amountIn, slippageBps: 50 });
assert(!key.includes("0xchart") && ranked.rankedForDisplayOnly[0].address === "0xchart", "chart rank is not part of the quote key");

assertQuoteInput({ tokenIn: examples[0].tokenIn, tokenOut: examples[0].tokenOut, amountIn: examples[0].amountIn });
let same = false;
try {
  assertQuoteInput({
    tokenIn: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    tokenOut: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    amountIn: "1",
  });
} catch {
  same = true;
}
assert(same, "POL and WPOL are rejected as a pair");

const preview = unsignedPreview({
  tokenIn: examples[0].tokenIn,
  tokenOut: examples[0].tokenOut,
  amountIn: examples[0].amountIn,
  slippage: "0.50",
  recipient: "0xB452329B7b9d55a82f10a4e60E22748De6e490F2",
});
assert(preview.ok === false && preview.signing === false && preview.broadcast === false, "preview does not sign or broadcast");
assert(!("data" in preview), "preview does not emit calldata");
assert(preview.wouldRequire.allowance.includes("never the uint256 maximum"), "no max approval");

const limiter = new BotLimiter(2, 60_000);
limiter.take(1_000);
limiter.take(1_000);
let blocked = false;
try {
  limiter.take(1_000);
} catch {
  blocked = true;
}
assert(blocked, "bot limiter backpressure");

const names = new Set<string>(mcpToolNames);
for (const banned of forbiddenMcpTools) assert(!names.has(banned), `forbidden tool ${banned}`);

console.log("bot kit tests ok");
