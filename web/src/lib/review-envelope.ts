import { encodeFunctionData, type Address, type Hex } from "viem";
import { erc20Abi, feeRouterAbi } from "@/lib/abis";
import { buildCalls, sweepTokens, type RouterCall } from "@/lib/execute";
import { assertCanWrite } from "@/lib/preview";
import type { QuoteResponse } from "@/lib/types";

export type ApprovalPlan = {
  kind: "approve" | "reset";
  token: Address;
  spender: Address;
  amount: bigint;
  data: Hex;
  fingerprint: string;
};

export type SwapEnvelope = {
  key: string;
  fingerprint: string;
  sell: Address;
  buy: Address;
  amountIn: bigint;
  minOut: bigint;
  slippageBps: number;
  recipient: Address;
  deadline: bigint;
  unwrap: boolean;
  calls: RouterCall[];
  sweeps: Address[];
  value: bigint;
  data: Hex;
  quote: QuoteResponse;
  approval: ApprovalPlan | null;
};

export function txFingerprint(parts: { to: string; data: string; value: bigint; account: string }) {
  return [parts.to.toLowerCase(), parts.data.toLowerCase(), parts.value.toString(), parts.account.toLowerCase()].join("|");
}

export function approvalPlan(kind: "approve" | "reset", token: Address, spender: Address, amount: bigint, account: Address): ApprovalPlan {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, amount],
  });
  return {
    kind,
    token,
    spender,
    amount,
    data,
    fingerprint: txFingerprint({ to: token, data, value: 0n, account }),
  };
}

export function buildSwapEnvelope(input: {
  key: string;
  quote: QuoteResponse;
  feeRouter: Address;
  sell: Address;
  buy: Address;
  amountIn: bigint;
  minOut: bigint;
  slippageBps: number;
  recipient: Address;
  unwrap: boolean;
  value: bigint;
  approval: ApprovalPlan | null;
  nowSeconds: number;
}): SwapEnvelope {
  if (!input.quote.best) throw new Error("There is no route to review.");
  if (input.minOut <= 0n) throw new Error("The minimum output is zero.");
  const deadline = BigInt(input.nowSeconds + 120);
  const calls = buildCalls(input.quote.best.steps, input.feeRouter, deadline, input.slippageBps);
  const sweeps = sweepTokens(input.quote.best.steps, input.unwrap ? input.buy : input.buy);
  const data = encodeFunctionData({
    abi: feeRouterAbi,
    functionName: "swap",
    args: [input.sell, input.buy, input.amountIn, input.minOut, input.recipient, deadline, input.unwrap, calls, sweeps],
  });
  return {
    key: input.key,
    fingerprint: txFingerprint({ to: input.feeRouter, data, value: input.value, account: input.recipient }),
    sell: input.sell,
    buy: input.buy,
    amountIn: input.amountIn,
    minOut: input.minOut,
    slippageBps: input.slippageBps,
    recipient: input.recipient,
    deadline,
    unwrap: input.unwrap,
    calls,
    sweeps,
    value: input.value,
    data,
    quote: input.quote,
    approval: input.approval,
  };
}

export type ConfirmKind = "approve" | "reset" | "swap" | "blocked";

/** Approval and reset do not wait on the swap simulation. The swap waits on its own exact envelope. */
export function confirmChoice(input: {
  ready: boolean;
  chainId: number | undefined;
  connected: boolean;
  loading: boolean;
  pending: boolean;
  requestKey: string;
  envelope: Pick<SwapEnvelope, "key" | "fingerprint" | "slippageBps" | "approval"> | null;
  approvalSim: string | null;
  swapSim: string | null;
  highImpact: boolean;
  impactAck: boolean;
  slipAck: boolean;
}): { kind: ConfirmKind; enabled: boolean } {
  if (!input.connected || input.chainId !== 137 || !input.ready || input.loading || input.pending || !input.envelope) {
    return { kind: "blocked", enabled: false };
  }
  if (input.envelope.key !== input.requestKey) return { kind: "blocked", enabled: false };
  if (input.envelope.approval) {
    const kind = input.envelope.approval.kind;
    return { kind, enabled: input.approvalSim === input.envelope.approval.fingerprint };
  }
  const acked = (!input.highImpact || input.impactAck) && (input.envelope.slippageBps <= 100 || input.slipAck);
  return {
    kind: "swap",
    enabled: acked && input.swapSim === input.envelope.fingerprint,
  };
}

/** Preview builds throw here. The sender is not called. */
export async function guardedSend<T>(send: () => Promise<T>): Promise<T> {
  assertCanWrite();
  return send();
}
