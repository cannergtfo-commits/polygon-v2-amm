import {
  BZB,
  CHAIN_ID,
  FEE_ROUTER,
  HUBS,
  NATIVE,
  VENUES,
  REWARDS,
  STAKING,
  SWAP_TOPIC,
  WPOL,
  allV2,
  approvalPlan,
  bestV2,
  buildDayBoard,
  canonicalAsset,
  collectRoutes,
  coverageText,
  deadlineOk,
  enabledVenues,
  executionGate,
  feedFor,
  formatUnits,
  formatUsdE8,
  gasUnits,
  isNative,
  minBuy,
  parseUnits,
  poolToken,
  pricedExternal,
  quoteFresh,
  quoteStillTradable,
  rankRoutes,
  rewardState,
  routeLabel,
  sameAsset,
  scoreTrade,
  swapPlan,
  v3Tiers,
  wrapDirection,
  wrapTx,
  wrapperOnSpend,
} from "./desk-core.mjs?v=desk20";
import { POLYGON_TOKENS } from "./polygon-tokens.mjs?v=desk18";
import { POLYPUMP_LIST_URL, mergeTokenList } from "./token-lists.mjs?v=desk18";
import {
  ageLabel,
  bestChartPool,
  canonicalChartToken,
  chartCaption,
  emptyChartCopy,
  geckoEmbedUrl,
  geckoPoolUrl,
  geckoPoolsPath,
  geckoTokenUrl,
  liquidityLabel,
} from "./chart-pool.mjs?v=desk19";

const $ = (id) => document.getElementById(id);
const ethers = window.ethers;
const CFG = window.BLAZARSWAP;
const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11";
const POL_RESERVE = 5n * 10n ** 16n;
const coverage = coverageText();

const state = {
  account: null,
  chainId: null,
  injected: null,
  walletKind: null,
  busy: false,
  leaving: false,
  quote: null,
  quoteGen: 0,
  boardGen: 0,
  paintGen: 0,
  fillingDays: false,
  allow: null,
  routerPaused: false,
  stakePaused: false,
  board: null,
  claimDay: null,
  holdings: {
    account: null,
    bal: new Map(),
    usdE8: new Map(),
    at: 0,
    gen: 0,
    loading: false,
  },
};

const factoryIface = new ethers.Interface(["function getPair(address,address) view returns (address)"]);
const pairIface = new ethers.Interface([
  "function token0() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
]);
const uniQuoterIface = new ethers.Interface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)",
]);
const algebraQuoterIface = new ethers.Interface([
  "function quoteExactInputSingle(address,address,uint256,uint160) returns (uint256,uint16)",
]);
const uniRouterIface = new ethers.Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
]);
const algebraRouterIface = new ethers.Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 limitSqrtPrice)) payable returns (uint256)",
]);
const swapIface = new ethers.Interface([
  "function swap(address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,address recipient,uint256 deadline,bool unwrapNative,(uint8 kind,address target,address spendToken,address v2TokenOut,uint16 bps,bool useBalance,uint256 minBuy,uint256 amountOffset,uint256 minOffset,bytes data)[] calls,address[] sweep) payable returns (uint256 amountOut)",
  "function feeBps() view returns (uint16)",
  "function paused() view returns (bool)",
  "function blazarFactory() view returns (address)",
  "function v2FeeBps(address) view returns (uint16)",
  "function allowedTarget(address) view returns (bool)",
]);
const erc20Iface = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
]);
const stakeIface = new ethers.Interface([
  "function bzb() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function earned(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function rewardRate() view returns (uint256)",
  "function rewardsDuration() view returns (uint256)",
  "function periodFinish() view returns (uint256)",
  "function dailyRate() view returns (uint256)",
  "function paused() view returns (bool)",
  "function stake(uint256 amount)",
  "function withdraw(uint256 amount)",
  "function getReward()",
]);
const rewardIface = new ethers.Interface([
  "function dailyCap() view returns (uint256)",
  "function paused() view returns (bool)",
  "function claimable(uint256 dayId,address trader) view returns (uint256)",
  "function dayInfo(uint256 dayId) view returns (uint64 postedAt,uint64 deadline,uint256 total,uint256 claimedTotal,bool posted)",
  "function winner(uint256 dayId,uint256 index) view returns (address trader,uint256 amount)",
  "function claim(uint256 dayId) returns (uint256)",
]);
const feedIface = new ethers.Interface([
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function decimals() view returns (uint8)",
]);
const multiIface = new ethers.Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])",
  "function getEthBalance(address) view returns (uint256)",
]);
const swapEvent = new ethers.Interface([
  "event AggregatedSwap(address indexed trader,address indexed tokenIn,address indexed tokenOut,address recipient,uint256 amountIn,uint256 feeAmount,uint256 amountOut,uint256 usdE8,bool usdTrusted,uint16 feeBps,bytes32 routeId)",
]);

let readProvider = null;
let readUrl = "";

// Public Polygon RPCs cap JSON-RPC batches (1rpc is intermittent from ~10,
// dRPC free rejects more than 10). ethers v6 batches concurrent calls by
// default (up to 100). A batch that a relay rejects comes back as HTTP 403
// text, HTTP 429, or a single JSON-RPC error with id: null, which ethers
// surfaces as "missing response for request".
const RPC_OPTS = { staticNetwork: true, batchMaxCount: 1 };

function rpcUrls() {
  const list = CFG.rpcUrls && CFG.rpcUrls.length ? CFG.rpcUrls : [CFG.rpcUrl];
  return list.filter(Boolean);
}

function rpcFlaky(err) {
  if (!err) return false;
  if (err.code === "CALL_EXCEPTION" || err.code === "INSUFFICIENT_FUNDS" || err.code === "ACTION_REJECTED") return false;
  if (err.code === "BAD_DATA" || err.code === "SERVER_ERROR" || err.code === "TIMEOUT" || err.code === "NETWORK_ERROR") return true;
  const msg = String(err.shortMessage || err.message || "");
  return /missing response|bad response|too many requests|429|not allowed|paid subscription|rate limit|batch of more|unavailable|failed to detect network|ECONNRESET|ETIMEDOUT/i.test(msg);
}

function explainError(err) {
  const msg = String(err?.shortMessage || err?.reason || err?.message || err || "Request failed");
  if (err?.code === "CALL_EXCEPTION" || /execution reverted|revert/i.test(msg)) {
    const reason = err?.reason;
    if (reason) return `Simulation reverted: ${reason}`;
    return msg;
  }
  if (rpcFlaky(err) || /missing response for request/i.test(msg)) {
    return "The Polygon RPC dropped that request. Wait a moment and try again.";
  }
  return msg;
}

function dropReadProvider() {
  if (readProvider) {
    try { readProvider.destroy(); } catch { /* already closed */ }
  }
  readProvider = null;
  readUrl = "";
}

function log(id, message, kind) {
  const el = $(id);
  if (!el) return;
  el.textContent = message || "";
  el.className = "log" + (kind ? " " + kind : "");
}

function short(addr) {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "—";
}

function tokenByAddress(address) {
  return POLYGON_TOKENS.find((token) => token.address.toLowerCase() === String(address).toLowerCase()) || null;
}

function selected(id) {
  return tokenByAddress($(id).value);
}

function slipBps() {
  const raw = String($("slippage").value || "0.5").replace("%", "").trim();
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 50;
  return Math.round(n * 100);
}

function setStatus(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

async function provider() {
  if (readProvider) return readProvider;
  let last;
  for (const url of rpcUrls()) {
    try {
      const next = new ethers.JsonRpcProvider(url, CHAIN_ID, RPC_OPTS);
      await next.getBlockNumber();
      readProvider = next;
      readUrl = url;
      return next;
    } catch (err) {
      last = err;
    }
  }
  throw last || new Error("Polygon RPC is unavailable");
}

async function withReadProvider(run) {
  let last;
  const urls = rpcUrls();
  const ordered = readUrl ? [readUrl, ...urls.filter((url) => url !== readUrl)] : urls;
  for (const url of ordered) {
    try {
      if (!readProvider || readUrl !== url) {
        dropReadProvider();
        const next = new ethers.JsonRpcProvider(url, CHAIN_ID, RPC_OPTS);
        await next.getBlockNumber();
        readProvider = next;
        readUrl = url;
      }
      return await run(readProvider);
    } catch (err) {
      last = err;
      if (!rpcFlaky(err)) throw err;
      dropReadProvider();
    }
  }
  throw last || new Error("Polygon RPC is unavailable");
}

async function call(to, data, blockTag) {
  return withReadProvider((rpc) => {
    const tx = { to, data };
    if (blockTag !== undefined && blockTag !== null) tx.blockTag = blockTag;
    return rpc.call(tx);
  });
}

async function multicall(calls) {
  return withReadProvider(async (rpc) => {
    const data = multiIface.encodeFunctionData("aggregate3", [calls.map((item) => [item.to, true, item.data])]);
    const raw = await rpc.call({ to: MULTICALL, data });
    const [rows] = multiIface.decodeFunctionResult("aggregate3", raw);
    return rows.map((row) => ({ success: Boolean(row.success ?? row[0]), data: row.returnData ?? row[1] }));
  });
}

function word(data, offset) {
  const start = 2 + Number(offset) * 2;
  return BigInt(`0x${String(data).slice(start, start + 64)}`);
}

function encodeTarget(plan) {
  if (plan.args.sqrtPriceLimitX96 !== undefined) {
    const data = uniRouterIface.encodeFunctionData("exactInputSingle", [[
      plan.args.tokenIn,
      plan.args.tokenOut,
      plan.args.fee,
      plan.args.recipient,
      plan.args.amountIn,
      plan.args.amountOutMinimum,
      plan.args.sqrtPriceLimitX96,
    ]]);
    if (word(data, plan.amountOffset) !== 0n || word(data, plan.minOffset) !== plan.args.amountOutMinimum) {
      throw new Error("Router calldata offsets do not match the reviewed adapter");
    }
    return data;
  }
  const data = algebraRouterIface.encodeFunctionData("exactInputSingle", [[
    plan.args.tokenIn,
    plan.args.tokenOut,
    plan.args.recipient,
    plan.args.deadline,
    plan.args.amountIn,
    plan.args.amountOutMinimum,
    plan.args.limitSqrtPrice,
  ]]);
  if (word(data, plan.amountOffset) !== 0n || word(data, plan.minOffset) !== plan.args.amountOutMinimum) {
    throw new Error("Router calldata offsets do not match the reviewed adapter");
  }
  return data;
}

async function readAllowlist() {
  const rpc = await provider();
  const router = new ethers.Contract(FEE_ROUTER, swapIface.fragments, rpc);
  const [feeBps, paused, blazarFactory] = await Promise.all([router.feeBps(), router.paused(), router.blazarFactory()]);
  const v2FeeBps = {};
  const allowedTarget = {};
  await Promise.all(VENUES.v2.map(async (venue) => {
    v2FeeBps[venue.factory.toLowerCase()] = Number(await router.v2FeeBps(venue.factory));
  }));
  await Promise.all(VENUES.targets.map(async (venue) => {
    allowedTarget[venue.router.toLowerCase()] = await router.allowedTarget(venue.router);
  }));
  const code = await rpc.getCode(FEE_ROUTER);
  if (!code || code === "0x") throw new Error("Fee router has no code");
  state.routerPaused = paused;
  state.allow = { feeBps: Number(feeBps), paused, blazarFactory, v2FeeBps, allowedTarget, code };
  return state.allow;
}

function deskTokens() {
  const picked = ["tokenIn", "tokenOut"].map((id) => selected(id)?.address).filter(Boolean);
  return [...HUBS, WPOL, BZB, ...picked]
    .map((address) => poolToken(address))
    .filter((address, index, list) => list.findIndex((item) => item.toLowerCase() === address.toLowerCase()) === index);
}

async function loadPairs(venues) {
  const tokens = deskTokens();
  const queries = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      for (const venue of venues) {
        queries.push({ venue, a: tokens[i], b: tokens[j] });
      }
    }
  }
  const found = [];
  for (let i = 0; i < queries.length; i += 80) {
    const slice = queries.slice(i, i + 80);
    const rows = await multicall(slice.map((query) => ({
      to: query.venue.factory,
      data: factoryIface.encodeFunctionData("getPair", [query.a, query.b]),
    })));
    rows.forEach((row, index) => {
      if (!row.success || row.data === "0x") return;
      const pair = factoryIface.decodeFunctionResult("getPair", row.data)[0];
      if (pair && pair !== ethers.ZeroAddress) found.push({ ...slice[index], pair });
    });
  }
  const pairs = [];
  for (let i = 0; i < found.length; i += 40) {
    const slice = found.slice(i, i + 40);
    const rows = await multicall(slice.flatMap((row) => [
      { to: row.pair, data: pairIface.encodeFunctionData("token0", []) },
      { to: row.pair, data: pairIface.encodeFunctionData("getReserves", []) },
    ]));
    slice.forEach((row, index) => {
      const token0Row = rows[index * 2];
      const reserveRow = rows[index * 2 + 1];
      if (!token0Row?.success || !reserveRow?.success) return;
      const token0 = pairIface.decodeFunctionResult("token0", token0Row.data)[0];
      const reserves = pairIface.decodeFunctionResult("getReserves", reserveRow.data);
      const reserve0 = BigInt(reserves[0]);
      const reserve1 = BigInt(reserves[1]);
      if (reserve0 === 0n || reserve1 === 0n) return;
      pairs.push({
        factory: row.venue.factory,
        venue: row.venue.name,
        feeBps: row.venue.feeBps,
        pair: row.pair,
        tokenA: row.a,
        tokenB: row.b,
        token0,
        reserve0,
        reserve1,
      });
    });
  }
  return pairs;
}

