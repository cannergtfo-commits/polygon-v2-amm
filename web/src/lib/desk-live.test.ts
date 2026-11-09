// @ts-nocheck
import assert from "node:assert/strict";
import { decodeFunctionData, encodeFunctionData } from "viem";
import {
  BZB,
  FEE_ROUTER,
  NATIVE,
  NO_PATCH,
  REWARDS,
  SHARE_BPS,
  STAKING,
  WPOL,
  ZERO,
  allV2,
  approvalPlan,
  approvePlan,
  approveZeroPlan,
  bestV2,
  buildCalls,
  buildDayBoard,
  claimRewardPlan,
  claimStakePlan,
  collectRoutes,
  deadlineFor,
  deadlineOk,
  enabledVenues,
  executionGate,
  formatUnits,
  minBuy,
  parseUnits,
  pricedExternal,
  quoteFresh,
  quoteStillTradable,
  quoteV2,
  rankRoutes,
  rewardState,
  scoreTrade,
  shareTableSums,
  splitV2,
  stakePlan,
  swapPlan,
  trustedUsdE8,
  twoHopV2,
  unpaidCarried,
  withdrawPlan,
  wrapperOnSpend,
  erc20ApproveAbi,
  rewardsClaimAbi,
  stakingAbi,
} from "../../../docs/js/desk-core.mjs";

const BLAZAR = "0x8e9663F4b15F3B291B1354e20d1B019d8864830F";
const QUICK = "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32";
const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const USER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

function pair(factory, venue, tokenA, tokenB, reserveA, reserveB, feeBps = 30) {
  const a = BigInt(tokenA);
  const b = BigInt(tokenB);
  const token0 = a < b ? tokenA : tokenB;
  const token0IsA = token0.toLowerCase() === tokenA.toLowerCase();
  return {
    factory,
    venue,
    feeBps,
    pair: "0x3333333333333333333333333333333333333333",
    tokenA,
    tokenB,
    token0,
    reserve0: token0IsA ? reserveA : reserveB,
    reserve1: token0IsA ? reserveB : reserveA,
  };
}

const uniAbi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

const algebraAbi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "limitSqrtPrice", type: "uint160" },
        ],
      },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

function wordAt(data: `0x${string}`, offset: number) {
  const start = 2 + offset * 2;
  return BigInt(`0x${data.slice(start, start + 64)}`);
}

const amount = 1_000_000n * 10n ** 18n;
const blazarPair = pair(BLAZAR, "BlazarSwap", WPOL, BZB, 1_000_000n * 10n ** 18n, 2_000_000n * 10n ** 18n);
const quickPair = pair(QUICK, "QuickSwap v2", WPOL, BZB, 500_000n * 10n ** 18n, 800_000n * 10n ** 18n);

assert.equal(quoteV2(1000n, 100_000n, 100_000n, 30), (997n * 1000n * 100_000n) / (100_000n * 1000n + 997n * 1000n));
assert.equal(quoteV2(0n, 1n, 1n, 30), 0n);

const own = wrapperOnSpend(10_000n, 10_000n, false, 5);
assert.equal(own.fee, 0n);
assert.equal(own.net, 10_000n);
const outside = wrapperOnSpend(10_000n, 10_000n, true, 5);
assert.equal(outside.fee, 5n);
assert.equal(outside.net, 9_995n);
const second = wrapperOnSpend(9_000n, 0n, true, 5);
assert.equal(second.fee, 0n);
assert.equal(unpaidCarried(false, 10_000n, 4_000n, 10_000n), 4_000n);
assert.equal(unpaidCarried(true, 10_000n, 4_000n, 10_000n), 0n);

const ownBest = bestV2([blazarPair, quickPair], WPOL, BZB, amount, 5, amount, BLAZAR);
assert.ok(ownBest);
assert.equal(ownBest.step.wrapperFee, 0n);
assert.equal(ownBest.step.factory.toLowerCase(), BLAZAR.toLowerCase());

const onlyQuick = bestV2([quickPair], WPOL, BZB, amount, 5, amount, BLAZAR);
assert.equal(onlyQuick?.step.wrapperFee, (amount * 5n) / 10_000n);

