/**
 * Unsigned transaction builders. Nothing here signs or sends.
 * Calldata layout and offset checks mirror docs/js/desk.js encodeTarget().
 */
import { encodeFunctionData } from "viem";
import * as desk from "../../docs/js/desk-core.mjs";
import { ALGEBRA4_ROUTER, ALGEBRA_ROUTER, ERC20, FEE_ROUTER_ABI, UNI_ROUTER } from "./abis.mjs";
import { CHAIN_ID, FEE_ROUTER } from "./config.mjs";

function word(data, offset) {
  const start = 2 + Number(offset) * 2;
  return BigInt(`0x${data.slice(start, start + 64)}`);
}

export function encodeTarget(plan) {
  let data;
  const a = plan.args;
  if (a.sqrtPriceLimitX96 !== undefined) {
    data = encodeFunctionData({ abi: UNI_ROUTER, functionName: "exactInputSingle", args: [{ tokenIn: a.tokenIn, tokenOut: a.tokenOut, fee: a.fee, recipient: a.recipient, amountIn: a.amountIn, amountOutMinimum: a.amountOutMinimum, sqrtPriceLimitX96: a.sqrtPriceLimitX96 }] });
  } else if (a.deployer !== undefined) {
    data = encodeFunctionData({ abi: ALGEBRA4_ROUTER, functionName: "exactInputSingle", args: [{ tokenIn: a.tokenIn, tokenOut: a.tokenOut, deployer: a.deployer, recipient: a.recipient, deadline: a.deadline, amountIn: a.amountIn, amountOutMinimum: a.amountOutMinimum, limitSqrtPrice: a.limitSqrtPrice }] });
  } else {
    data = encodeFunctionData({ abi: ALGEBRA_ROUTER, functionName: "exactInputSingle", args: [{ tokenIn: a.tokenIn, tokenOut: a.tokenOut, recipient: a.recipient, deadline: a.deadline, amountIn: a.amountIn, amountOutMinimum: a.amountOutMinimum, limitSqrtPrice: a.limitSqrtPrice }] });
  }
  if (word(data, plan.amountOffset) !== 0n || word(data, plan.minOffset) !== a.amountOutMinimum) {
    throw new Error("Router calldata offsets do not match the reviewed adapter");
  }
  return data;
}

/**
 * Build the router swap tx from a quote. blockTime is the latest block timestamp (seconds);
 * the router rejects deadlines more than 180 s ahead, so build right before signing.
 */
export function buildSwapTx({ quote, recipient, blockTime, slippageBps = 50, feeRouter = FEE_ROUTER }) {
  if (!quote?.steps?.length) throw new Error("Quote has no route");
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient || "")) throw new Error("recipient must be an address");
  const plan = desk.swapPlan({ tokenIn: quote.tokenIn, tokenOut: quote.tokenOut, amountIn: BigInt(quote.amountIn), steps: quote.steps, recipient, blockTime, slippageBps, feeRouter });
  const calls = plan.calls.map((c) => ({
    kind: c.kind,
    target: c.target,
    spendToken: c.spendToken,
    v2TokenOut: c.v2TokenOut,
    bps: c.bps,
    useBalance: c.useBalance,
    minBuy: c.minBuy,
    amountOffset: c.amountOffset,
    minOffset: c.minOffset,
    data: c.kind === 0 ? encodeTarget(c.plan) : "0x",
  }));
  const data = encodeFunctionData({
    abi: FEE_ROUTER_ABI,
    functionName: "swap",
    args: [plan.tokenIn, plan.tokenOut, plan.amountIn, plan.minAmountOut, plan.recipient, plan.deadline, plan.unwrapNative, calls, plan.sweep],
  });
  return {
    chainId: CHAIN_ID,
    to: feeRouter,
    data,
    value: plan.value,
    minAmountOut: plan.minAmountOut,
    deadline: plan.deadline,
    // Rough. Algebra Integral (QuickSwap v4) hops cost ~2x a Uniswap v3 hop. Prefer eth_estimateGas +25%.
    gasHint: (BigInt(desk.gasUnits(quote.steps)) + 250_000n * BigInt(quote.steps.filter((st) => st.kind === "algebra4").length)) * 13n / 10n,
    approval: desk.isNative(quote.tokenIn) ? null : { token: quote.tokenIn, spender: feeRouter, amount: BigInt(quote.amountIn) },
  };
}

/** Exact-amount ERC-20 approval (never unlimited), as the desk does. */
export function buildApproveTx({ token, spender = FEE_ROUTER, amount }) {
  const plan = desk.approvalPlan(0n, BigInt(amount));
  return { chainId: CHAIN_ID, to: token, value: 0n, data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [spender, plan[0]] }) };
}