async function quoteUni(target, tokenIn, tokenOut, amountIn, fee) {
  try {
    const data = uniQuoterIface.encodeFunctionData("quoteExactInputSingle", [[tokenIn, tokenOut, amountIn, fee, 0]]);
    const raw = await call(target.quoter, data);
    return BigInt(uniQuoterIface.decodeFunctionResult("quoteExactInputSingle", raw)[0]);
  } catch {
    return 0n;
  }
}

async function quoteAlgebra(target, tokenIn, tokenOut, amountIn) {
  try {
    const data = algebraQuoterIface.encodeFunctionData("quoteExactInputSingle", [tokenIn, tokenOut, amountIn, 0]);
    const raw = await call(target.quoter, data);
    return BigInt(algebraQuoterIface.decodeFunctionResult("quoteExactInputSingle", raw)[0]);
  } catch {
    return 0n;
  }
}

async function concentrated(targets, tokenIn, tokenOut, gross, unpaid, feeBps, useBalance) {
  const charged = wrapperOnSpend(gross, unpaid, true, feeBps);
  if (charged.net <= 0n) return [];
  const jobs = [];
  for (const target of targets) {
    if (target.kind === "v3") {
      for (const fee of v3Tiers(tokenIn, tokenOut)) {
        jobs.push((async () => {
          const quotedOut = await quoteUni(target, tokenIn, tokenOut, charged.net, fee);
          return pricedExternal({
            tokenIn, tokenOut, gross, unpaid, feeBps, quotedOut,
            venue: target.name, router: target.router, kind: "v3", feeTier: fee, useBalance,
          });
        })());
      }
    } else if (target.kind === "algebra") {
      jobs.push((async () => {
        const quotedOut = await quoteAlgebra(target, tokenIn, tokenOut, charged.net);
        return pricedExternal({
          tokenIn, tokenOut, gross, unpaid, feeBps, quotedOut,
          venue: target.name, router: target.router, kind: "algebra", useBalance,
        });
      })());
    }
  }
  const rows = await Promise.all(jobs);
  return rows.filter(Boolean);
}

async function buildQuote(amountIn) {
  const sell = selected("tokenIn");
  const buy = selected("tokenOut");
  if (!sell || !buy) throw new Error("Choose tokens");
  const direction = wrapDirection(sell.address, buy.address);
  if (direction) {
    return {
      at: Date.now(),
      blockTime: Math.floor(Date.now() / 1000),
      sell,
      buy,
      amountIn,
      amountOut: amountIn,
      best: null,
      wrap: direction,
      gasPrice: 0n,
      gasPriced: false,
      venues: { v2: [], targets: [] },
      feeBps: 0,
    };
  }
  const allow = state.allow || await readAllowlist();
  const venues = enabledVenues(allow);
  if (!venues.v2.length && !venues.targets.length) throw new Error("The fee router allowlist is empty");
  if (sameAsset(sell.address, buy.address)) throw new Error("Choose two different tokens. POL and WPOL wrap to the same asset.");
  const sellPool = poolToken(sell.address);
  const buyPool = poolToken(buy.address);
  const pairs = await loadPairs(venues.v2);
  const hubs = HUBS.filter((hub) => !sameAsset(hub, sellPool) && !sameAsset(hub, buyPool));
  const directV3 = await concentrated(venues.targets, sellPool, buyPool, amountIn, amountIn, allow.feeBps, false);
  const mixed = [];
  const hub = WPOL;
  if (!sameAsset(sellPool, hub) && !sameAsset(buyPool, hub)) {
    const first = bestV2(pairs, sellPool, hub, amountIn, allow.feeBps, amountIn, allow.blazarFactory, venues.v2);
    if (first) {
      const next = await concentrated(venues.targets, hub, buyPool, first.amountOut, first.unpaidOut, allow.feeBps, true);
      for (const route of next) mixed.push({ amountOut: route.amountOut, steps: [first.step, route.steps[0]] });
    }
    const into = await concentrated(venues.targets, sellPool, hub, amountIn, amountIn, allow.feeBps, false);
    for (const route of into) {
      const second = bestV2(pairs, hub, buyPool, route.amountOut, allow.feeBps, 0n, allow.blazarFactory, venues.v2);
      if (second) mixed.push({ amountOut: second.amountOut, steps: [route.steps[0], { ...second.step, useBalance: true }] });
    }
  }
  const routes = collectRoutes({
    pairs,
    tokenIn: sell.address,
    tokenOut: buy.address,
    hubs,
    amountIn,
    feeBps: allow.feeBps,
    blazarFactory: allow.blazarFactory,
    venues: venues.v2,
    concentrated: [...directV3, ...mixed],
  });
  const rpc = await provider();
  const feeData = await rpc.getFeeData();
  const gasPrice = BigInt(feeData.gasPrice || 0n);
  let outputPerPol = null;
  if (sameAsset(buy.address, WPOL)) outputPerPol = 10n ** 18n;
  else {
    const polOut = bestV2(pairs, WPOL, buyPool, 10n ** 18n, 0, 0n, allow.blazarFactory, venues.v2);
    if (polOut) outputPerPol = polOut.amountOut;
  }
  const ranked = rankRoutes(routes, { gasPrice, outputPerPol });
  const best = ranked[0] || null;
  const block = await rpc.getBlock("latest");
  return {
    at: Date.now(),
    blockTime: Number(block.timestamp),
    sell,
    buy,
    amountIn,
    best,
    gasPrice,
    gasPriced: outputPerPol !== null,
    venues,
    feeBps: allow.feeBps,
  };
}

function clearQuote(message) {
  $("amountOut").value = "";
  $("routeLabel").textContent = message || "—";
  $("minOutLabel").textContent = "—";
  $("feeLabel").textContent = "—";
  $("gasLabel").textContent = "—";
}

function paintQuote(quote) {
  if (quote?.wrap) {
    const unwrapping = quote.wrap === "unwrap";
    $("amountOut").value = formatUnits(quote.amountOut, quote.buy.decimals, 6);
    $("routeLabel").textContent = unwrapping ? "Unwrap WPOL" : "Wrap POL";
    $("minOutLabel").textContent = formatUnits(quote.amountOut, quote.buy.decimals, 6);
    $("feeLabel").textContent = "None. 1:1";
    $("gasLabel").textContent = "WPOL contract";
    $("routeDetail").textContent = unwrapping
      ? "WPOL unwraps to POL 1:1. No pool and no fee."
      : "POL wraps to WPOL 1:1. No pool and no fee.";
    return;
  }
  if (!quote?.best) {
    const pair = quote?.sell && quote?.buy ? `${quote.sell.symbol} → ${quote.buy.symbol}` : "this pair";
    clearQuote(`No pool for ${pair}`);
    $("routeDetail").textContent = `No ${pair} route on Blazar, QuickSwap, Sushi, Ape, Uniswap v3, or QuickSwap v3. ${coverage.discovery} ${coverage.notCovered}`;
    return;
  }
  const steps = quote.best.steps;
  const out = steps.every((step) => !step.useBalance) && steps.length > 1
    ? steps.reduce((sum, step) => sum + step.quotedOut, 0n)
    : steps[steps.length - 1].quotedOut;
  const slip = slipBps();
  $("amountOut").value = formatUnits(out, quote.buy.decimals, 6);
  $("routeLabel").textContent = routeLabel(steps);
  $("minOutLabel").textContent = formatUnits(minBuy(out, slip), quote.buy.decimals, 6);
  const fee = steps.reduce((sum, step) => sum + step.wrapperFee, 0n);
  $("feeLabel").textContent = fee === 0n ? "No wrapper fee" : `${formatUnits(fee, quote.sell.decimals, 6)} ${quote.sell.symbol}`;
  const gas = quote.best.gasCost;
  $("gasLabel").textContent = gas === null
    ? `${gasUnits(steps).toLocaleString()} gas, not priced into the rank`
    : `about ${formatUnits(gas, quote.buy.decimals, 4)} ${quote.buy.symbol}`;
  const names = quote.venues.v2.map((venue) => venue.name).concat(quote.venues.targets.map((venue) => venue.name));
  $("routeDetail").textContent = `Searched ${names.join(", ")}. Wrapper fee ${quote.feeBps / 100}%. ${coverage.discovery} ${coverage.notCovered}`;
}

async function refreshQuote() {
  const gen = ++state.quoteGen;
  const raw = $("amountIn").value.trim();
  if (!raw) {
    state.quote = null;
    clearQuote("—");
    setStatus("swapStatus", "Enter an amount. Quotes stay on allowlisted pools.");
    return;
  }
  let amountIn;
  try {
    amountIn = parseUnits(raw, selected("tokenIn").decimals);
  } catch (err) {
    state.quote = null;
    log("swapLog", err.message || "Bad amount", "err");
    return;
  }
  setStatus("swapStatus", "Quoting allowlisted pools…");
  try {
    const quote = await buildQuote(amountIn);
    if (gen !== state.quoteGen) return;
    state.quote = quote;
    paintQuote(quote);
    setStatus("swapStatus", quote.wrap
      ? "1:1. Swap sends the wrap or unwrap directly."
      : quote.best
        ? "Quote is live for 20 seconds. Swap asks the wallet only after a simulation."
        : `No ${quote.sell.symbol} → ${quote.buy.symbol} pool on Blazar, QuickSwap, Sushi, Ape, Uniswap v3, or QuickSwap v3.`);
    log("swapLog", "");
  } catch (err) {
    if (gen !== state.quoteGen) return;
    state.quote = null;
    paintQuote(null);
    setStatus("swapStatus", "Quote failed.");
    log("swapLog", explainError(err) || "Quote failed", "err");
  }
}

let quoteTimer = 0;
function scheduleQuote() {
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(() => { refreshQuote().catch(() => {}); }, 250);
}

async function balanceOf(token, account) {
  const rpc = await provider();
  if (!account) return null;
  if (isNative(token.address)) return rpc.getBalance(account);
  const data = erc20Iface.encodeFunctionData("balanceOf", [account]);
  const raw = await rpc.call({ to: poolToken(token.address), data });
  return BigInt(erc20Iface.decodeFunctionResult("balanceOf", raw)[0]);
}