const hops = twoHopV2(
  [
    pair(BLAZAR, "BlazarSwap", WPOL, USDC, 10n ** 24n, 10n ** 12n),
    pair(QUICK, "QuickSwap v2", USDC, BZB, 10n ** 12n, 10n ** 24n),
  ],
  WPOL,
  BZB,
  [USDC],
  10n ** 18n,
  5,
  BLAZAR,
);
assert.equal(hops.length, 1);
assert.equal(hops[0].steps[0].wrapperFee, 0n);
assert.ok(hops[0].steps[1].wrapperFee > 0n);
assert.equal(hops[0].steps[1].useBalance, true);

const split = splitV2([blazarPair, quickPair], WPOL, BZB, amount, 5, BLAZAR);
assert.ok(split);
assert.equal(split.steps[0].wrapperFee, 0n);
assert.ok(split.steps[1].wrapperFee > 0n);
assert.ok(split.amountOut > (ownBest?.amountOut || 0n));

const deepQuick = pair(QUICK, "QuickSwap v2", WPOL, BZB, 50_000_000n * 10n ** 18n, 80_000_000n * 10n ** 18n);
const routes = collectRoutes({
  pairs: [blazarPair, deepQuick],
  tokenIn: NATIVE,
  tokenOut: BZB,
  hubs: [USDC],
  amountIn: amount,
  feeBps: 5,
  blazarFactory: BLAZAR,
  venues: [
    { factory: BLAZAR, name: "BlazarSwap" },
    { factory: QUICK, name: "QuickSwap v2" },
  ],
});
const ranked = rankRoutes(routes, { gasPrice: 30n * 10n ** 9n, outputPerPol: 10n ** 18n });
assert.ok(ranked[0].amountOut >= ranked[ranked.length - 1].amountOut || ranked[0].gasCost !== null);
assert.equal(ranked[0].steps.every((step) => step.kind === "v2"), true);

const unknown = bestV2([pair("0x9999999999999999999999999999999999999999", "Other", WPOL, BZB, 10n ** 30n, 10n ** 30n)], WPOL, BZB, amount, 5, amount, BLAZAR, [
  { factory: BLAZAR, name: "BlazarSwap" },
]);
assert.equal(unknown, null);

const live = enabledVenues({
  v2FeeBps: { [BLAZAR.toLowerCase()]: 30, [QUICK.toLowerCase()]: 0 },
  allowedTarget: { "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": true, "0xf5b509bb0909a69b1c207e495f687a596c168e12": false },
});
assert.deepEqual(live.v2.map((venue) => venue.id), ["blazar"]);
assert.deepEqual(live.targets.map((venue) => venue.id), ["uniswap-v3"]);

const net = wrapperOnSpend(amount, amount, true, 5).net;
const v3 = pricedExternal({
  tokenIn: WPOL,
  tokenOut: BZB,
  gross: amount,
  unpaid: amount,
  feeBps: 5,
  quotedOut: 123n,
  venue: "Uniswap v3",
  router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
  kind: "v3",
  feeTier: 500,
});
assert.equal(v3?.steps[0].quotedNetIn, net);
assert.equal(v3?.steps[0].wrapperFee, amount - net);

const plan = swapPlan({
  tokenIn: NATIVE,
  tokenOut: BZB,
  amountIn: amount,
  steps: ownBest ? [ownBest.step] : [],
  recipient: USER,
  blockTime: 1_000,
  slippageBps: 50,
});
assert.equal(plan.value, amount);
assert.equal(plan.unwrapNative, false);
assert.equal(plan.calls[0].kind, 1);
assert.equal(plan.calls[0].data, "0x");
assert.equal(plan.calls[0].amountOffset, NO_PATCH);
assert.equal(plan.minAmountOut, minBuy(ownBest!.step.quotedOut, 50));
assert.equal(deadlineOk(plan.deadline, 1_000), true);
assert.throws(() => deadlineFor(1_000, 181));

