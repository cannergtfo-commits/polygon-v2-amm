import { encodeFunctionData, type Address, type Hex } from "viem";
import { algebraRouterAbi, uniRouterAbi } from "@/lib/abis";
import type { Step } from "@/lib/types";

export const NO_PATCH = (1n << 256n) - 1n;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export type RouterCall = {
  kind: number;
  target: Address;
  spendToken: Address;
  v2TokenOut: Address;
  bps: number;
  useBalance: boolean;
  minBuy: bigint;
  amountOffset: bigint;
  minOffset: bigint;
  data: Hex;
};

export function hopFloor(quotedOut: string, slippageBps: number) {
  const out = BigInt(quotedOut || "0");
  const min = (out * BigInt(Math.max(0, 10_000 - slippageBps))) / 10_000n;
  if (min <= 0n) throw new Error("Quoted hop is too small to set a minimum");
  return min;
}

export function buildCalls(steps: Step[], feeRouter: Address, deadline: bigint, slippageBps: number): RouterCall[] {
  return steps.map((step) => {
    const minBuy = hopFloor(step.quotedOut, slippageBps);
    if (step.kind === "v2") {
      if (!step.factory) throw new Error("V2 step is missing a factory");
      return {
        kind: 1,
        target: step.factory as Address,
        spendToken: step.tokenIn as Address,
        v2TokenOut: step.tokenOut as Address,
        bps: step.bps,
        useBalance: step.useBalance,
        minBuy,
        amountOffset: NO_PATCH,
        minOffset: NO_PATCH,
        data: "0x",
      };
    }
    if (!step.router) throw new Error("Router step is missing a target");
    const data =
      step.kind === "v3"
        ? encodeFunctionData({
            abi: uniRouterAbi,
            functionName: "exactInputSingle",
            args: [
              {
                tokenIn: step.tokenIn as Address,
                tokenOut: step.tokenOut as Address,
                fee: step.feeTier ?? 500,
                recipient: feeRouter,
                amountIn: 0n,
                amountOutMinimum: minBuy,
                sqrtPriceLimitX96: 0n,
              },
            ],
          })
        : encodeFunctionData({
            abi: algebraRouterAbi,
            functionName: "exactInputSingle",
            args: [
              {
                tokenIn: step.tokenIn as Address,
                tokenOut: step.tokenOut as Address,
                recipient: feeRouter,
                deadline,
                amountIn: 0n,
                amountOutMinimum: minBuy,
                limitSqrtPrice: 0n,
              },
            ],
          });
    return {
      kind: 0,
      target: step.router as Address,
      spendToken: step.tokenIn as Address,
      v2TokenOut: step.tokenOut as Address,
      bps: step.bps,
      useBalance: step.useBalance,
      minBuy,
      amountOffset: 132n,
      minOffset: 164n,
      data,
    };
  });
}

export function sweepTokens(steps: Step[], outputToken: string) {
  const mids = new Set<string>();
  for (let i = 0; i < steps.length - 1; i++) {
    if (steps[i + 1]?.useBalance) mids.add(steps[i].tokenOut.toLowerCase());
  }
  return [...mids].filter((token) => token !== outputToken.toLowerCase()) as Address[];
}
