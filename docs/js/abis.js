window.BLAZAR_ABIS = {
  ERC20: [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 value) returns (bool)",
    "function transfer(address to, uint256 value) returns (bool)",
    "function mint(address to, uint256 amount)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "event Approval(address indexed owner, address indexed spender, uint256 value)"
  ],
  Factory: [
    "function feeTo() view returns (address)",
    "function feeToSetter() view returns (address)",
    "function baseToken() view returns (address)",
    "function getPair(address tokenA, address tokenB) view returns (address)",
    "function allPairs(uint256) view returns (address)",
    "function allPairsLength() view returns (uint256)",
    "function createPair(address tokenA, address tokenB) returns (address)",
    "event PairCreated(address indexed token0, address indexed token1, address pair, uint256 pairIndex)"
  ],
  Pair: [
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 value) returns (bool)",
    "function transfer(address to, uint256 value) returns (bool)",
    "function transferFrom(address from, address to, uint256 value) returns (bool)",
    "event Sync(uint112 reserve0, uint112 reserve1)",
    "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
    "event ProtocolFee(address indexed token, address indexed to, uint256 amount)"
  ],
  Router: [
    "function factory() view returns (address)",
    "function baseToken() view returns (address)",
    "function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)",
    "function addLiquidityBase(address token, uint256 amountTokenDesired, uint256 amountBaseDesired, uint256 amountTokenMin, uint256 amountBaseMin, address to, uint256 deadline) returns (uint256 amountToken, uint256 amountBase, uint256 liquidity)",
    "function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB)",
    "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
    "function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
    "function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) pure returns (uint256 amountB)",
    "function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) pure returns (uint256 amountOut)",
    "function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut) pure returns (uint256 amountIn)",
    "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
    "function getAmountsIn(uint256 amountOut, address[] path) view returns (uint256[] amounts)",
    "function getReserves(address tokenA, address tokenB) view returns (uint256 reserveA, uint256 reserveB)",
    "function pairFor(address tokenA, address tokenB) view returns (address)"
  ]
};
