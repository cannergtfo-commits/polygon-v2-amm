import { isAddress } from "viem";
import { QUOTE_BODY_BYTES, QUOTE_SLOTS, QUOTE_WORK_MS } from "@/lib/quote-budget";
import { scorePools, type PoolFacts } from "@/lib/pool-score";
import { addresses, isDeployed, registry, tokenByAddress } from "@/lib/registry";
import { quoteRequestKey, sameAsset, slippageBpsOf } from "@/lib/trade-selection";
import { wrapperOnSpend } from "@/lib/wrapper-fee";

export const BOT_SCHEMA = "blazar.bot.v1";
export const BOT_VERSION = "1.0.0";

/** Reviewed deployment codehash. None exists yet, so unsigned building stays closed. */
export const VERIFIED_FEE_ROUTER_CODEHASH: string | null = null;

const MAX_UINT = (1n << 256n) - 1n;

export const limits = {
  quoteSlots: QUOTE_SLOTS,
  quoteWorkMs: QUOTE_WORK_MS,
  quoteBodyBytes: QUOTE_BODY_BYTES,
  searchQueryChars: 32,
  searchResults: 8,
  botCallsPerMinute: 28,
  chainId: 137,
} as const;

export class BotLimiter {
  private stamps: number[] = [];

  constructor(private readonly max: number = limits.botCallsPerMinute, private readonly windowMs: number = 60_000) {}

  take(now = Date.now()) {
    this.stamps = this.stamps.filter((stamp) => now - stamp < this.windowMs);
    if (this.stamps.length >= this.max) throw new Error("Too many bot calls. Wait a minute.");
    this.stamps.push(now);
  }
}

export function discover() {
  return {
    schema: BOT_SCHEMA,
    version: BOT_VERSION,
    chainId: limits.chainId,
    status: "local-prototype" as const,
    publishedPlugin: false,
    registrySubmitted: false,
    liveExecution: false,
    signing: false,
    broadcast: false,
    feeRouterDeployed: isDeployed(addresses.feeRouter),
    feeRouterVerified: VERIFIED_FEE_ROUTER_CODEHASH !== null,
    unsignedTransactions: "closed" as const,
    openapi: "/openapi/blazar-bot-v1.yaml",
    docs: "/developers",
    quote: { method: "POST", path: "/api/quote", slots: limits.quoteSlots, timeoutMs: limits.quoteWorkMs },
    mcp: {
      transport: "stdio",
      command: "pnpm exec tsx scripts/mcp-stdio.ts",
      cwd: "web",
      packageStatus: "local-prototype",
    },
  };
}

export function health() {
  return {
    ok: true,
    ...discover(),
    contracts: {
      feeRouter: addresses.feeRouter,
      note: "A nonzero address is not treated as a verified deployment.",
    },
  };
}

export function searchTokens(query: string) {
  const q = query.trim();
  if (q.length === 0 || q.length > limits.searchQueryChars) throw new Error("Token search must be 1 to 32 characters.");
  if (!/^[a-zA-Z0-9.]+$/.test(q)) throw new Error("Token search accepts letters, numbers, and dots only.");
  const needle = q.toLowerCase();
  return registry.tokens
    .filter((token) => token.symbol.toLowerCase().includes(needle) || token.name.toLowerCase().includes(needle) || token.address.toLowerCase() === needle)
    .slice(0, limits.searchResults)
    .map(publicToken);
}

export function tokenDetails(address: string) {
  if (!isAddress(address)) throw new Error("Paste a token address.");
  const known = tokenByAddress(address);
  if (!known) {
    return { known: false, address, chainId: limits.chainId, note: "This kit does not look up unknown tokens from the network." };
  }
  return { known: true, ...publicToken(known) };
}

function publicToken(token: { symbol: string; name: string; address: string; decimals: number; native?: boolean }) {
  return {
    symbol: token.symbol,
    name: token.name,
    address: token.address,
    decimals: token.decimals,
    chainId: limits.chainId,
    native: Boolean(token.native),
    baseUnit: `1 ${token.symbol} = 10^${token.decimals} base units`,
  };
}

export function toBaseUnits(amount: string, decimals: number) {
  const text = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error("Amount must be a decimal number.");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("Decimals must be 0 to 18.");
  const [whole, frac = ""] = text.split(".");
  if (frac.length > decimals) throw new Error("Too many decimal places for this token.");
  const digits = `${whole}${frac.padEnd(decimals, "0")}`.replace(/^0+/, "") || "0";
  if (digits.length > 78) throw new Error("Amount must be a non-zero integer of at most 78 digits.");
  const value = BigInt(digits);
  if (value <= 0n || value > MAX_UINT) throw new Error("Amount is outside uint256.");
  return value.toString();
}