async function paintBalances() {
  if (!state.account) {
    $("balIn").textContent = "Balance —";
    $("balOut").textContent = "Balance —";
    return;
  }
  try {
    const [a, b] = await Promise.all([balanceOf(selected("tokenIn"), state.account), balanceOf(selected("tokenOut"), state.account)]);
    $("balIn").textContent = `Balance ${formatUnits(a, selected("tokenIn").decimals, 4)}`;
    $("balOut").textContent = `Balance ${formatUnits(b, selected("tokenOut").decimals, 4)}`;
  } catch {
    $("balIn").textContent = "Balance —";
    $("balOut").textContent = "Balance —";
  }
}

const pickerRefreshers = new Set();
function notifyPickers() {
  for (const refresh of pickerRefreshers) {
    try { refresh(); } catch { /* picker unmounted */ }
  }
}

function clearHoldings() {
  state.holdings.account = null;
  state.holdings.bal = new Map();
  state.holdings.usdE8 = new Map();
  state.holdings.at = 0;
  notifyPickers();
}

/** Compact token amount for the picker (1.23K, 0.0042). */
function compactBal(amount, decimals) {
  if (amount === null || amount === undefined) return "";
  const raw = BigInt(amount);
  if (raw === 0n) return "0";
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = abs % scale;
  let human;
  if (whole >= 1_000_000_000_000n) {
    const n = Number(whole) / 1e12;
    human = `${n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)}T`;
  } else if (whole >= 1_000_000_000n) {
    const n = Number(whole) / 1e9;
    human = `${n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)}B`;
  } else if (whole >= 1_000_000n) {
    const n = Number(whole) / 1e6;
    human = `${n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)}M`;
  } else if (whole >= 1_000n) {
    const n = Number(whole) / 1e3;
    human = `${n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)}K`;
  } else if (whole >= 1n) {
    const n = Number(whole) + Number(frac * 10000n / scale) / 10000;
    human = (n >= 100 ? n.toFixed(2) : n >= 10 ? n.toFixed(3) : n.toFixed(4)).replace(/\.?0+$/, "");
  } else {
    let s = formatUnits(abs, decimals, 8);
    if (s.includes(".")) {
      const [a, b = ""] = s.split(".");
      let cut = b.replace(/0+$/, "");
      if (cut.length > 4) cut = cut.slice(0, 4);
      s = cut ? `${a}.${cut}` : a;
    }
    // Dust below four decimals still counts as held; show a compact marker.
    if (s === "0" || /^0\.0*$/.test(s)) human = "<0.0001";
    else human = s;
  }
  return (neg ? "-" : "") + human;
}

function tokenKey(address) {
  return String(address || "").toLowerCase();
}

function holdingOf(token) {
  const key = tokenKey(isNative(token.address) ? NATIVE : token.address);
  const bal = state.holdings.bal.get(key);
  if (bal === undefined) return { bal: null, usdE8: null, known: false };
  const has = state.holdings.usdE8.has(key);
  return { bal, usdE8: has ? state.holdings.usdE8.get(key) : null, known: has };
}

function sortedPickerTokens() {
  if (!state.account || state.holdings.account !== state.account) return POLYGON_TOKENS.slice();
  const ranked = POLYGON_TOKENS.map((token, index) => {
    const hold = holdingOf(token);
    const bal = hold.bal || 0n;
    let tier = 2;
    let value = 0n;
    if (bal > 0n) {
      if (hold.known && hold.usdE8 > 0n) {
        tier = 0;
        value = hold.usdE8;
      } else {
        tier = 1; // held, unknown or zero value — still above zero-balance
      }
    }
    return { token, index, tier, value };
  });
  ranked.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.tier === 0 && a.value !== b.value) return a.value > b.value ? -1 : 1;
    return a.index - b.index;
  });
  return ranked.map((row) => row.token);
}

async function multicallChunked(calls, size = 80) {
  const out = [];
  for (let i = 0; i < calls.length; i += size) {
    const rows = await multicall(calls.slice(i, i + size));
    out.push(...rows);
  }
  return out;
}

function usdE8FromAnswer(amount, tokenDecimals, answer, priceDecimals = 8) {
  if (amount <= 0n || answer <= 0n) return 0n;
  const scale = BigInt(priceDecimals) + BigInt(tokenDecimals);
  if (scale >= 8n) return (answer * amount) / 10n ** (scale - 8n);
  return answer * amount * 10n ** (8n - scale);
}

function quoteViaReserves(amount, token, token0, reserve0, reserve1) {
  if (amount <= 0n || reserve0 <= 0n || reserve1 <= 0n) return 0n;
  const is0 = tokenKey(token) === tokenKey(token0);
  const reserveIn = is0 ? reserve0 : reserve1;
  const reserveOut = is0 ? reserve1 : reserve0;
  if (reserveIn <= 0n) return 0n;
  return (amount * reserveOut) / reserveIn;
}

/**
 * Load wallet balances for every picker token (Multicall3 + getEthBalance) and
 * approximate USD value via Chainlink feeds or V2 reserves vs WPOL/USDC.
 * Never blocks the menu: callers fire-and-forget; open menus re-render on notify.
 */
