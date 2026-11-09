import { approvalPlan, buildSwapEnvelope, confirmChoice, guardedSend, txFingerprint } from "@/lib/review-envelope";
import type { QuoteResponse } from "@/lib/types";

function assert(cond: unknown, message: string) {
  if (!cond) throw new Error(message);
}

const account = "0x1111111111111111111111111111111111111111" as const;
const sell = "0x2222222222222222222222222222222222222222" as const;
const buy = "0x3333333333333333333333333333333333333333" as const;
const router = "0x4444444444444444444444444444444444444444" as const;

const quote = {
  tokenIn: { address: sell, symbol: "AAA", name: "A", decimals: 18 },
  tokenOut: { address: buy, symbol: "BBB", name: "B", decimals: 18 },
  amountIn: "1000",
  feeBps: 5,
  feeAmount: "0",
  routeAmount: "1000",
  reference: null,
  priceImpactBps: 10,
  gasPrice: "1",
  polUsdE8: null,
  gasUsdE8: null,
  notes: [],
  best: {
    id: "v2",
    label: "Blazar",
    amountOut: "900",
    gasUnits: 100000,
    steps: [
      {
        kind: "v2" as const,
        venue: "Blazar",
        factory: "0x5555555555555555555555555555555555555555",
        router: null,
        feeTier: null,
        feeBps: 30,
        tokenIn: sell,
        tokenOut: buy,
        pool: "0x6666666666666666666666666666666666666666",
        bps: 10000,
        useBalance: false,
        wrapperFee: "0",
        quotedOut: "900",
      },
    ],
  },
  alternatives: [],
} as QuoteResponse;

function envelope(approval: ReturnType<typeof approvalPlan> | null) {
  return buildSwapEnvelope({
    key: "trade-1",
    quote,
    feeRouter: router,
    sell,
    buy,
    amountIn: 1000n,
    minOut: 895n,
    slippageBps: 50,
    recipient: account,
    unwrap: false,
    value: 0n,
    approval,
    nowSeconds: 1_700_000_000,
  });
}

const zeroAllowance = envelope(approvalPlan("approve", sell, router, 1000n, account));
assert(confirmChoice({
  ready: true,
  chainId: 137,
  connected: true,
  loading: false,
  pending: false,
  requestKey: "trade-1",
  envelope: zeroAllowance,
  approvalSim: zeroAllowance.approval!.fingerprint,
  swapSim: null,
  highImpact: false,
  impactAck: false,
  slipAck: false,
}).kind === "approve", "zero allowance chooses approval");
assert(confirmChoice({
  ready: true,
  chainId: 137,
  connected: true,
  loading: false,
  pending: false,
  requestKey: "trade-1",
  envelope: zeroAllowance,
  approvalSim: zeroAllowance.approval!.fingerprint,
  swapSim: null,
  highImpact: false,
  impactAck: false,
  slipAck: false,
}).enabled, "approval does not wait for the swap simulation");
assert(!confirmChoice({
  ready: true,
  chainId: 137,
  connected: true,
  loading: false,
  pending: false,
  requestKey: "trade-1",
  envelope: zeroAllowance,
  approvalSim: null,
  swapSim: zeroAllowance.fingerprint,
  highImpact: false,
  impactAck: false,
  slipAck: false,
}).enabled, "an unsimulated approval stays disabled");

const reset = envelope(approvalPlan("reset", sell, router, 0n, account));
assert(confirmChoice({
  ready: true,
  chainId: 137,
  connected: true,
  loading: false,
  pending: false,
  requestKey: "trade-1",
  envelope: reset,
  approvalSim: reset.approval!.fingerprint,
  swapSim: null,
  highImpact: false,
  impactAck: false,
  slipAck: false,
}).kind === "reset", "a positive short allowance is a reset");

const swap = envelope(null);
assert(!confirmChoice({
  ready: true,
  chainId: 137,
  connected: true,
  loading: false,
  pending: false,
  requestKey: "trade-1",
  envelope: swap,
  approvalSim: null,
  swapSim: null,
  highImpact: false,
  impactAck: false,
  slipAck: false,
}).enabled, "a failed swap simulation cannot be confirmed");
assert(confirmChoice({
  ready: true,
  chainId: 137,
  connected: true,
  loading: false,
  pending: false,
  requestKey: "trade-1",
  envelope: swap,
  approvalSim: null,
  swapSim: swap.fingerprint,
  highImpact: false,
  impactAck: false,
  slipAck: false,
}).enabled, "the exact simulated envelope can be confirmed");
assert(!confirmChoice({
  ready: true,
  chainId: 137,
  connected: true,
  loading: false,
  pending: false,
  requestKey: "trade-1",
  envelope: swap,
  approvalSim: null,
  swapSim: "other",
  highImpact: false,
  impactAck: false,
  slipAck: false,
}).enabled, "a different simulation does not authorize this envelope");

const highSlip = buildSwapEnvelope({ ...{
  key: "trade-1",
  quote,
  feeRouter: router,
  sell,
  buy,
  amountIn: 1000n,
  minOut: 800n,
  slippageBps: 200,
  recipient: account,
  unwrap: false,
  value: 0n,
  approval: null,
  nowSeconds: 1_700_000_000,
} });
assert(!confirmChoice({
  ready: true,
  chainId: 137,
  connected: true,
  loading: false,
  pending: false,
  requestKey: "trade-1",
  envelope: highSlip,
  approvalSim: null,
  swapSim: highSlip.fingerprint,
  highImpact: false,
  impactAck: false,
  slipAck: false,
}).enabled, "high slippage still needs its own acknowledgement");

const changed = { ...quote, best: { ...quote.best!, amountOut: "1" } };
assert(swap.quote.best?.amountOut === "900", "the frozen quote does not follow a later object");
assert(changed.best?.amountOut === "1", "the live quote can change");
assert(swap.fingerprint === txFingerprint({ to: router, data: swap.data, value: 0n, account }), "fingerprint is the calldata that would be sent");
assert(swap.minOut === 895n, "minimum is frozen");

async function main() {
  let calls = 0;
  let threw = false;
  try {
    await guardedSend(async () => {
      calls += 1;
    });
  } catch {
    threw = true;
  }
  assert(threw && calls === 0, "preview refusal does not call the sender");
  console.log("review envelope tests ok");
}

main();