export function feePolicy() {
  const external = wrapperOnSpend(10_000n, 10_000n, true, registry.fee.aggregatorBps);
  const ownPool = wrapperOnSpend(10_000n, 10_000n, false, registry.fee.aggregatorBps);
  return {
    chainId: limits.chainId,
    wrapperFeeBps: registry.fee.aggregatorBps,
    wrapperFeeLabel: "0.05% of external-routed principal, once",
    ownFactoryFee: "A BlazarSwap factory leg pays no wrapper fee.",
    poolFeeBps: registry.fee.poolFeeBps,
    maxWrapperFeeBps: registry.fee.maxBps,
    exampleOn10000: { externalFee: external.fee.toString(), blazarFactoryFee: ownPool.fee.toString() },
    recipient: registry.fee.recipient,
    live: false,
  };
}

export function chartVersusRouting(pools: PoolFacts[]) {
  const ranked = scorePools(pools).slice(0, 4);
  return {
    chart: "One displayed pool. Score is 0.70 times normalized liquidity plus 0.30 times normalized age in seconds. Candle count is not the history signal.",
    routing: "A quote may use any allowlisted Blazar, QuickSwap, Sushi, Ape, Uniswap v3, or Algebra pool. The chart pool does not restrict the route.",
    rankedForDisplayOnly: ranked.map((pool) => ({ address: pool.address, score: pool.score })),
  };
}

export function assertQuoteInput(input: { tokenIn?: string; tokenOut?: string; amountIn?: string }) {
  if (!input.tokenIn || !input.tokenOut || !isAddress(input.tokenIn) || !isAddress(input.tokenOut)) {
    throw new Error("Paste two token addresses.");
  }
  if (sameAsset(input.tokenIn, input.tokenOut, registry.wpol)) {
    throw new Error("Choose two different tokens. POL and WPOL are the same asset once wrapped.");
  }
  if (!input.amountIn || !/^\d{1,78}$/.test(input.amountIn)) {
    throw new Error("Amount must be a non-zero integer of at most 78 digits.");
  }
  const amount = BigInt(input.amountIn);
  if (amount <= 0n || amount > MAX_UINT) throw new Error("Amount is outside uint256.");
  return { tokenIn: input.tokenIn, tokenOut: input.tokenOut, amountIn: amount };
}

export function unsignedPreview(input: {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  slippage?: string;
  recipient?: string;
}) {
  const slippageBps = slippageBpsOf(input.slippage ?? "0.50");
  if (slippageBps == null) throw new Error("Slippage must be from 0.01% to 5%.");
  if (input.recipient && !isAddress(input.recipient)) throw new Error("Recipient must be an address.");
  const key = quoteRequestKey({
    chainId: limits.chainId,
    sell: input.tokenIn,
    buy: input.tokenOut,
    amount: input.amountIn,
    slippageBps,
  });
  return {
    ok: false as const,
    signing: false as const,
    broadcast: false as const,
    unsignedTransactions: "closed" as const,
    reason: "Unsigned swap building is closed. The fee router in this tree is not a verified deployment, and a nonzero address alone would not open it.",
    wouldRequire: {
      chainId: limits.chainId,
      slippageBps,
      minimumOut: "floor of quoted output after slippage, never zero",
      deadlineSeconds: 120,
      recipient: input.recipient ?? "the connected account, frozen into the review",
      allowance: "exact amountIn for the fee router, never the uint256 maximum",
      reviewFingerprint: "lowercase router, calldata, value, and recipient",
      requestKey: key,
    },
  };
}

export const examples = [
  {
    title: "Sell 1000 BZB for USDC",
    tokenIn: "0x462D8d82C2B2D2DDabf7f8a93928De09d47A5807",
    tokenOut: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    human: "1000",
    decimals: 18,
    amountIn: toBaseUnits("1000", 18),
  },
  {
    title: "Sell 10 USDC for BZB",
    tokenIn: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    tokenOut: "0x462D8d82C2B2D2DDabf7f8a93928De09d47A5807",
    human: "10",
    decimals: 6,
    amountIn: toBaseUnits("10", 6),
  },
  {
    title: "Sell 0.2 POL for USDC",
    tokenIn: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    tokenOut: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    human: "0.2",
    decimals: 18,
    amountIn: toBaseUnits("0.2", 18),
    note: "POL and WPOL are the same asset after wrapping. Do not quote them against each other.",
  },
] as const;

export const mcpToolNames = [
  "blazar_health",
  "blazar_search_tokens",
  "blazar_token_details",
  "blazar_fee_policy",
  "blazar_chart_vs_routing",
  "blazar_to_base_units",
  "blazar_quote",
  "blazar_unsigned_preview",
] as const;

export const forbiddenMcpTools = ["sign", "broadcast", "eth_call", "eth_send", "fetch_url", "approve_max", "wallet_secret"] as const;