async function refreshHoldings({ force = false } = {}) {
  const account = state.account;
  if (!account) {
    clearHoldings();
    return;
  }
  if (state.holdings.loading && !force) return;
  const fresh = state.holdings.account === account && Date.now() - state.holdings.at < 30_000;
  if (!force && fresh) return;
  const gen = ++state.holdings.gen;
  state.holdings.loading = true;
  try {
    const tokens = POLYGON_TOKENS.slice();
    const balCalls = tokens.map((token) => {
      if (isNative(token.address)) {
        return { to: MULTICALL, data: multiIface.encodeFunctionData("getEthBalance", [account]) };
      }
      return { to: poolToken(token.address), data: erc20Iface.encodeFunctionData("balanceOf", [account]) };
    });
    const balRows = await multicallChunked(balCalls);
    if (gen !== state.holdings.gen || state.account !== account) return;
    const bal = new Map();
    tokens.forEach((token, i) => {
      const row = balRows[i];
      let amount = 0n;
      if (row?.success && row.data && row.data !== "0x") {
        try {
          amount = isNative(token.address)
            ? BigInt(multiIface.decodeFunctionResult("getEthBalance", row.data)[0])
            : BigInt(erc20Iface.decodeFunctionResult("balanceOf", row.data)[0]);
        } catch { amount = 0n; }
      }
      bal.set(tokenKey(isNative(token.address) ? NATIVE : token.address), amount);
    });

    // Unit prices in USD e8 for 1 whole token (10^decimals raw).
    const unitUsd = new Map();
    const feedTokens = [
      { key: tokenKey(WPOL), address: WPOL, decimals: 18 },
      { key: tokenKey("0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"), address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
      { key: tokenKey("0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6"), address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", decimals: 8 },
      { key: tokenKey("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"), address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
      { key: tokenKey("0xc2132D05D31c914a87C6611C10748AEb04B58e8F"), address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },
    ];
    const feedCalls = feedTokens.map((item) => {
      const feed = feedFor(item.address);
      return { to: feed.aggregator, data: feedIface.encodeFunctionData("latestRoundData", []) };
    });
    const feedRows = await multicall(feedCalls);
    if (gen !== state.holdings.gen || state.account !== account) return;
    feedTokens.forEach((item, i) => {
      const feed = feedFor(item.address);
      const row = feedRows[i];
      if (!row?.success || !row.data || row.data === "0x") return;
      try {
        const decoded = feedIface.decodeFunctionResult("latestRoundData", row.data);
        const answer = BigInt(decoded[1]);
        if (answer > 0n) {
          // USD e8 for one whole token
          const one = 10n ** BigInt(item.decimals);
          unitUsd.set(item.key, usdE8FromAnswer(one, item.decimals, answer, feed.priceDecimals));
        }
      } catch { /* skip */ }
    });
    // POL shares WPOL; bridged USDC ~ native USDC.
    if (unitUsd.has(tokenKey(WPOL))) unitUsd.set(tokenKey(NATIVE), unitUsd.get(tokenKey(WPOL)));
    const usdcKey = tokenKey("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359");
    if (unitUsd.has(usdcKey)) unitUsd.set(tokenKey("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"), unitUsd.get(usdcKey));

    const held = tokens.filter((token) => (bal.get(tokenKey(isNative(token.address) ? NATIVE : token.address)) || 0n) > 0n);
    const needPair = held.filter((token) => {
      const key = tokenKey(isNative(token.address) ? NATIVE : poolToken(token.address));
      return !unitUsd.has(tokenKey(isNative(token.address) ? NATIVE : token.address)) && !unitUsd.has(key);
    });

    const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
    const factories = [VENUES.v2[0].factory, VENUES.v2[1].factory]; // Blazar, QuickSwap
    const pairQueries = [];
    for (const token of needPair) {
      const asset = poolToken(token.address);
      for (const factory of factories) {
        pairQueries.push({ token, asset, factory, quote: WPOL });
        pairQueries.push({ token, asset, factory, quote: USDC });
      }
    }
    if (pairQueries.length) {
      const pairRows = await multicallChunked(pairQueries.map((q) => ({
        to: q.factory,
        data: factoryIface.encodeFunctionData("getPair", [q.asset, q.quote]),
      })));
      if (gen !== state.holdings.gen || state.account !== account) return;
      const reserveJobs = [];
      pairQueries.forEach((q, i) => {
        const row = pairRows[i];
        if (!row?.success || !row.data || row.data === "0x") return;
        let pair;
        try { pair = factoryIface.decodeFunctionResult("getPair", row.data)[0]; } catch { return; }
        if (!pair || pair === ethers.ZeroAddress) return;
        reserveJobs.push({ ...q, pair });
      });
      if (reserveJobs.length) {
        const detail = await multicallChunked(reserveJobs.flatMap((job) => [
          { to: job.pair, data: pairIface.encodeFunctionData("token0", []) },
          { to: job.pair, data: pairIface.encodeFunctionData("getReserves", []) },
        ]));
        if (gen !== state.holdings.gen || state.account !== account) return;
        for (let i = 0; i < reserveJobs.length; i++) {
          const job = reserveJobs[i];
          const t0row = detail[i * 2];
          const rrow = detail[i * 2 + 1];
          if (!t0row?.success || !rrow?.success) continue;
          let token0, reserves;
          try {
            token0 = pairIface.decodeFunctionResult("token0", t0row.data)[0];
            reserves = pairIface.decodeFunctionResult("getReserves", rrow.data);
          } catch { continue; }
          const reserve0 = BigInt(reserves[0]);
          const reserve1 = BigInt(reserves[1]);
          // Skip empty / dust pools
          if (reserve0 === 0n || reserve1 === 0n) continue;
          const one = 10n ** BigInt(job.token.decimals);
          const quoteOut = quoteViaReserves(one, job.asset, token0, reserve0, reserve1);
          if (quoteOut <= 0n) continue;
          const quoteKey = tokenKey(job.quote);
          const quoteUnit = unitUsd.get(quoteKey);
          if (!quoteUnit) continue;
          const quoteDecimals = job.quote === WPOL ? 18 : 6;
          // quoteOut is raw quote wei for one whole token; convert to USD e8
          const usd = (quoteOut * quoteUnit) / (10n ** BigInt(quoteDecimals));
          if (usd <= 0n) continue;
          const key = tokenKey(isNative(job.token.address) ? NATIVE : job.token.address);
          const prev = unitUsd.get(key) || 0n;
          // Prefer the deeper-looking quote (higher implied unit value from larger pool is fine; take max of sensible)
          if (usd > prev) unitUsd.set(key, usd);
        }
      }
    }

    const usdE8 = new Map();
    for (const token of tokens) {
      const key = tokenKey(isNative(token.address) ? NATIVE : token.address);
      const amount = bal.get(key) || 0n;
      const unitKey = key;
      const poolKey = tokenKey(poolToken(token.address));
      const unit = unitUsd.get(unitKey) ?? unitUsd.get(poolKey);
      if (unit === undefined) continue; // unknown — omit from map
      const one = 10n ** BigInt(token.decimals);
      usdE8.set(key, amount <= 0n ? 0n : (amount * unit) / one);
    }

    if (gen !== state.holdings.gen || state.account !== account) return;
    state.holdings.account = account;
    state.holdings.bal = bal;
    state.holdings.usdE8 = usdE8;
    state.holdings.at = Date.now();
    notifyPickers();
  } catch {
    // Keep prior cache; menu still works without values.
  } finally {
    if (gen === state.holdings.gen) state.holdings.loading = false;
  }
}

function rejected(err) {
  return err?.code === 4001 || err?.code === "ACTION_REJECTED" || /rejected|denied/i.test(String(err?.message || err?.shortMessage || ""));
}

async function assertChain() {
  const hex = await state.injected.request({ method: "eth_chainId" });
  state.chainId = parseInt(hex, 16);
  if (state.chainId === CHAIN_ID) return;
  await state.injected.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x89" }] });
  state.chainId = CHAIN_ID;
}

async function simulate(tx) {
  await withReadProvider((rpc) => rpc.call({ to: tx.to, from: state.account, data: tx.data, value: tx.value || 0n }));
}

async function send(tx, label) {
  const signer = await new ethers.BrowserProvider(state.injected).getSigner();
  let response;
  try {
    response = await signer.sendTransaction(tx);
  } catch (err) {
    if (rejected(err)) throw new Error("Wallet rejected the request.");
    throw err;
  }
  log(label, `Submitted ${short(response.hash)}`, "");
  const receipt = await response.wait();
  if (!receipt || receipt.status !== 1) throw new Error("Transaction failed");
  return receipt;
}

async function ensureAllowance(token, spender, amount, label) {
  if (isNative(token.address)) return;
  const data = erc20Iface.encodeFunctionData("allowance", [state.account, spender]);
  const current = BigInt(erc20Iface.decodeFunctionResult("allowance", await call(token.address, data))[0]);
  const steps = approvalPlan(current, amount);
  for (const step of steps) {
    const approve = erc20Iface.encodeFunctionData("approve", [spender, step]);
    const tx = { to: token.address, data: approve, value: 0n };
    const code = await withReadProvider((rpc) => rpc.getCode(token.address));
    const gate = executionGate({ chainId: state.chainId, code, paused: false, simulationOk: true, quoteFresh: true, stale: false, walletReject: false, action: "approve" });
    if (!gate.ok) throw new Error(gate.errors[0]);
    await simulate(tx);
    await send(tx, label);
  }
}

async function doSwap() {
  if (!state.account) {
    $("connectBtn").click();
    return;
  }
  if (state.busy) return;
  state.busy = true;
  $("swapBtn").disabled = true;
  try {
    await assertChain();
    const sellNow = selected("tokenIn");
    const buyNow = selected("tokenOut");
    const wrapping = wrapDirection(sellNow?.address, buyNow?.address);
    if (wrapping) {
      const amount = parseUnits($("amountIn").value.trim(), sellNow.decimals);
      const tx = wrapTx(sellNow.address, buyNow.address, amount);
      const rpc = await provider();
      const code = await rpc.getCode(WPOL);
      if (!code || code === "0x") throw new Error("WPOL contract has no code.");
      try {
        await simulate(tx);
      } catch (err) {
        throw new Error(err.shortMessage || "Simulation failed. Nothing was sent.");
      }
      const receipt = await send(tx, "swapLog");
      log("swapLog", `${wrapping === "unwrap" ? "Unwrapped" : "Wrapped"} in block ${receipt.blockNumber}.`, "ok");
      state.quote = null;
      await paintBalances();
      refreshHoldings({ force: true }).catch(() => {});
      scheduleQuote();
      return;
    }
    let quote = state.quote;
    if (!quote?.best || !quoteFresh(quote.at, Date.now())) {
      await refreshQuote();
      const next = state.quote;
      if (quote?.best && next?.best && !quoteStillTradable(quote.best.amountOut, next.best.amountOut, slipBps())) {
        throw new Error("The pool moved past your slippage. The old quote will not be sent.");
      }
      quote = next;
    }
    if (!quote?.best) {
      const sell = quote?.sell?.symbol || selected("tokenIn")?.symbol || "token";
      const buy = quote?.buy?.symbol || selected("tokenOut")?.symbol || "token";
      throw new Error(`No ${sell} → ${buy} pool on Blazar, QuickSwap, Sushi, Ape, Uniswap v3, or QuickSwap v3.`);
    }
    const rpc = await provider();
    const code = await rpc.getCode(FEE_ROUTER);
    const gate = executionGate({
      chainId: state.chainId,
      code,
      paused: state.routerPaused,
      simulationOk: true,
      quoteFresh: quoteFresh(quote.at, Date.now()),
      stale: false,
      walletReject: false,
      action: "swap",
    });
    if (!gate.ok) throw new Error(gate.errors[0]);
    const block = await rpc.getBlock("latest");
    const plan = swapPlan({
      tokenIn: quote.sell.address,
      tokenOut: quote.buy.address,
      amountIn: quote.amountIn,
      steps: quote.best.steps,
      recipient: state.account,
      blockTime: Number(block.timestamp),
      slippageBps: slipBps(),
    });
    if (!deadlineOk(plan.deadline, Number(block.timestamp))) throw new Error("Deadline is outside the router window");
    const calls = plan.calls.map((call) => ({
      kind: call.kind,
      target: call.target,
      spendToken: call.spendToken,
      v2TokenOut: call.v2TokenOut,
      bps: call.bps,
      useBalance: call.useBalance,
      minBuy: call.minBuy,
      amountOffset: call.amountOffset,
      minOffset: call.minOffset,
      data: call.plan ? encodeTarget(call.plan) : "0x",
    }));
    await ensureAllowance(quote.sell, FEE_ROUTER, quote.amountIn, "swapLog");
    if (!quoteFresh(quote.at, Date.now())) {
      const previous = quote.best.amountOut;
      await refreshQuote();
      if (!state.quote?.best || !quoteStillTradable(previous, state.quote.best.amountOut, slipBps())) {
        throw new Error("The pool moved past your slippage. The old quote will not be sent.");
      }
      quote = state.quote;
    }
    const freshBlock = await rpc.getBlock("latest");
    const livePlan = swapPlan({
      tokenIn: quote.sell.address,
      tokenOut: quote.buy.address,
      amountIn: quote.amountIn,
      steps: quote.best.steps,
      recipient: state.account,
      blockTime: Number(freshBlock.timestamp),
      slippageBps: slipBps(),
    });
    const liveCalls = livePlan.calls.map((item) => ({
      kind: item.kind,
      target: item.target,
      spendToken: item.spendToken,
      v2TokenOut: item.v2TokenOut,
      bps: item.bps,
      useBalance: item.useBalance,
      minBuy: item.minBuy,
      amountOffset: item.amountOffset,
      minOffset: item.minOffset,
      data: item.plan ? encodeTarget(item.plan) : "0x",
    }));
    const data = swapIface.encodeFunctionData("swap", [
      livePlan.tokenIn,
      livePlan.tokenOut,
      livePlan.amountIn,
      livePlan.minAmountOut,
      livePlan.recipient,
      livePlan.deadline,
      livePlan.unwrapNative,
      liveCalls,
      livePlan.sweep,
    ]);
    const tx = { to: FEE_ROUTER, data, value: livePlan.value };
    try {
      await simulate(tx);
    } catch (err) {
      throw new Error(err.shortMessage || "Simulation failed. Nothing was sent.");
    }
    const receipt = await send(tx, "swapLog");
    log("swapLog", `Swapped in block ${receipt.blockNumber}.`, "ok");
    state.quote = null;
    await paintBalances();
    refreshHoldings({ force: true }).catch(() => {});
    scheduleQuote();
  } catch (err) {
    log("swapLog", explainError(err) || "Swap failed", "err");
  } finally {
    state.busy = false;
    $("swapBtn").disabled = false;
  }
}

function syncTokenButton(select) {
  const token = tokenByAddress(select.value);
  const button = select.parentElement?.querySelector(".tok-btn");
  if (!button || !token) return;
  const img = button.querySelector("img");
  img.src = token.logo || "";
  img.alt = "";
  img.hidden = !token.logo;
  button.querySelector("b").textContent = token.symbol;
}

function dressTokenSelect(select) {
  if (select.dataset.dressed === "1") {
    syncTokenButton(select);
    return;
  }
  select.dataset.dressed = "1";
  const wrap = document.createElement("div");
  wrap.className = "tok-pick";
  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);
  select.classList.add("tok-native");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tok-btn";
  button.setAttribute("aria-haspopup", "listbox");
  const img = document.createElement("img");
  img.alt = "";
  const label = document.createElement("b");
  const caret = document.createElement("span");
  caret.textContent = "▾";
  button.append(img, label, caret);
  const menu = document.createElement("div");
  menu.className = "tok-menu";
  menu.hidden = true;
  const search = document.createElement("input");
  search.type = "search";
  search.className = "tok-search";
  search.placeholder = "Search Polygon tokens";
  search.setAttribute("aria-label", "Search tokens");
  const list = document.createElement("div");
  list.className = "tok-list";
  menu.append(search, list);
  wrap.insertBefore(button, select);
  wrap.appendChild(menu);
  const render = () => {
    const query = search.value.trim().toLowerCase();
    list.replaceChildren();
    for (const token of sortedPickerTokens()) {
      const hay = `${token.symbol} ${token.name} ${token.address}`.toLowerCase();
      if (query && !hay.includes(query)) continue;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "tok-row";
      const icon = document.createElement("img");
      icon.alt = "";
      icon.src = token.logo || "";
      icon.hidden = !token.logo;
      icon.addEventListener("error", () => { icon.hidden = true; });
      const text = document.createElement("span");
      text.className = "tok-meta";
      const name = document.createElement("b");
      name.textContent = token.symbol;
      const sub = document.createElement("small");
      sub.textContent = token.source
        ? `${token.name} · ${token.source}${token.unverified ? " · unverified" : ""}${token.quoteAsset ? ` · ${token.quoteAsset} pair` : ""}${token.thinPool ? " · graduated (BZB), thin pool" : ""}`
        : token.name;
      if (token.unverified) {
        row.title = `Unverified launchpad token. Anyone can launch any name; check the address ${token.address}.${token.thinPool ? " Graduated into a small TOKEN/BZB pool (about 10k BZB): expect large price impact." : ""}`;
        sub.style.color = "#f0b429";
      }
      text.append(name, sub);
      row.append(icon, text);
      if (state.account) {
        const hold = holdingOf(token);
        const balEl = document.createElement("span");
        balEl.className = "tok-bal";
        if (hold.bal === null) {
          balEl.textContent = state.holdings.loading ? "…" : "";
        } else {
          balEl.textContent = compactBal(hold.bal, token.decimals);
        }
        row.appendChild(balEl);
      }
      row.addEventListener("click", () => {
        const key = token.address.toLowerCase();
        if (![...select.options].some((opt) => opt.value.toLowerCase() === key)) {
          const option = document.createElement("option");
          option.value = token.address;
          option.textContent = token.unverified ? `${token.symbol} (unverified)` : token.symbol;
          select.appendChild(option);
        }
        select.value = token.address;
        menu.hidden = true;
        syncTokenButton(select);
        select.dispatchEvent(new Event("change"));
      });
      list.appendChild(row);
    }
  };
  const onHoldings = () => { if (!menu.hidden) render(); };
  pickerRefreshers.add(onHoldings);
  button.addEventListener("click", () => {
    menu.hidden = !menu.hidden;
    if (!menu.hidden) {
      search.value = "";
      render();
      search.focus();
      // Kick a soft refresh; do not await — menu stays interactive.
      if (state.account) refreshHoldings().catch(() => {});
    }
  });
  search.addEventListener("input", render);
  search.addEventListener("click", (event) => event.stopPropagation());
  select.addEventListener("change", () => syncTokenButton(select));
  document.addEventListener("click", (event) => {
    if (!wrap.contains(event.target)) menu.hidden = true;
  });
  img.addEventListener("error", () => { img.hidden = true; });
  syncTokenButton(select);
}

/** Merge graduated PolyPump tokens (launch.blazarforce.net/tokenlist.json) into the picker. */
async function loadRemoteLists() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(POLYPUMP_LIST_URL, { signal: controller.signal, cache: "no-cache" });
    if (!response.ok) return;
    const added = mergeTokenList(POLYGON_TOKENS, await response.json(), "PolyPump");
    // Swap and liquidity share the same remote list. Options must exist on every
    // dressed <select> or the custom picker click (select.value = address) is a no-op.
    for (const id of ["tokenIn", "tokenOut", "liqA", "liqB"]) {
      const select = $(id);
      for (const token of added) {
        const option = document.createElement("option");
        option.value = token.address;
        option.textContent = token.unverified ? `${token.symbol} (unverified)` : token.symbol;
        select.appendChild(option);
      }
    }
  } catch {
    // The launchpad list is optional; the built-in list keeps working without it.
  } finally {
    clearTimeout(timer);
  }
}

