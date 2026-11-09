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
  TOKENS,
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
  MIN_TRADE_USD_E8,
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
} from "./desk-core.mjs?v=desk7";

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
  allow: null,
  routerPaused: false,
  stakePaused: false,
  board: null,
  claimDay: null,
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
]);
const swapEvent = new ethers.Interface([
  "event AggregatedSwap(address indexed trader,address indexed tokenIn,address indexed tokenOut,address recipient,uint256 amountIn,uint256 feeAmount,uint256 amountOut,uint256 usdE8,bool usdTrusted,uint16 feeBps,bytes32 routeId)",
]);

let readProvider = null;

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
  return TOKENS.find((token) => token.address.toLowerCase() === String(address).toLowerCase()) || null;
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
  for (const url of CFG.rpcUrls) {
    try {
      const next = new ethers.JsonRpcProvider(url, CHAIN_ID, { staticNetwork: true });
      await next.getBlockNumber();
      readProvider = next;
      return next;
    } catch (err) {
      last = err;
    }
  }
  throw last || new Error("Polygon RPC is unavailable");
}

async function call(to, data, blockTag) {
  const rpc = await provider();
  if (blockTag === undefined || blockTag === null) return rpc.call({ to, data });
  return rpc.call({ to, data }, blockTag);
}

async function multicall(calls) {
  const rpc = await provider();
  const data = multiIface.encodeFunctionData("aggregate3", [calls.map((item) => [item.to, true, item.data])]);
  const raw = await rpc.call({ to: MULTICALL, data });
  const [rows] = multiIface.decodeFunctionResult("aggregate3", raw);
  return rows.map((row) => ({ success: Boolean(row.success ?? row[0]), data: row.returnData ?? row[1] }));
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
  return TOKENS.map((token) => poolToken(token.address)).filter((address, index, list) => list.findIndex((item) => item.toLowerCase() === address.toLowerCase()) === index);
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
    clearQuote("No allowlisted route");
    $("routeDetail").textContent = `${coverage.searched} ${coverage.discovery} ${coverage.notCovered}`;
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
        : "No route on the allowlisted venues.");
    log("swapLog", "");
  } catch (err) {
    if (gen !== state.quoteGen) return;
    state.quote = null;
    paintQuote(null);
    setStatus("swapStatus", "Quote failed.");
    log("swapLog", err.shortMessage || err.message || "Quote failed", "err");
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
  const rpc = await provider();
  await rpc.call({ to: tx.to, from: state.account, data: tx.data, value: tx.value || 0n });
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
  const rpc = await provider();
  const data = erc20Iface.encodeFunctionData("allowance", [state.account, spender]);
  const current = BigInt(erc20Iface.decodeFunctionResult("allowance", await rpc.call({ to: token.address, data }))[0]);
  const steps = approvalPlan(current, amount);
  for (const step of steps) {
    const approve = erc20Iface.encodeFunctionData("approve", [spender, step]);
    const tx = { to: token.address, data: approve, value: 0n };
    const code = await rpc.getCode(token.address);
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
    if (!quote?.best) throw new Error("No allowlisted route");
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
    scheduleQuote();
  } catch (err) {
    log("swapLog", err.shortMessage || err.message || "Swap failed", "err");
  } finally {
    state.busy = false;
    $("swapBtn").disabled = false;
  }
}

