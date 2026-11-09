export type TokenMeta = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logo?: string;
};

export type Step = {
  kind: "v2" | "v3" | "algebra";
  venue: string;
  factory: string | null;
  router: string | null;
  feeTier: number | null;
  feeBps: number | null;
  tokenIn: string;
  tokenOut: string;
  pool: string | null;
  bps: number;
  useBalance: boolean;
  wrapperFee: string;
  quotedOut: string;
};

export type RouteQuote = {
  id: string;
  label: string;
  amountOut: string;
  steps: Step[];
  gasUnits: number;
};

export type QuoteResponse = {
  tokenIn: TokenMeta;
  tokenOut: TokenMeta;
  amountIn: string;
  feeBps: number;
  feeAmount: string;
  routeAmount: string;
  best: RouteQuote | null;
  alternatives: RouteQuote[];
  reference: { source: string; amountOut: string } | null;
  priceImpactBps: number | null;
  gasPrice: string;
  polUsdE8: string | null;
  gasUsdE8: string | null;
  notes: string[];
};