function fillSelect(id, prefer) {
  const select = $(id);
  select.replaceChildren();
  for (const token of POLYGON_TOKENS) {
    const option = document.createElement("option");
    option.value = token.address;
    option.textContent = token.symbol;
    select.appendChild(option);
  }
  if (prefer) select.value = prefer;
  dressTokenSelect(select);
}

function approxApr(daily, supply) {
  if (daily <= 0n || supply <= 0n) return "—";
  const day = Number((daily * 1_000_000n) / supply) / 1_000_000;
  const apr = day * 365 * 100;
  if (!Number.isFinite(apr) || apr <= 0) return "—";
  if (apr >= 1000) return `${Math.round(apr).toLocaleString()}%`;
  if (apr >= 10) return `${apr.toFixed(1)}%`;
  return `${apr.toFixed(2)}%`;
}

async function loadStake() {
  try {
    const rpc = await provider();
    const stake = new ethers.Contract(STAKING, stakeIface.fragments, rpc);
    const bzb = await stake.bzb();
    if (bzb.toLowerCase() !== BZB.toLowerCase()) throw new Error("Staking token is not BZB");
    const code = await rpc.getCode(STAKING);
    if (!code || code === "0x") throw new Error("Staking contract has no code");
    const account = state.account || ethers.ZeroAddress;
    const [staked, earned, daily, duration, finish, paused, wallet, supply] = await Promise.all([
      state.account ? stake.balanceOf(account) : 0n,
      state.account ? stake.earned(account) : 0n,
      stake.dailyRate(),
      stake.rewardsDuration(),
      stake.periodFinish(),
      stake.paused(),
      state.account ? balanceOf(tokenByAddress(BZB), state.account) : null,
      stake.totalSupply(),
    ]);
    state.stakePaused = paused;
    $("stakeWallet").textContent = wallet === null ? "Connect" : formatUnits(wallet, 18, 4);
    $("stakeStaked").textContent = state.account ? formatUnits(staked, 18, 4) : "Connect";
    $("stakeEarned").textContent = state.account ? formatUnits(earned, 18, 6) : "Connect";
    const now = Math.floor(Date.now() / 1000);
    const live = BigInt(finish) > BigInt(now);
    $("stakeRate").textContent = live ? approxApr(daily, supply) : "—";
    $("stakeRateLabel").textContent = live ? `${formatUnits(daily, 18, 4)} BZB/day` : "No active stream";
    const left = live ? Number(BigInt(finish) - BigInt(now)) : 0;
    $("stakePeriod").textContent = live ? `${Math.ceil(left / 3600)}h left · ${Number(duration) / 86400}d duration` : "Not streaming";
    $("stakeFloat").textContent = formatUnits(supply, 18, 4);
    setStatus("stakeStatus", paused ? "Staking is paused. Withdraw and claim stay open." : "Staked BZB excludes the reward pot. APR is BZB earned per BZB staked if this daily rate ran a year.");
    log("stakeLog", "");
  } catch (err) {
    setStatus("stakeStatus", "Could not read the staking contract.");
    log("stakeLog", explainError(err) || "Read failed", "err");
  }
}

async function stakeAction(kind) {
  if (!state.account) {
    $("connectBtn").click();
    return;
  }
  if (state.busy) return;
  state.busy = true;
  try {
    await assertChain();
    const code = await withReadProvider((rpc) => rpc.getCode(STAKING));
    if (kind === "stake" && state.stakePaused) throw new Error("That contract is paused.");
    let data;
    if (kind === "claim") data = stakeIface.encodeFunctionData("getReward", []);
    else {
      const amount = parseUnits($("stakeAmount").value, 18);
      if (kind === "stake") await ensureAllowance(tokenByAddress(BZB), STAKING, amount, "stakeLog");
      data = stakeIface.encodeFunctionData(kind === "stake" ? "stake" : "withdraw", [amount]);
    }
    const gate = executionGate({
      chainId: state.chainId,
      code,
      paused: state.stakePaused,
      simulationOk: true,
      quoteFresh: true,
      stale: false,
      walletReject: false,
      action: kind === "stake" ? "stake" : "withdraw",
    });
    if (!gate.ok) throw new Error(gate.errors[0]);
    const tx = { to: STAKING, data, value: 0n };
    try {
      await simulate(tx);
    } catch (err) {
      throw new Error(err.shortMessage || "Simulation failed. Nothing was sent.");
    }
    const receipt = await send(tx, "stakeLog");
    log("stakeLog", `Confirmed in block ${receipt.blockNumber}.`, "ok");
    await loadStake();
    await paintBalances();
  } catch (err) {
    log("stakeLog", explainError(err) || "Staking action failed", "err");
  } finally {
    state.busy = false;
  }
}

function dayKey(time) {
  return Math.floor(Number(time) / 86400);
}

let logsRpc = null;
async function providerForLogs() {
  if (logsRpc) return logsRpc;
  const urls = ["https://polygon-bor-rpc.publicnode.com", ...(CFG.rpcUrls || [])];
  let last;
  for (const url of [...new Set(urls)]) {
    try {
      const next = new ethers.JsonRpcProvider(url, CHAIN_ID, RPC_OPTS);
      const latest = await next.getBlockNumber();
      await next.getLogs({
        address: FEE_ROUTER,
        fromBlock: Math.max(0, latest - 20),
        toBlock: latest,
        topics: [SWAP_TOPIC],
      });
      logsRpc = next;
      return next;
    } catch (err) {
      last = err;
    }
  }
  throw last || new Error("No RPC could read swap logs");
}

async function logsBetween() {
  const rpc = await providerForLogs();
  const latest = await rpc.getBlockNumber();
  const lookback = 40_000;
  const from = Math.max(0, latest - lookback);
  const spans = [];
  for (let cursor = from; cursor <= latest; cursor += 2000) spans.push([cursor, Math.min(latest, cursor + 1999)]);
  const rows = [];
  let failed = 0;
  for (let i = 0; i < spans.length; i += 4) {
    const batch = spans.slice(i, i + 4);
    const found = await Promise.all(batch.map(async ([start, end]) => {
      try {
        return await rpc.getLogs({ address: FEE_ROUTER, fromBlock: start, toBlock: end, topics: [SWAP_TOPIC] });
      } catch {
        failed++;
        return [];
      }
    }));
    for (const part of found) rows.push(...part);
  }
  if (!rows.length && failed) throw new Error("Swap logs could not be read. Reload the leaderboard.");
  return {
    rows: rows.slice(0, 500),
    partial: failed > 0,
    range: { created: from, latest, bounded: true },
  };
}

function feedAccepts(decoded, blockTime) {
  try {
    const answer = BigInt(decoded[1]);
    const updated = BigInt(decoded[3]);
    const when = BigInt(blockTime);
    if (answer <= 0n || updated <= 0n || updated > when) return false;
    if (when - updated > 86_400n) return false;
    return BigInt(decoded[4]) >= BigInt(decoded[0]);
  } catch {
    return false;
  }
}

let priceRpc = null;
async function priceAt(token, blockNumber, blockTime) {
  const feed = feedFor(token);
  if (!feed) return null;
  const data = feedIface.encodeFunctionData("latestRoundData", []);
  const blockTag = Math.max(0, blockNumber - 1);
  const urls = [...new Set(["https://polygon.drpc.org", ...(CFG.rpcUrls || [])])];
  if (priceRpc?.url) {
    const at = urls.indexOf(priceRpc.url);
    if (at > 0) {
      urls.splice(at, 1);
      urls.unshift(priceRpc.url);
    }
  }
  for (const url of urls) {
    const rpc = priceRpc?.url === url ? priceRpc : new ethers.JsonRpcProvider(url, CHAIN_ID, RPC_OPTS);
    try {
      const raw = await rpc.call({ to: feed.aggregator, data, blockTag });
      const decoded = feedIface.decodeFunctionResult("latestRoundData", raw);
      if (!feedAccepts(decoded, blockTime)) continue;
      rpc.url = url;
      priceRpc = rpc;
      return decoded;
    } catch {
      if (priceRpc?.url === url) priceRpc = null;
    }
  }
  return null;
}

async function loadBoard() {
  const gen = ++state.boardGen;
  setStatus("boardStatus", "Reading fee-router swaps…");
  $("boardBody").replaceChildren();
  try {
    const rpc = await provider();
    const code = await rpc.getCode(FEE_ROUTER);
    if (!code || code === "0x") throw new Error("Fee router has no code");
    const { rows, partial, range } = await logsBetween();
    const blocks = new Map();
    const trades = [];
    for (const row of rows) {
      const parsed = swapEvent.parseLog(row);
      if (!parsed) continue;
      let stamp = blocks.get(row.blockNumber);
      if (!stamp) {
        const block = await rpc.getBlock(row.blockNumber);
        stamp = Number(block.timestamp);
        blocks.set(row.blockNumber, stamp);
      }
      const tokenIn = parsed.args.tokenIn === ethers.ZeroAddress ? NATIVE : parsed.args.tokenIn;
      const tokenOut = parsed.args.tokenOut === ethers.ZeroAddress ? NATIVE : parsed.args.tokenOut;
      const priced = feedFor(tokenIn) ? tokenIn : feedFor(tokenOut) ? tokenOut : null;
      let eventUsd = 0n;
      try {
        if (parsed.args.usdTrusted) eventUsd = BigInt(parsed.args.usdE8);
      } catch {
        eventUsd = 0n;
      }
      let score = eventUsd > 0n ? eventUsd : 0n;
      if (score === 0n && priced) {
        const feedRow = await priceAt(priced, row.blockNumber, stamp);
        if (feedRow) {
          score = scoreTrade({
            tokenIn,
            tokenOut,
            consumed: parsed.args.amountIn,
            amountOut: parsed.args.amountOut,
            trader: parsed.args.trader,
            time: stamp,
            answer: feedRow[1],
            updatedAt: feedRow[3],
            blockTime: stamp,
            answeredInRound: feedRow[4],
            roundId: feedRow[0],
          });
        }
      }
      trades.push({
        trader: parsed.args.trader,
        tokenIn,
        tokenOut,
        consumed: parsed.args.amountIn,
        time: stamp,
        score,
        day: dayKey(stamp),
      });
    }
    const rewards = new ethers.Contract(REWARDS, rewardIface.fragments, rpc);
    const rewardCode = await rpc.getCode(REWARDS);
    const fundedBalance = rewardCode && rewardCode !== "0x" ? await balanceOf(tokenByAddress(BZB), REWARDS) : 0n;
    const dailyCap = rewardCode && rewardCode !== "0x" ? await rewards.dailyCap() : 0n;
    if (gen !== state.boardGen) return;
    state.board = { trades, partial, range, fundedBalance, dailyCap, rewardsReady: rewardCode && rewardCode !== "0x" };
    const days = [...new Set(trades.map((trade) => trade.day))].sort((a, b) => b - a);
    const select = $("boardDay");
    state.fillingDays = true;
    select.replaceChildren();
    if (!days.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No indexed days";
      select.appendChild(option);
    }
    for (const day of days) {
      const option = document.createElement("option");
      option.value = String(day);
      option.textContent = new Date(day * 86400 * 1000).toISOString().slice(0, 10);
      select.appendChild(option);
    }
    if (days.length) select.value = String(days[0]);
    state.fillingDays = false;
    await paintBoard();
  } catch (err) {
    if (gen !== state.boardGen) return;
    setStatus("boardStatus", "The leaderboard could not be read.");
    $("boardCoverage").textContent = "";
    $("boardFund").textContent = "";
    log("boardLog", err.shortMessage || err.message || "Index failed", "err");
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.textContent = err.shortMessage || err.message || "The leaderboard could not be read.";
    tr.appendChild(td);
    $("boardBody").appendChild(tr);
  }
}