function fillSelect(id, prefer) {
  const select = $(id);
  select.replaceChildren();
  for (const token of TOKENS) {
    const option = document.createElement("option");
    option.value = token.address;
    option.textContent = token.symbol;
    select.appendChild(option);
  }
  select.value = prefer;
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
    const [staked, earned, rate, daily, duration, finish, paused, wallet, float] = await Promise.all([
      state.account ? stake.balanceOf(account) : 0n,
      state.account ? stake.earned(account) : 0n,
      stake.rewardRate(),
      stake.dailyRate(),
      stake.rewardsDuration(),
      stake.periodFinish(),
      stake.paused(),
      state.account ? balanceOf(tokenByAddress(BZB), state.account) : null,
      balanceOf(tokenByAddress(BZB), STAKING),
    ]);
    state.stakePaused = paused;
    $("stakeWallet").textContent = wallet === null ? "Connect" : formatUnits(wallet, 18, 4);
    $("stakeStaked").textContent = state.account ? formatUnits(staked, 18, 4) : "Connect";
    $("stakeEarned").textContent = state.account ? formatUnits(earned, 18, 6) : "Connect";
    const now = Math.floor(Date.now() / 1000);
    const live = BigInt(finish) > BigInt(now);
    $("stakeRate").textContent = live ? `${formatUnits(daily, 18, 4)} BZB/day` : "No active stream";
    const left = live ? Number(BigInt(finish) - BigInt(now)) : 0;
    $("stakePeriod").textContent = live ? `${Math.ceil(left / 3600)}h left · ${Number(duration) / 86400}d duration` : "Not streaming";
    $("stakeFloat").textContent = formatUnits(float, 18, 4);
    setStatus("stakeStatus", paused ? "Staking is paused. Withdraw and claim stay open." : "No lock and no stake fee.");
    log("stakeLog", "");
  } catch (err) {
    setStatus("stakeStatus", "Could not read the staking contract.");
    log("stakeLog", err.shortMessage || err.message || "Read failed", "err");
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
    const rpc = await provider();
    const code = await rpc.getCode(STAKING);
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
    log("stakeLog", err.shortMessage || err.message || "Staking action failed", "err");
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
      const next = new ethers.JsonRpcProvider(url, CHAIN_ID, { staticNetwork: true });
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
  const lookback = 60_000;
  const from = Math.max(0, latest - lookback);
  const rows = [];
  let cursor = from;
  let failed = 0;
  while (cursor <= latest && rows.length < 500) {
    const end = Math.min(latest, cursor + 1999);
    try {
      rows.push(...await rpc.getLogs({ address: FEE_ROUTER, fromBlock: cursor, toBlock: end, topics: [SWAP_TOPIC] }));
    } catch {
      failed++;
      let inner = cursor;
      while (inner <= end && rows.length < 500) {
        const innerEnd = Math.min(end, inner + 499);
        try {
          rows.push(...await rpc.getLogs({ address: FEE_ROUTER, fromBlock: inner, toBlock: innerEnd, topics: [SWAP_TOPIC] }));
        } catch {
          failed++;
        }
        inner = innerEnd + 1;
      }
    }
    cursor = end + 1;
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

async function priceAt(token, blockNumber, blockTime) {
  const feed = feedFor(token);
  if (!feed) return null;
  try {
    const data = feedIface.encodeFunctionData("latestRoundData", []);
    const raw = await call(feed.aggregator, data, Math.max(0, blockNumber - 1));
    const decoded = feedIface.decodeFunctionResult("latestRoundData", raw);
    return feedAccepts(decoded, blockTime) ? decoded : null;
  } catch {
    return null;
  }
}

async function loadBoard() {
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
      const feedRow = priced ? await priceAt(priced, row.blockNumber, stamp) : null;
      const score = feedRow
        ? scoreTrade({
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
        })
        : 0n;
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
    state.board = { trades, partial, range, fundedBalance, dailyCap, rewardsReady: rewardCode && rewardCode !== "0x" };
    const days = [...new Set(trades.map((trade) => trade.day))].sort((a, b) => b - a);
    const select = $("boardDay");
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
    await paintBoard();
  } catch (err) {
    setStatus("boardStatus", "The leaderboard could not be read.");
    $("boardCoverage").textContent = "";
    $("boardFund").textContent = "";
    log("boardLog", err.shortMessage || err.message || "Index failed", "err");
  }
}

async function paintBoard() {
  const board = state.board;
  if (!board) return;
  const day = Number($("boardDay").value);
  const dayTrades = board.trades.filter((trade) => trade.day === day);
  const rows = Number.isFinite(day) ? buildDayBoard(dayTrades, { capBzb: board.dailyCap }) : [];
  const body = $("boardBody");
  body.replaceChildren();
  let postedMap = new Map();
  let posted = false;
  let claimable = 0n;
  if (board.rewardsReady && Number.isFinite(day)) {
    const rpc = await provider();
    const rewards = new ethers.Contract(REWARDS, rewardIface.fragments, rpc);
    const info = await rewards.dayInfo(day);
    posted = info.posted;
    if (posted) {
      for (let i = 0; i < 25; i++) {
        const winner = await rewards.winner(day, i);
        if (winner.trader && winner.trader !== ethers.ZeroAddress) postedMap.set(winner.trader.toLowerCase(), winner.amount);
      }
    }
    if (state.account) claimable = await rewards.claimable(day, state.account);
  }
  const funds = rewardState({ fundedBalance: board.fundedBalance, posted, claimable });
  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    const priced = dayTrades.filter((trade) => trade.score > 0n).length;
    const under = dayTrades.filter((trade) => trade.score > 0n && trade.score < MIN_TRADE_USD_E8).length;
    td.textContent = !dayTrades.length
      ? "No BZB buys or sells were indexed for this day."
      : priced
        ? `${dayTrades.length} swaps, ${under} under $25. None stayed on the board.`
        : `${dayTrades.length} swaps had no Chainlink price on either side, so BZB volume there scored zero.`;
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

function showTab(name) {
  for (const tab of ["swap", "stake", "board"]) {
    const button = $(`tab-${tab}`);
    const on = tab === name;
    button.classList.toggle("active", on);
    button.setAttribute("aria-selected", on ? "true" : "false");
  }
  $("swap-layout").hidden = name !== "swap";
  $("pane-stake").hidden = name !== "stake";
  $("pane-board").hidden = name !== "board";
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
  await loadStake();
}

function disconnect() {
  state.leaving = true;
  state.account = null;
  state.chainId = null;
  state.injected = null;
  paintWallet();
  paintBalances();
  loadStake();
  $("walletDrop").hidden = true;
  setTimeout(() => { state.leaving = false; }, 400);
}

const CHART_POOL = "0x6ccd623a2002f5198f7acd94011af1be0a193307";

async function loadChart() {
  $("chartLink").href = `https://www.geckoterminal.com/polygon_pos/pools/${CHART_POOL}`;
  try {
    const response = await fetch(`https://api.geckoterminal.com/api/v2/networks/polygon_pos/pools/${CHART_POOL}`);
    if (!response.ok) throw new Error("chart");
    const body = await response.json();
    const attrs = body.data?.attributes || {};
    const reserve = Number(attrs.reserve_in_usd);
    $("chartLiq").textContent = Number.isFinite(reserve) ? `Liquidity $${reserve.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "Liquidity unavailable";
    const created = Date.parse(attrs.pool_created_at || "");
    $("chartAge").textContent = Number.isFinite(created) ? `Age ${Math.max(0, Math.floor((Date.now() - created) / 86400000))} days` : "Age unavailable";
    if (attrs.name) $("chart-card").querySelector("h3").textContent = String(attrs.name);
  } catch {
    $("chartLiq").textContent = "Liquidity unavailable";
    $("chartAge").textContent = "Age unavailable";
  }
}

function boot() {
  if (ethers.id("AggregatedSwap(address,address,address,address,uint256,uint256,uint256,uint256,bool,uint16,bytes32)").toLowerCase() !== SWAP_TOPIC) {
    log("swapLog", "Swap event signature check failed.", "err");
  }
  fillSelect("tokenIn", NATIVE);
  fillSelect("tokenOut", BZB);
  $("routeDetail").textContent = `${coverage.searched} ${coverage.discovery} ${coverage.notCovered}`;
  document.querySelectorAll(".desk-live .tabs button").forEach((button) => {
    button.addEventListener("click", () => showTab(button.dataset.tab));
  });
  $("tokenIn").addEventListener("change", () => { scheduleQuote(); paintBalances(); });
  $("tokenOut").addEventListener("change", () => { scheduleQuote(); paintBalances(); });
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
    scheduleQuote();
    paintBalances();
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
  $("boardRetry").addEventListener("click", () => { state.board = null; loadBoard(); });
  $("boardDay").addEventListener("change", () => { paintBoard().catch((err) => log("boardLog", err.message || "Could not read the day", "err")); });
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
  loadChart();
  readAllowlist().then(() => refreshQuote()).catch((err) => {
    setStatus("swapStatus", "Could not read the fee router.");
    log("swapLog", err.shortMessage || err.message || "Router read failed", "err");
  });
  loadStake();
}

boot();