const hopMin = minBuy(1000n, 50);
const v3Plan = buildCalls(
  [
    {
      kind: "v3",
      venue: "Uniswap v3",
      factory: null,
      router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      feeTier: 500,
      tokenIn: WPOL,
      tokenOut: BZB,
      bps: 10_000,
      useBalance: false,
      quotedOut: 1000n,
      wrapperFee: 1n,
    },
  ],
  FEE_ROUTER,
  1_090n,
  50,
)[0];
const v3Data = encodeFunctionData({
  abi: uniAbi,
  functionName: "exactInputSingle",
  args: [v3Plan.plan.args],
});
assert.equal(wordAt(v3Data, 132), 0n);
assert.equal(wordAt(v3Data, 164), hopMin);

const algebraPlan = buildCalls(
  [
    {
      kind: "algebra",
      venue: "QuickSwap v3",
      router: "0xf5b509bB0909a69B1c207E495f687a596C168E12",
      feeTier: null,
      tokenIn: WPOL,
      tokenOut: USDC,
      bps: 10_000,
      useBalance: true,
      quotedOut: 1000n,
      wrapperFee: 0n,
    },
  ],
  FEE_ROUTER,
  1_090n,
  50,
)[0];
const algebraData = encodeFunctionData({
  abi: algebraAbi,
  functionName: "exactInputSingle",
  args: [algebraPlan.plan.args],
});
assert.equal(wordAt(algebraData, 132), 0n);
assert.equal(wordAt(algebraData, 164), hopMin);
assert.equal(algebraPlan.plan.args.recipient.toLowerCase(), FEE_ROUTER.toLowerCase());

assert.equal(quoteFresh(1_000, 21_000), true);
assert.equal(quoteFresh(1_000, 21_001), false);
assert.equal(quoteStillTradable(10_000n, 9_950n, 50), true);
assert.equal(quoteStillTradable(10_000n, 9_949n, 50), false);

assert.deepEqual(approvalPlan(0n, 5n), [5n]);
assert.deepEqual(approvalPlan(5n, 5n), []);
assert.deepEqual(approvalPlan(4n, 5n), [0n, 5n]);
assert.ok(approvalPlan(0n, 5n).every((step) => step !== (1n << 256n) - 1n));
assert.throws(() => approvalPlan(0n, (1n << 256n) - 1n));

const stakeData = encodeFunctionData({ abi: stakingAbi(), functionName: "stake", args: stakePlan(7n).args });
const withdrawData = encodeFunctionData({ abi: stakingAbi(), functionName: "withdraw", args: withdrawPlan(3n).args });
const rewardData = encodeFunctionData({ abi: stakingAbi(), functionName: "getReward", args: claimStakePlan().args });
const approveData = encodeFunctionData({
  abi: erc20ApproveAbi(),
  functionName: "approve",
  args: approvePlan(STAKING, 9n).args,
});
const zeroData = encodeFunctionData({
  abi: erc20ApproveAbi(),
  functionName: "approve",
  args: approveZeroPlan(FEE_ROUTER).args,
});
const claimData = encodeFunctionData({
  abi: rewardsClaimAbi(),
  functionName: "claim",
  args: claimRewardPlan(12n).args,
});
assert.equal(stakeData.slice(0, 10), "0xa694fc3a");
assert.equal(withdrawData.slice(0, 10), "0x2e1a7d4d");
assert.equal(rewardData, "0x3d18b912");
assert.equal(approveData.slice(0, 10), "0x095ea7b3");
assert.equal(decodeFunctionData({ abi: erc20ApproveAbi(), data: approveData }).args[1], 9n);
assert.equal(decodeFunctionData({ abi: erc20ApproveAbi(), data: zeroData }).args[1], 0n);
assert.equal(decodeFunctionData({ abi: rewardsClaimAbi(), data: claimData }).args[0], 12n);
assert.throws(() => approvePlan(USER, 1n));