async function paintBoard() {
  const gen = ++state.paintGen;
  const board = state.board;
  if (!board) return;
  const rawDay = $("boardDay").value;
  if (!rawDay) return;
  const day = Number(rawDay);
  const dayTrades = board.trades.filter((trade) => trade.day === day);
  const rows = Number.isFinite(day) ? buildDayBoard(dayTrades, { capBzb: board.dailyCap }) : [];
  let postedMap = new Map();
  let posted = false;
  let claimable = 0n;
  if (board.rewardsReady && Number.isFinite(day)) {
    try {
      const rpc = await provider();
      const rewards = new ethers.Contract(REWARDS, rewardIface.fragments, rpc);
      const info = await rewards.dayInfo(day);
      posted = Boolean(info.posted ?? info[4]);
      if (posted) {
        for (let i = 0; i < 25; i++) {
          const winner = await rewards.winner(day, i);
          if (winner.trader && winner.trader !== ethers.ZeroAddress) postedMap.set(winner.trader.toLowerCase(), winner.amount);
        }
      }
      if (state.account) claimable = await rewards.claimable(day, state.account);
    } catch {
      posted = false;
    }
  }
  if (gen !== state.paintGen) return;
  const body = $("boardBody");
  body.replaceChildren();
  const funds = rewardState({ fundedBalance: board.fundedBalance, posted, claimable });
  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    const priced = dayTrades.filter((trade) => trade.score > 0n).length;
    td.textContent = !dayTrades.length
      ? "No BZB buys or sells were indexed for this day."
      : priced
        ? `${dayTrades.length} priced swaps were netted off the board.`
        : `${dayTrades.length} swaps had no Chainlink price on either side, so that volume scored zero.`;
    tr.appendChild(td);
    body.appendChild(tr);
  }
  for (const row of rows) {
    const tr = document.createElement("tr");
    const cells = [
      String(row.rank),
      short(row.trader),
      formatUsdE8(row.scoreE8),
      row.paidSlot ? `${formatUnits(row.estimatedBzb, 18, 4)} BZB schedule` : "Not in the paid 25",
      postedMap.has(row.trader) ? `${formatUnits(postedMap.get(row.trader), 18, 4)} BZB posted` : "Not posted",
    ];
    for (const text of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  $("boardFund").textContent = funds.funded
    ? `Rewards contract holds ${formatUnits(board.fundedBalance, 18, 4)} BZB. ${posted ? "This day is posted." : "This day is not posted."}`
    : "Rewards contract BZB balance is 0. The schedule is not claimable and this page will not fund it.";
  $("claimRewardBtn").hidden = !(funds.claimable > 0n);
  state.claimDay = funds.claimable > 0n ? day : null;
  setStatus("boardStatus", rows.length ? `${rows.length} scored wallet${rows.length === 1 ? "" : "s"}. BZB buys and sells are included. Estimates are not payments.` : "Nothing scored.");
  const span = board.partial ? "Some log pages failed" : "Log read finished";
  $("boardCoverage").textContent = `${span}. Blocks ${board.range.created.toLocaleString()}–${board.range.latest.toLocaleString()}. ${board.trades.length} router swaps. BZB buys score the POL, WETH, WBTC, USDC, or USDT paid. BZB sells score those tokens when they are what you received.`;
  log("boardLog", "");
}

async function claimPosted() {
  if (!state.account || state.claimDay === null || state.busy) return;
  state.busy = true;
  try {
    await assertChain();
    const rpc = await provider();
    const code = await rpc.getCode(REWARDS);
    const data = rewardIface.encodeFunctionData("claim", [state.claimDay]);
    const gate = executionGate({ chainId: state.chainId, code, paused: false, simulationOk: true, quoteFresh: true, stale: false, walletReject: false, action: "claim" });
    if (!gate.ok) throw new Error(gate.errors[0]);
    const tx = { to: REWARDS, data, value: 0n };
    await simulate(tx);
    const receipt = await send(tx, "boardLog");
    log("boardLog", `Claimed in block ${receipt.blockNumber}.`, "ok");
    await paintBoard();
  } catch (err) {
    log("boardLog", err.shortMessage || err.message || "Claim failed", "err");
  } finally {
    state.busy = false;
  }
}

const liqRouterIface = new ethers.Interface([
  "function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) returns (uint256,uint256,uint256)",
  "function removeLiquidity(address,address,uint256,uint256,uint256,address,uint256) returns (uint256,uint256)",
]);
const liqFactoryIface = new ethers.Interface([
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)",
  "function getPair(address,address) view returns (address)",
]);
const liqPairIface = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const metaCache = new Map();
let liqQuoteLock = false;

function liqSlipBps() {
  const n = Number(String($("liqSlippage").value || "0.5").replace("%", "").trim());
  if (!Number.isFinite(n) || n < 0) return 50;
  return Math.min(5000, Math.round(n * 100));
}

function withSlip(amount) {
  const bps = BigInt(liqSlipBps());
  return amount - (amount * bps) / 10_000n;
}

function poolAsset(token) {
  return isNative(token.address) ? WPOL : token.address;
}

async function tokenMeta(address) {
  const key = address.toLowerCase();
  if (metaCache.has(key)) return metaCache.get(key);
  const known = tokenByAddress(address);
  if (known) {
    metaCache.set(key, known);
    return known;
  }
  const rpc = await provider();
  let symbol = short(address);
  let decimals = 18;
  try {
    const raw = await rpc.call({ to: address, data: liqPairIface.encodeFunctionData("symbol", []) });
    symbol = liqPairIface.decodeFunctionResult("symbol", raw)[0] || symbol;
  } catch { /* unknown token */ }
  try {
    const raw = await rpc.call({ to: address, data: liqPairIface.encodeFunctionData("decimals", []) });
    decimals = Number(liqPairIface.decodeFunctionResult("decimals", raw)[0]);
  } catch { /* default 18 */ }
  const token = { symbol, name: symbol, address, decimals, logo: "" };
  metaCache.set(key, token);
  return token;
}

async function pairReserves(tokenA, tokenB) {
  const rpc = await provider();
  const data = liqFactoryIface.encodeFunctionData("getPair", [poolAsset(tokenA), poolAsset(tokenB)]);
  const pair = liqFactoryIface.decodeFunctionResult("getPair", await rpc.call({ to: CFG.factory, data }))[0];
  if (!pair || pair === ethers.ZeroAddress) return null;
  const raw = await rpc.call({ to: pair, data: liqPairIface.encodeFunctionData("getReserves", []) });
  const reserves = liqPairIface.decodeFunctionResult("getReserves", raw);
  const token0 = liqPairIface.decodeFunctionResult("token0", await rpc.call({ to: pair, data: liqPairIface.encodeFunctionData("token0", []) }))[0];
  const aIs0 = poolAsset(tokenA).toLowerCase() === token0.toLowerCase();
  return {
    pair,
    reserveA: aIs0 ? BigInt(reserves[0]) : BigInt(reserves[1]),
    reserveB: aIs0 ? BigInt(reserves[1]) : BigInt(reserves[0]),
  };
}

function paintLiqNames() {
  const a = tokenByAddress($("liqA").value);
  const b = tokenByAddress($("liqB").value);
  if (a) {
    $("liqNameA").textContent = a.symbol;
    $("liqA").setAttribute("aria-label", a.symbol);
  }
  if (b) {
    $("liqNameB").textContent = b.symbol;
    $("liqB").setAttribute("aria-label", b.symbol);
  }
}

async function paintPoolHint() {
  paintLiqNames();
  const a = tokenByAddress($("liqA").value);
  const b = tokenByAddress($("liqB").value);
  if (!a || !b) return;
  if (poolAsset(a).toLowerCase() === poolAsset(b).toLowerCase()) {
    setStatus("liqStatus", "POL and WPOL are the same pool token.");
    return;
  }
  try {
    const reserves = await pairReserves(a, b);
    if (!reserves || reserves.reserveA === 0n || reserves.reserveB === 0n) {
      setStatus("liqStatus", `${a.symbol} / ${b.symbol} has no Blazar pool yet. The first deposit sets the price.`);
      return;
    }
    setStatus("liqStatus", `${a.symbol} / ${b.symbol} is live. Enter one amount and the other fills 50/50.`);
  } catch {
    setStatus("liqStatus", "Could not read that Blazar pool.");
  }
}

async function quoteLiquidity(source) {
  if (liqQuoteLock) return;
  const a = tokenByAddress($("liqA").value);
  const b = tokenByAddress($("liqB").value);
  if (!a || !b) return;
  paintLiqNames();
  if (poolAsset(a).toLowerCase() === poolAsset(b).toLowerCase()) {
    setStatus("liqStatus", "POL and WPOL are the same pool token. Pick another pair.");
    return;
  }
  const fromA = source !== "liqAmtB";
  const raw = $(fromA ? "liqAmtA" : "liqAmtB").value.trim();
  if (!raw) return;
  let amount;
  try {
    amount = parseUnits(raw, (fromA ? a : b).decimals);
  } catch {
    return;
  }
  if (amount <= 0n) return;
  try {
    const reserves = await pairReserves(a, b);
    if (!reserves || reserves.reserveA === 0n || reserves.reserveB === 0n) {
      setStatus("liqStatus", "No Blazar pool yet. Enter both amounts. The first deposit sets the price.");
      return;
    }
    const quoted = fromA
      ? (amount * reserves.reserveB) / reserves.reserveA
      : (amount * reserves.reserveA) / reserves.reserveB;
    liqQuoteLock = true;
    $(fromA ? "liqAmtB" : "liqAmtA").value = formatUnits(quoted, (fromA ? b : a).decimals, (fromA ? b : a).decimals);
    liqQuoteLock = false;
    setStatus("liqStatus", "Pool exists. The other amount is the 50/50 deposit.");
  } catch (err) {
    liqQuoteLock = false;
    setStatus("liqStatus", err.shortMessage || "Could not read the Blazar pool.");
  }
}

