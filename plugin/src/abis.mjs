import { parseAbi } from "viem";

export const ERC20 = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
export const ERC20_BYTES32 = parseAbi(["function symbol() view returns (bytes32)"]);
export const V2_PAIR = parseAbi(["function getReserves() view returns (uint112,uint112,uint32)", "function token0() view returns (address)"]);
export const V3_POOL = parseAbi(["function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)", "function liquidity() view returns (uint128)"]);
/** Both Algebra v1 and Integral return the sqrt price as the first word of globalState(); decode that word only. */
export const ALGEBRA_GLOBAL_STATE_SELECTOR = "0xe76c01e4";
export const FEED = parseAbi(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function decimals() view returns (uint8)", "function description() view returns (string)"]);

export const FEE_ROUTER_ABI = parseAbi([
  "struct Call { uint8 kind; address target; address spendToken; address v2TokenOut; uint16 bps; bool useBalance; uint256 minBuy; uint256 amountOffset; uint256 minOffset; bytes data; }",
  "function swap(address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,address recipient,uint256 deadline,bool unwrapNative,Call[] calls,address[] sweep) payable returns (uint256)",
  "function feeBps() view returns (uint16)",
  "function paused() view returns (bool)",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function feeRecipient() view returns (address)",
  "function blazarFactory() view returns (address)",
  "function oracle() view returns (address)",
  "function v2FeeBps(address) view returns (uint16)",
  "function allowedTarget(address) view returns (bool)",
  "function MAX_FEE_BPS() view returns (uint16)",
  "function MAX_DEADLINE_WINDOW() view returns (uint256)",
]);

export const UNI_QUOTER = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160,uint32,uint256)",
]);
export const ALGEBRA_QUOTER = parseAbi(["function quoteExactInputSingle(address,address,uint256,uint160) returns (uint256,uint16)"]);
export const ALGEBRA4_QUOTER = parseAbi(["function quoteExactInputSingle(address,address,address,uint256,uint160) returns (uint256)"]);

export const UNI_ROUTER = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256)",
]);
export const ALGEBRA_ROUTER = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 limitSqrtPrice) params) payable returns (uint256)",
]);
export const ALGEBRA4_ROUTER = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,address deployer,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 limitSqrtPrice) params) payable returns (uint256)",
]);