const ready = { chainId: 137, code: "0x1234", paused: false, simulationOk: true, quoteFresh: true, stale: false, walletReject: false };
assert.equal(executionGate({ ...ready, action: "swap" }).ok, true);
assert.equal(executionGate({ ...ready, action: "stake", chainId: 1 }).ok, false);
assert.equal(executionGate({ ...ready, action: "swap", code: "0x" }).ok, false);
assert.equal(executionGate({ ...ready, action: "stake", paused: true }).ok, false);
assert.equal(executionGate({ ...ready, action: "withdraw", paused: true }).ok, true);
assert.equal(executionGate({ ...ready, action: "swap", simulationOk: false }).ok, false);
assert.equal(executionGate({ ...ready, action: "swap", quoteFresh: false }).ok, false);
assert.equal(executionGate({ ...ready, action: "swap", stale: true }).ok, false);
assert.match(executionGate({ ...ready, action: "stake", walletReject: true }).errors.join(" "), /rejected/i);

assert.equal(shareTableSums(), 10_000);
for (let i = 1; i < SHARE_BPS.length; i++) assert.ok(SHARE_BPS[i] < SHARE_BPS[i - 1]);
assert.equal(SHARE_BPS[0], 1500);
assert.equal(SHARE_BPS[1], 1000);
assert.equal(SHARE_BPS[2], 500);

const now = 1_700_000_000;
const price = { answer: 50_000_000n, updatedAt: now - 10, blockTime: now, roundId: 5n, answeredInRound: 5n };
const scored = scoreTrade({ tokenIn: NATIVE, tokenOut: BZB, consumed: 10n ** 18n, time: now, trader: USER, ...price });
assert.ok(scored > 0n);
assert.equal(scoreTrade({ tokenIn: BZB, tokenOut: WPOL, consumed: 10n ** 18n, time: now, trader: USER, ...price }), 0n);
assert.equal(scoreTrade({ tokenIn: WPOL, tokenOut: BZB, consumed: 0n, time: now, trader: USER, ...price }), 0n);
assert.equal(trustedUsdE8({ amount: 10n ** 18n, answer: 1n, updatedAt: 1n, blockTime: 100_000, maxAge: 86_400 }), 0n);

const day = buildDayBoard(
  [
    { trader: USER, tokenIn: WPOL, tokenOut: BZB, consumed: 100n * 10n ** 18n, time: now, score: 100n * 10n ** 8n },
    { trader: USER, tokenIn: BZB, tokenOut: NATIVE, consumed: 1n, time: now + 30, score: 40n * 10n ** 8n },
    { trader: OTHER, tokenIn: USDC, tokenOut: BZB, consumed: 30n * 10n ** 6n, time: now, score: 30n * 10n ** 8n },
    { trader: OTHER, tokenIn: WPOL, tokenOut: BZB, consumed: 1n, time: now, score: 10n * 10n ** 8n },
    { trader: USER, tokenIn: ZERO, tokenOut: BZB, consumed: 1n, time: now + 10, score: 0n },
  ],
  { capBzb: 1000n * 10n ** 18n },
);
assert.equal(day[0].trader, USER.toLowerCase());
assert.equal(day[0].scoreE8, 60n * 10n ** 8n);
assert.equal(day[0].estimatedBzb, 150n * 10n ** 18n);
assert.equal(day[1].estimatedBzb, 100n * 10n ** 18n);
assert.equal(day.length, 2);

const capped = buildDayBoard(
  [
    { trader: USER, tokenIn: WPOL, tokenOut: BZB, score: 40_000n * 10n ** 8n, time: 1 },
    { trader: USER, tokenIn: WPOL, tokenOut: BZB, score: 20_000n * 10n ** 8n, time: 2 },
  ],
  { capBzb: 1000n * 10n ** 18n },
);
assert.equal(capped[0].scoreE8, 50_000n * 10n ** 8n);

const empty = buildDayBoard([], { capBzb: 1000n * 10n ** 18n });
assert.deepEqual(empty, []);
const unfunded = rewardState({ fundedBalance: 0n, posted: false, claimable: 0n });
assert.equal(unfunded.funded, false);
assert.equal(unfunded.posted, false);
assert.equal(unfunded.claimable, 0n);
assert.equal(unfunded.estimateIsPayment, false);
assert.equal(formatUnits(150n * 10n ** 18n, 18, 2), "150");
assert.equal(parseUnits("1.5", 18), 15n * 10n ** 17n);
assert.throws(() => parseUnits("1.2e2", 18));

console.log("desk live tests ok");