async function addLiquidity() {
  if (!state.account) {
    $("connectBtn").click();
    return;
  }
  if (state.busy) return;
  state.busy = true;
  $("addLiqBtn").disabled = true;
  try {
    await assertChain();
    const a = tokenByAddress($("liqA").value);
    const b = tokenByAddress($("liqB").value);
    if (!a || !b) throw new Error("Choose two tokens");
    if (poolAsset(a).toLowerCase() === poolAsset(b).toLowerCase()) throw new Error("POL and WPOL are the same pool token.");
    const amtA = parseUnits($("liqAmtA").value.trim(), a.decimals);
    const amtB = parseUnits($("liqAmtB").value.trim(), b.decimals);
    if (amtA <= 0n || amtB <= 0n) throw new Error("Enter both amounts");
    if (isNative(a.address)) {
      log("liqLog", "Wrapping POL…");
      const tx = wrapTx(a.address, WPOL, amtA);
      await simulate(tx);
      await send(tx, "liqLog");
    }
    if (isNative(b.address)) {
      log("liqLog", "Wrapping POL…");
      const tx = wrapTx(b.address, WPOL, amtB);
      await simulate(tx);
      await send(tx, "liqLog");
    }
    const tokenA = poolAsset(a);
    const tokenB = poolAsset(b);
    await ensureAllowance({ address: tokenA }, CFG.router, amtA, "liqLog");
    await ensureAllowance({ address: tokenB }, CFG.router, amtB, "liqLog");
    const deadline = Math.floor(Date.now() / 1000) + 20 * 60;
    const data = liqRouterIface.encodeFunctionData("addLiquidity", [
      tokenA, tokenB, amtA, amtB, withSlip(amtA), withSlip(amtB), state.account, deadline,
    ]);
    const tx = { to: CFG.router, data, value: 0n };
    try {
      await simulate(tx);
    } catch (err) {
      throw new Error(err.shortMessage || "Simulation failed. Nothing was sent.");
    }
    const receipt = await send(tx, "liqLog");
    log("liqLog", `Liquidity added in block ${receipt.blockNumber}.`, "ok");
    refreshHoldings({ force: true }).catch(() => {});
    await loadPositions();
  } catch (err) {
    log("liqLog", err.shortMessage || err.message || "Add liquidity failed", "err");
  } finally {
    state.busy = false;
    $("addLiqBtn").disabled = false;
  }
}

async function loadPositions() {
  const box = $("posList");
  if (!box) return;
  box.replaceChildren();
  if (!state.account) {
    setStatus("posStatus", "");
    return;
  }
  setStatus("posStatus", "");
  try {
    const rpc = await provider();
    const lengthRaw = await rpc.call({ to: CFG.factory, data: liqFactoryIface.encodeFunctionData("allPairsLength", []) });
    const count = Number(liqFactoryIface.decodeFunctionResult("allPairsLength", lengthRaw)[0]);
    if (!count) {
      setStatus("posStatus", "No Blazar pools yet.");
      return;
    }
    const pairRows = await multicall(Array.from({ length: count }, (_, i) => ({
      to: CFG.factory,
      data: liqFactoryIface.encodeFunctionData("allPairs", [i]),
    })));
    const pairs = pairRows.map((row) => (row.success ? liqFactoryIface.decodeFunctionResult("allPairs", row.data)[0] : null)).filter(Boolean);
    const balances = await multicall(pairs.map((pair) => ({
      to: pair,
      data: liqPairIface.encodeFunctionData("balanceOf", [state.account]),
    })));
    const held = [];
    balances.forEach((row, index) => {
      if (!row.success) return;
      const balance = BigInt(liqPairIface.decodeFunctionResult("balanceOf", row.data)[0]);
      if (balance > 0n) held.push({ pair: pairs[index], balance });
    });
    if (!held.length) {
      setStatus("posStatus", "No liquidity in this wallet yet.");
      return;
    }
    const detail = await multicall(held.flatMap((item) => [
      { to: item.pair, data: liqPairIface.encodeFunctionData("token0", []) },
      { to: item.pair, data: liqPairIface.encodeFunctionData("token1", []) },
      { to: item.pair, data: liqPairIface.encodeFunctionData("getReserves", []) },
      { to: item.pair, data: liqPairIface.encodeFunctionData("totalSupply", []) },
    ]));
    for (let i = 0; i < held.length; i++) {
      const token0Row = detail[i * 4];
      const token1Row = detail[i * 4 + 1];
      const reserveRow = detail[i * 4 + 2];
      const supplyRow = detail[i * 4 + 3];
      if (!token0Row?.success || !token1Row?.success || !reserveRow?.success || !supplyRow?.success) continue;
      const token0 = liqPairIface.decodeFunctionResult("token0", token0Row.data)[0];
      const token1 = liqPairIface.decodeFunctionResult("token1", token1Row.data)[0];
      const reserves = liqPairIface.decodeFunctionResult("getReserves", reserveRow.data);
      const supply = BigInt(liqPairIface.decodeFunctionResult("totalSupply", supplyRow.data)[0]);
      const [meta0, meta1] = await Promise.all([tokenMeta(token0), tokenMeta(token1)]);
      const card = document.createElement("article");
      card.className = "pos-card";
      const title = document.createElement("h4");
      title.textContent = `${meta0.symbol} / ${meta1.symbol}`;
      const meta = document.createElement("p");
      meta.className = "pos-meta";
      const out = document.createElement("p");
      out.className = "pos-meta";
      const slide = document.createElement("div");
      slide.className = "pos-slide";
      const range = document.createElement("input");
      range.type = "range";
      range.min = "0";
      range.max = "100";
      range.value = "100";
      const pct = document.createElement("b");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost";
      button.textContent = "Remove";
      const share = supply === 0n ? 0 : Number((held[i].balance * 10_000n) / supply) / 100;
      meta.textContent = `${formatUnits(held[i].balance, 18, 6)} LP · ${share.toFixed(2)}% of the pool`;
      const paintOut = () => {
        const take = held[i].balance * BigInt(range.value) / 100n;
        const amount0 = supply === 0n ? 0n : take * BigInt(reserves[0]) / supply;
        const amount1 = supply === 0n ? 0n : take * BigInt(reserves[1]) / supply;
        pct.textContent = `${range.value}%`;
        out.textContent = `Removes about ${formatUnits(amount0, meta0.decimals, 6)} ${meta0.symbol} and ${formatUnits(amount1, meta1.decimals, 6)} ${meta1.symbol}.`;
      };
      range.addEventListener("input", paintOut);
      button.addEventListener("click", () => {
        removePosition(held[i].pair, held[i].balance, token0, token1, BigInt(reserves[0]), BigInt(reserves[1]), supply, Number(range.value)).catch((err) => {
          log("liqLog", err.message || "Remove failed", "err");
        });
      });
      slide.append(range, pct);
      card.append(title, meta, slide, out, button);
      box.appendChild(card);
      paintOut();
    }
    setStatus("posStatus", "");
  } catch (err) {
    setStatus("posStatus", "Could not read positions.");
    log("liqLog", err.shortMessage || err.message || "Position read failed", "err");
  }
}

async function removePosition(pair, balance, token0, token1, reserve0, reserve1, supply, pct) {
  if (!state.account) {
    $("connectBtn").click();
    return;
  }
  if (state.busy) return;
  if (pct <= 0) throw new Error("Move the slider above 0%.");
  state.busy = true;
  try {
    await assertChain();
    const liquidity = balance * BigInt(Math.round(pct)) / 100n;
    if (liquidity <= 0n) throw new Error("That share rounds to zero.");
    await ensureAllowance({ address: pair }, CFG.router, liquidity, "liqLog");
    const amount0 = supply === 0n ? 0n : liquidity * reserve0 / supply;
    const amount1 = supply === 0n ? 0n : liquidity * reserve1 / supply;
    const deadline = Math.floor(Date.now() / 1000) + 20 * 60;
    const data = liqRouterIface.encodeFunctionData("removeLiquidity", [
      token0, token1, liquidity, withSlip(amount0), withSlip(amount1), state.account, deadline,
    ]);
    const tx = { to: CFG.router, data, value: 0n };
    try {
      await simulate(tx);
    } catch (err) {
      throw new Error(err.shortMessage || "Simulation failed. Nothing was sent.");
    }
    const receipt = await send(tx, "liqLog");
    log("liqLog", `Liquidity removed in block ${receipt.blockNumber}.`, "ok");
    refreshHoldings({ force: true }).catch(() => {});
    await loadPositions();
  } catch (err) {
    log("liqLog", err.shortMessage || err.message || "Remove failed", "err");
  } finally {
    state.busy = false;
  }
}

function showTab(name) {
  for (const tab of ["swap", "liq", "stake", "board"]) {
    const button = $(`tab-${tab}`);
    const on = tab === name;
    button.classList.toggle("active", on);
    button.setAttribute("aria-selected", on ? "true" : "false");
  }
  $("swap-layout").hidden = name !== "swap";
  $("pane-liq").hidden = name !== "liq";
  $("pane-stake").hidden = name !== "stake";
  $("pane-board").hidden = name !== "board";
  if (name === "liq") {
    paintPoolHint();
    loadPositions();
  }
  if (name === "stake") loadStake();
  if (name === "board" && !state.board) loadBoard();
}

function announcedWallets() {
  const list = window.__blazarWallets || (window.__blazarWallets = []);
  if (!window.__blazarWalletListen) {
    window.__blazarWalletListen = true;
    window.addEventListener("eip6963:announceProvider", (event) => {
      const detail = event?.detail;
      if (!detail?.provider) return;
      if (!list.some((item) => item.provider === detail.provider)) list.push(detail);
    });
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  }
  return list;
}

function pickInjected(kind) {
  const announced = announcedWallets();
  for (const item of announced) {
    const info = item.info || {};
    const rdns = String(info.rdns || "");
    const name = String(info.name || "").toLowerCase();
    if (kind === "phantom" && (rdns === "app.phantom" || name.includes("phantom"))) return item.provider;
    if (kind === "rabby" && (rdns === "io.rabby" || name.includes("rabby"))) return item.provider;
    if (kind === "metamask" && (rdns === "io.metamask" || name === "metamask")) return item.provider;
  }
  if (kind === "phantom" && window.phantom?.ethereum) return window.phantom.ethereum;
  const eth = window.ethereum;
  const list = eth && Array.isArray(eth.providers) ? eth.providers.slice() : (eth ? [eth] : []);
  if (kind === "phantom") return list.find((item) => item?.isPhantom) || null;
  if (kind === "rabby") return list.find((item) => item?.isRabby) || null;
  return list.find((item) => item?.isMetaMask && !item.isPhantom && !item.isRabby) || null;
}

function paintWallet() {
  const logged = !!state.account;
  $("useMetaMask").hidden = logged;
  $("usePhantom").hidden = logged;
  $("useRabby").hidden = logged;
  $("disconnectBtn").hidden = !logged;
  $("connectBtn").textContent = logged ? short(state.account) : "Connect";
  $("networkChip").textContent = !logged ? "Not connected" : state.chainId === CHAIN_ID ? "Polygon" : `Chain ${state.chainId}`;
}

async function connect(kind) {
  const injected = pickInjected(kind);
  if (!injected) {
    log("swapLog", `${kind} is not installed.`, "err");
    return;
  }
  state.injected = injected;
  state.walletKind = kind;
  const accounts = await injected.request({ method: "eth_requestAccounts" });
  if (!accounts?.length) return;
  state.account = ethers.getAddress(accounts[0]);
  const hex = await injected.request({ method: "eth_chainId" });
  state.chainId = parseInt(hex, 16);
  if (state.chainId !== CHAIN_ID) {
    try {
      await injected.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x89" }] });
      state.chainId = CHAIN_ID;
    } catch (err) {
      log("swapLog", err?.message || "Switch to Polygon before swapping.", "err");
    }
  }
  paintWallet();
  $("walletDrop").hidden = true;
  await paintBalances();
  refreshHoldings({ force: true }).catch(() => {});
  if (injected && !injected.__blazarHoldingsHooked) {
    injected.__blazarHoldingsHooked = true;
    injected.on?.("accountsChanged", (accounts) => {
      if (state.leaving) return;
      if (!accounts?.length) {
        disconnect();
        return;
      }
      state.account = ethers.getAddress(accounts[0]);
      paintWallet();
      paintBalances();
      refreshHoldings({ force: true }).catch(() => {});
      loadStake();
      loadPositions();
    });
    injected.on?.("chainChanged", (hex) => {
      state.chainId = parseInt(hex, 16);
      paintWallet();
      refreshHoldings({ force: true }).catch(() => {});
    });
  }
  await loadStake();
  await loadPositions();
}

