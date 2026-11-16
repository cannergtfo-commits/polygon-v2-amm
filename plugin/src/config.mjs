/**
 * Static facts for the Polygon plugin. Addresses are checksummed where they came from a reviewed source.
 * Router facts are re-read live (see router.mjs); nothing here is trusted over the chain.
 */
export const CHAIN_ID = 137;
export const FEE_ROUTER = "0x014AC678c96dd5dFAEc78BfffD8E00EEbf117E9b";
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const ZERO = "0x0000000000000000000000000000000000000000";

export const WPOL = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
export const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
export const USDCE = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
export const USDT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";
export const WETH = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";
export const WBTC = "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6";
export const DAI = "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063";
export const BZB = "0x462D8d82C2B2D2DDabf7f8a93928De09d47A5807";

/**
 * Anchors: USD comes from Chainlink, never from a pool. Every other price is derived from pools
 * paired with an anchor (pass 1) or with a deep token priced in pass 1 (pass 2).
 */
export const ANCHORS = {
  [WPOL.toLowerCase()]: { symbol: "WPOL", decimals: 18, feed: "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0" },
  [USDC.toLowerCase()]: { symbol: "USDC", decimals: 6, feed: "0xfE4A8cc5b5B2366C1B58Bea3858e81843581b2F7" },
  [USDCE.toLowerCase()]: { symbol: "USDC.e", decimals: 6, feed: "0xfE4A8cc5b5B2366C1B58Bea3858e81843581b2F7" },
  [USDT.toLowerCase()]: { symbol: "USDT", decimals: 6, feed: "0x0A6513e40db6EB1b165753AD52E80663aeA50545" },
  [WETH.toLowerCase()]: { symbol: "WETH", decimals: 18, feed: "0xF9680D99D6C9589e2a93a78A04A279e509205945" },
  [WBTC.toLowerCase()]: { symbol: "WBTC", decimals: 8, feed: "0xc907E116054Ad103354f2D350FD2514433D57F6f" },
  [DAI.toLowerCase()]: { symbol: "DAI", decimals: 18, feed: "0x4746DeC9e833A82EC7C2C1356372CcF2cfcD2F3D" },
};

/** Route hubs for two-hop quotes. BZB is included so Blazar pools are reachable. */
export const ROUTE_HUBS = [WPOL, USDC, USDCE, USDT, WETH, WBTC, DAI, BZB];

/** Tokens always kept in the list even under the liquidity bar (flagged `pinned`). */
export const PINNED = [BZB, "0xb837f0e111596348A27e424e43938eb01753cf34", "0xd2aD34cab1fc6ee954276d28c67E219875397420"];

/**
 * Liquidity bar. A token is "liquid" when its best pool has at least MIN_TVL_USD of two-sided depth,
 * measured as 2 x min(hub side USD, token side USD). Using the smaller side means a stale
 * concentrated pool sitting fully in one token, or a pool stuffed with a worthless token, does not count.
 */
export const MIN_TVL_USD = 10_000;
/** Tokens at or above this depth become pass-2 hubs (e.g. LINK, AAVE, QUICK, stMATIC). */
export const SECONDARY_HUB_TVL_USD = 250_000;
/** Pools within this fraction of the bar are kept in the hot set so they can be promoted cheaply. */
export const WATCH_FRACTION = 0.25;

/**
 * Venues. `kind` decides how pools are discovered, priced and executed. `router` is the
 * fee-router target for concentrated venues; V2 venues are executed by the fee router directly
 * (KIND_V2) through the factory address. `executable` is decided live from the router allowlist.
 */
export const VENUES = [
  { id: "blazar", name: "BlazarSwap", kind: "v2", factory: "0x8e9663F4b15F3B291B1354e20d1B019d8864830F", feeBps: 30, fromBlock: 0 },
  { id: "quickswap-v2", name: "QuickSwap v2", kind: "v2", factory: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32", feeBps: 30, fromBlock: 0 },
  { id: "sushi", name: "SushiSwap", kind: "v2", factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4", feeBps: 30, fromBlock: 0 },
  { id: "apeswap", name: "ApeSwap", kind: "v2", factory: "0xCf083Be4164828f00cAE704EC15a36D711491284", feeBps: 20, fromBlock: 0 },
  {
    id: "uniswap-v3", name: "Uniswap v3", kind: "v3",
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    fromBlock: 22_000_000,
  },
  {
    id: "quickswap-v3", name: "QuickSwap v3", kind: "algebra",
    factory: "0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28",
    router: "0xf5b509bB0909a69B1c207E495f687a596C168E12",
    quoter: "0xa15F0D7377B2A0C0c10db057f641beD21028FC89",
    fromBlock: 32_000_000,
  },
  {
    id: "quickswap-v4", name: "QuickSwap v4", kind: "algebra4",
    factory: "0x134c1dBE4860A9cAaf89002574fFe814772D9904",
    router: "0x96FeF39089380F4319e8eF01aA8338615C36f1BB",
    quoter: "0x4666599D48E8C72B91a73f9aDE04eda17C5FDBa7",
    fromBlock: 60_000_000,
  },
];

export const TOPICS = {
  pairCreated: "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9",
  poolCreated: "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118",
  algebraPool: "0x91ccaa7a278130b65168c3a0c8d3bcae84cf5e43704342bd3ec0b59e59c036db",
};

/**
 * Free RPCs only. Alchemy is deliberately absent: its free tier is shared with PolyPump.
 * `logs` endpoints must serve historical ranges; publicnode is not archive for getLogs.
 */
export const RPCS = {
  call: ["https://polygon-bor-rpc.publicnode.com", "https://gateway.tenderly.co/public/polygon", "https://polygon.drpc.org"],
  logs: [
    { url: "https://gateway.tenderly.co/public/polygon", maxRange: 5_000_000 },
    { url: "https://polygon.drpc.org", maxRange: 10_000 },
  ],
};

/** Alchemy CU weights (alchemy.com/docs/reference/compute-unit-costs, read 2026-11-16), for the cost estimate only. */
export const ALCHEMY_CU = { eth_call: 26, eth_getLogs: 60, eth_blockNumber: 10, eth_getBlockByNumber: 20, eth_gasPrice: 20, eth_chainId: 0, eth_getCode: 20 };

/** Max sub-calls per Multicall3 eth_call. Keeps gas under node eth_call caps. */
export const MULTICALL_CHUNK = 400;