function disconnect() {
  state.leaving = true;
  state.account = null;
  state.chainId = null;
  state.injected = null;
  paintWallet();
  paintBalances();
  clearHoldings();
  loadStake();
  loadPositions();
  $("walletDrop").hidden = true;
  setTimeout(() => { state.leaving = false; }, 400);
}

let chartGen = 0;
let chartAbort = null;
let shownChartKey = null;
const chartPoolCache = new Map();

function chartLayers() {
  const frame = $("chartFrame");
  return frame ? [...frame.querySelectorAll(".chart-layer")] : [];
}

function liveChartLayer() {
  return chartLayers().find((el) => el.classList.contains("live")) || null;
}

function stampInitialChart() {
  const live = liveChartLayer();
  if (!live || live.dataset.src) return;
  live.dataset.src = live.src;
  live.dataset.ready = "1";
  const key = canonicalChartToken($("tokenOut")?.value);
  if (key && key === BZB.toLowerCase()) live.dataset.token = key;
}

function paintChartHeading(token) {
  const heading = $("chart-card")?.querySelector("h3");
  if (heading) heading.textContent = token?.symbol || "Token";
  const link = geckoTokenUrl(token?.address || "");
  if (link && $("chartLink")) $("chartLink").href = link;
}

function embedLoaded(frame) {
  try {
    return !frame.contentDocument;
  } catch {
    return true;
  }
}

function showChartPool(url, title, tokenKey) {
  const frame = $("chartFrame");
  const all = chartLayers();
  const current = liveChartLayer() || all[0];
  const standby = all.find((el) => el !== current) || current;
  if (!frame || !current || !standby) return;
  frame.classList.remove("show-empty");
  const finish = (node) => {
    if (node._chartTimer) clearTimeout(node._chartTimer);
    node.dataset.token = tokenKey;
    node.dataset.src = url;
    node.dataset.ready = "1";
    node.title = title;
    node.setAttribute("aria-hidden", "false");
    for (const el of all) {
      const on = el === node;
      el.classList.toggle("live", on);
      if (!on) el.setAttribute("aria-hidden", "true");
    }
    frame.classList.remove("pending");
    shownChartKey = tokenKey;
  };
  if (current.dataset.src === url && current.dataset.ready === "1") {
    finish(current);
    return;
  }
  if (standby !== current && standby.dataset.src === url && standby.dataset.ready === "1") {
    finish(standby);
    return;
  }
  const gen = chartGen;
  const arm = (node) => {
    if (node._chartTimer) clearTimeout(node._chartTimer);
    node._chartTimer = setTimeout(() => {
      if (gen !== chartGen || node.dataset.src !== url || node.dataset.ready === "1") return;
      if (embedLoaded(node)) finish(node);
      else frame.classList.remove("pending");
    }, 10000);
    node.onload = () => {
      if (node._chartTimer) clearTimeout(node._chartTimer);
      if (gen !== chartGen || node.dataset.src !== url || !embedLoaded(node)) return;
      finish(node);
    };
  };
  standby.title = title;
  if (standby.dataset.src === url && standby.src === url) {
    arm(standby);
    if (embedLoaded(standby)) finish(standby);
    return;
  }
  standby.dataset.ready = "0";
  standby.dataset.src = url;
  arm(standby);
  standby.src = url;
}

function showChartEmpty(copy, token, tokenKey) {
  const frame = $("chartFrame");
  if (!frame) return;
  paintChartHeading(token);
  if ($("chartEmpty")) $("chartEmpty").textContent = copy.frame;
  if ($("chartNote")) $("chartNote").textContent = copy.note;
  if ($("chartLiq")) $("chartLiq").textContent = "Liquidity —";
  if ($("chartAge")) $("chartAge").textContent = "Age —";
  frame.classList.add("show-empty");
  frame.classList.remove("pending");
  shownChartKey = tokenKey;
}

async function lookupChartPool(tokenKey, signal) {
  if (chartPoolCache.has(tokenKey)) return chartPoolCache.get(tokenKey);
  const path = geckoPoolsPath(tokenKey);
  if (!path) return null;
  const response = await fetch(`https://api.geckoterminal.com/api/v2${path}`, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`GeckoTerminal returned ${response.status}`);
  const pool = bestChartPool(await response.json(), { token: tokenKey });
  chartPoolCache.set(tokenKey, pool);
  return pool;
}

// Token B (the output token) picks the chart. Quotes do not read this choice.
async function loadChart() {
  const token = selected("tokenOut");
  const key = canonicalChartToken(token?.address || "");
  if (!token || !key) return;
  if (shownChartKey === key && chartPoolCache.has(key)) return;
  const gen = ++chartGen;
  chartAbort?.abort();
  const abort = new AbortController();
  chartAbort = abort;
  const frame = $("chartFrame");
  const live = liveChartLayer();
  if (live?.dataset.token && live.dataset.token !== key) {
    paintChartHeading(token);
    if ($("chartLiq")) $("chartLiq").textContent = "Liquidity …";
    if ($("chartAge")) $("chartAge").textContent = "Age …";
  }
  try {
    const pool = await lookupChartPool(key, abort.signal);
    if (gen !== chartGen) return;
    if (!pool) {
      showChartEmpty(emptyChartCopy("none"), token, key);
      return;
    }
    const url = geckoEmbedUrl(pool.address);
    if (!url) throw new Error("chart pool");
    const heading = $("chart-card")?.querySelector("h3");
    if (heading) heading.textContent = pool.name;
    if ($("chartLiq")) $("chartLiq").textContent = liquidityLabel(pool.liquidityUsd);
    if ($("chartAge")) $("chartAge").textContent = ageLabel(pool.createdAt);
    const poolLink = geckoPoolUrl(pool.address);
    if (poolLink && $("chartLink")) $("chartLink").href = poolLink;
    if ($("chartNote")) {
      $("chartNote").textContent = chartCaption(pool, { blazarPairUnlisted: key === BZB.toLowerCase() });
    }
    const showing = chartLayers().some((el) => el.dataset.src === url && el.dataset.ready === "1");
    if (!showing) frame?.classList.add("pending");
    showChartPool(url, `${token.symbol} pool chart`, key);
  } catch (err) {
    if (gen !== chartGen || err?.name === "AbortError") return;
    const current = liveChartLayer();
    frame?.classList.remove("pending");
    if (current?.dataset.ready === "1" && current.dataset.token === key) {
      if ($("chartNote")) $("chartNote").textContent = "GeckoTerminal is unavailable. Showing the last pool for this token. Swaps still search every allowlisted venue.";
      return;
    }
    showChartEmpty(emptyChartCopy("down"), token, null);
    shownChartKey = null;
  }
}

function boot() {
  if (ethers.id("AggregatedSwap(address,address,address,address,uint256,uint256,uint256,uint256,bool,uint16,bytes32)").toLowerCase() !== SWAP_TOPIC) {
    log("swapLog", "Swap event signature check failed.", "err");
  }
  fillSelect("tokenIn", NATIVE);
  fillSelect("tokenOut", BZB);
  fillSelect("liqA", NATIVE);
  fillSelect("liqB", BZB);
  paintLiqNames();
  loadRemoteLists();
  $("routeDetail").textContent = `${coverage.searched} ${coverage.discovery} ${coverage.notCovered}`;
  document.querySelectorAll(".desk-live .tabs button").forEach((button) => {
    button.addEventListener("click", () => showTab(button.dataset.tab));
  });
  $("tokenIn").addEventListener("change", () => { scheduleQuote(); paintBalances(); });
  $("tokenOut").addEventListener("change", () => { scheduleQuote(); paintBalances(); loadChart(); });
  $("amountIn").addEventListener("input", scheduleQuote);
  $("slippage").addEventListener("input", () => { if (state.quote) paintQuote(state.quote); });
  document.querySelectorAll("[data-slip]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-slip]").forEach((item) => item.classList.remove("on"));
      button.classList.add("on");
      $("slippage").value = Number(button.dataset.slip).toFixed(2);
      if (state.quote) paintQuote(state.quote);
    });
  });
  $("flipBtn").addEventListener("click", () => {
    const sell = $("tokenIn").value;
    $("tokenIn").value = $("tokenOut").value;
    $("tokenOut").value = sell;
    syncTokenButton($("tokenIn"));
    syncTokenButton($("tokenOut"));
    scheduleQuote();
    paintBalances();
    loadChart();
  });
  $("maxIn").addEventListener("click", async () => {
    if (!state.account) return;
    const token = selected("tokenIn");
    let amount = await balanceOf(token, state.account);
    if (isNative(token.address) && amount > POL_RESERVE) amount -= POL_RESERVE;
    $("amountIn").value = formatUnits(amount, token.decimals, token.decimals);
    scheduleQuote();
  });
  $("swapBtn").addEventListener("click", () => { doSwap(); });
  $("stakeBtn").addEventListener("click", () => { stakeAction("stake"); });
  $("withdrawBtn").addEventListener("click", () => { stakeAction("withdraw"); });
  $("claimStakeBtn").addEventListener("click", () => { stakeAction("claim"); });
  $("maxStake").addEventListener("click", async () => {
    if (!state.account) return;
    const amount = await balanceOf(tokenByAddress(BZB), state.account);
    $("stakeAmount").value = formatUnits(amount, 18, 6);
  });
  let liqTimer = 0;
  const scheduleLiq = (source) => {
    clearTimeout(liqTimer);
    liqTimer = setTimeout(() => { quoteLiquidity(source).catch(() => {}); }, 200);
  };
  $("liqAmtA").addEventListener("input", () => scheduleLiq("liqAmtA"));
  $("liqAmtB").addEventListener("input", () => scheduleLiq("liqAmtB"));
  $("liqA").addEventListener("change", () => { paintPoolHint(); scheduleLiq("liqAmtA"); });
  $("liqB").addEventListener("change", () => { paintPoolHint(); scheduleLiq("liqAmtB"); });
  $("addLiqBtn").addEventListener("click", () => { addLiquidity(); });
  for (const [button, field, select] of [["maxLiqA", "liqAmtA", "liqA"], ["maxLiqB", "liqAmtB", "liqB"]]) {
    $(button).addEventListener("click", async () => {
      if (!state.account) return;
      const token = tokenByAddress($(select).value);
      let amount = await balanceOf(token, state.account);
      if (isNative(token.address) && amount > POL_RESERVE) amount -= POL_RESERVE;
      $(field).value = formatUnits(amount, token.decimals, token.decimals);
      scheduleLiq(field);
    });
  }
  $("boardRetry").addEventListener("click", () => { state.board = null; loadBoard(); });
  $("boardDay").addEventListener("change", () => {
    if (state.fillingDays) return;
    paintBoard().catch((err) => log("boardLog", err.message || "Could not read the day", "err"));
  });
  $("claimRewardBtn").addEventListener("click", () => { claimPosted(); });
  $("connectBtn").addEventListener("click", () => {
    const drop = $("walletDrop");
    drop.hidden = !drop.hidden;
    $("connectBtn").setAttribute("aria-expanded", drop.hidden ? "false" : "true");
  });
  for (const id of ["useMetaMask", "useRabby", "usePhantom"]) {
    $(id).addEventListener("click", () => { connect($(id).dataset.wallet).catch((err) => log("swapLog", err.message || "Connect failed", "err")); });
  }
  $("disconnectBtn").addEventListener("click", disconnect);
  announcedWallets();
  stampInitialChart();
  loadChart();
  readAllowlist().then(() => refreshQuote()).catch((err) => {
    setStatus("swapStatus", "Could not read the fee router.");
    log("swapLog", explainError(err) || "Router read failed", "err");
  });
  loadStake();
}

boot();
