const ABI = {
  erc20: ["function decimals() view returns (uint8)","function symbol() view returns (string)","function balanceOf(address) view returns (uint256)","function allowance(address,address) view returns (uint256)","function approve(address,uint256) returns (bool)"],
  factory: ["function feeTo() view returns (address)","function getPair(address,address) view returns (address)"],
  pair: ["function getReserves() view returns (uint112,uint112,uint32)","function balanceOf(address) view returns (uint256)","function allowance(address,address) view returns (uint256)","function approve(address,uint256) returns (bool)"],
  router: ["function WETH() view returns (address)","function getAmountsOut(uint256,address[]) view returns (uint256[])","function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) returns (uint256,uint256,uint256)","function addLiquidityETH(address,uint256,uint256,uint256,address,uint256) payable returns (uint256,uint256,uint256)","function removeLiquidity(address,address,uint256,uint256,uint256,address,uint256) returns (uint256,uint256)","function removeLiquidityETH(address,uint256,uint256,uint256,address,uint256) returns (uint256,uint256)","function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])","function swapExactETHForTokens(uint256,address[],address,uint256) payable returns (uint256[])","function swapExactTokensForETH(uint256,uint256,address[],address,uint256) returns (uint256[])"]
};
const NATIVE = "native";
let provider, signer, account;
const $ = (id) => document.getElementById(id);
const cfg = () => window.DEX || {};
const isZero = (addr) => !addr || /^0x0+$/i.test(addr);
function tokens() {
  const list = [{ symbol: cfg().nativeSymbol || "POL", address: NATIVE, decimals: 18 }];
  for (const t of cfg().tokens || []) list.push(t);
  const seen = new Set();
  return list.filter((t) => { const k = (t.address || "").toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}
function fillSelects() {
  const html = tokens().map((t) => `<option value="${t.address}">${t.symbol}</option>`).join("");
  ["tokenIn","tokenOut","tokenA","tokenB"].forEach((id) => { $(id).innerHTML = html; });
  $("tokenOut").selectedIndex = Math.min(1, $("tokenOut").options.length - 1);
  $("tokenB").selectedIndex = Math.min(1, $("tokenB").options.length - 1);
}
function tokenMeta(addr) {
  return tokens().find((t) => t.address.toLowerCase() === addr.toLowerCase()) || { symbol: "TKN", address: addr, decimals: 18 };
}
function pathFor(from, to) {
  const weth = cfg().weth;
  const a = from === NATIVE ? weth : from;
  const b = to === NATIVE ? weth : to;
  if (!a || !b || a.toLowerCase() === b.toLowerCase()) throw new Error("Pick two different tokens");
  return [ethers.getAddress(a), ethers.getAddress(b)];
}
async function connect() {
  if (!window.ethereum) throw new Error("No wallet found");
  provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  const net = await provider.getNetwork();
  if (cfg().chainId && Number(net.chainId) !== Number(cfg().chainId)) {
    const hex = "0x" + Number(cfg().chainId).toString(16);
    try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }); }
    catch { throw new Error("Switch wallet to Polygon (137)"); }
    provider = new ethers.BrowserProvider(window.ethereum);
  }
  signer = await provider.getSigner();
  account = await signer.getAddress();
  $("connectBtn").textContent = account.slice(0, 6) + "\u2026" + account.slice(-4);
  $("connectBtn").classList.add("connected");
  $("swapBtn").disabled = false; $("addBtn").disabled = false; $("removeBtn").disabled = false;
  $("swapBtn").textContent = "Swap";
  await refreshBalances();
}
function router() {
  if (isZero(cfg().router)) throw new Error("Paste Factory/Router into config.js after Remix deploy");
  return new ethers.Contract(cfg().router, ABI.router, signer || provider);
}
function erc20(addr) { return new ethers.Contract(addr, ABI.erc20, signer || provider); }
async function ensureAllowance(token, owner, spender, amount) {
  const c = erc20(token).connect(signer);
  const current = await c.allowance(owner, spender);
  if (current >= amount) return;
  const tx = await c.approve(spender, ethers.MaxUint256);
  await tx.wait();
}
async function quote() {
  const amount = $("amountIn").value;
  if (!amount || Number(amount) <= 0) { $("amountOut").value = ""; return; }
  try {
    const from = $("tokenIn").value, to = $("tokenOut").value;
    const p = pathFor(from, to);
    const decIn = from === NATIVE ? 18 : Number(tokenMeta(from).decimals || 18);
    const decOut = to === NATIVE ? 18 : Number(tokenMeta(to).decimals || 18);
    const amt = ethers.parseUnits(amount, decIn);
    const amounts = await router().getAmountsOut(amt, p);
    $("amountOut").value = ethers.formatUnits(amounts[amounts.length - 1], decOut);
    $("swapStatus").textContent = ""; $("swapStatus").classList.remove("err");
  } catch (e) {
    $("amountOut").value = "";
    $("swapStatus").textContent = e.shortMessage || e.message || String(e);
    $("swapStatus").classList.add("err");
  }
}
function setStatus(id, msg, err) { $(id).textContent = msg; $(id).classList.toggle("err", !!err); }
async function doSwap() {
  setStatus("swapStatus", "");
  try {
    if (!signer) await connect();
    const from = $("tokenIn").value, to = $("tokenOut").value;
    const p = pathFor(from, to);
    const decIn = from === NATIVE ? 18 : Number(tokenMeta(from).decimals || 18);
    const amt = ethers.parseUnits($("amountIn").value, decIn);
    const quoted = await router().getAmountsOut(amt, p);
    const minOut = (quoted[quoted.length - 1] * 995n) / 1000n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
    let tx;
    if (from === NATIVE) tx = await router().connect(signer).swapExactETHForTokens(minOut, p, account, deadline, { value: amt });
    else if (to === NATIVE) { await ensureAllowance(from, account, cfg().router, amt); tx = await router().connect(signer).swapExactTokensForETH(amt, minOut, p, account, deadline); }
    else { await ensureAllowance(from, account, cfg().router, amt); tx = await router().connect(signer).swapExactTokensForTokens(amt, minOut, p, account, deadline); }
    setStatus("swapStatus", "Submitted " + tx.hash);
    await tx.wait(); setStatus("swapStatus", "Swap confirmed"); await refreshBalances();
  } catch (e) { setStatus("swapStatus", e.shortMessage || e.message || String(e), true); }
}
async function addLiquidity() {
  setStatus("poolStatus", "");
  try {
    if (!signer) await connect();
    const a = $("tokenA").value, b = $("tokenB").value;
    if (a === b) throw new Error("Pick two different tokens");
    const decA = a === NATIVE ? 18 : Number(tokenMeta(a).decimals || 18);
    const decB = b === NATIVE ? 18 : Number(tokenMeta(b).decimals || 18);
    const amtA = ethers.parseUnits($("liqA").value || "0", decA);
    const amtB = ethers.parseUnits($("liqB").value || "0", decB);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
    let tx;
    if (a === NATIVE || b === NATIVE) {
      const token = a === NATIVE ? b : a;
      const tokenAmt = a === NATIVE ? amtB : amtA;
      const ethAmt = a === NATIVE ? amtA : amtB;
      await ensureAllowance(token, account, cfg().router, tokenAmt);
      tx = await router().connect(signer).addLiquidityETH(token, tokenAmt, 0, 0, account, deadline, { value: ethAmt });
    } else {
      await ensureAllowance(a, account, cfg().router, amtA);
      await ensureAllowance(b, account, cfg().router, amtB);
      tx = await router().connect(signer).addLiquidity(a, b, amtA, amtB, 0, 0, account, deadline);
    }
    setStatus("poolStatus", "Submitted " + tx.hash);
    await tx.wait(); setStatus("poolStatus", "Liquidity added"); await refreshBalances();
  } catch (e) { setStatus("poolStatus", e.shortMessage || e.message || String(e), true); }
}
async function removeLiquidity() {
  setStatus("poolStatus", "");
  try {
    if (!signer) await connect();
    const a = $("tokenA").value, b = $("tokenB").value;
    const factory = new ethers.Contract(cfg().factory, ABI.factory, provider);
    const ta = a === NATIVE ? cfg().weth : a;
    const tb = b === NATIVE ? cfg().weth : b;
    const pairAddr = await factory.getPair(ta, tb);
    if (isZero(pairAddr)) throw new Error("Pair does not exist");
    const pair = new ethers.Contract(pairAddr, ABI.pair, signer);
    const lp = ethers.parseUnits($("lpAmt").value || "0", 18);
    if ((await pair.allowance(account, cfg().router)) < lp) { await (await pair.approve(cfg().router, ethers.MaxUint256)).wait(); }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
    let tx;
    if (a === NATIVE || b === NATIVE) tx = await router().connect(signer).removeLiquidityETH(a === NATIVE ? b : a, lp, 0, 0, account, deadline);
    else tx = await router().connect(signer).removeLiquidity(a, b, lp, 0, 0, account, deadline);
    setStatus("poolStatus", "Submitted " + tx.hash);
    await tx.wait(); setStatus("poolStatus", "Liquidity removed"); await refreshBalances();
  } catch (e) { setStatus("poolStatus", e.shortMessage || e.message || String(e), true); }
}
async function refreshBalances() {
  if (!provider || !account) return;
  try {
    $("balIn").textContent = "Balance: " + (await formatBal($("tokenIn").value));
    $("balOut").textContent = "Balance: " + (await formatBal($("tokenOut").value));
    const factory = new ethers.Contract(cfg().factory, ABI.factory, provider);
    const a = $("tokenA").value === NATIVE ? cfg().weth : $("tokenA").value;
    const b = $("tokenB").value === NATIVE ? cfg().weth : $("tokenB").value;
    if (!isZero(cfg().factory) && a && b && a.toLowerCase() !== b.toLowerCase()) {
      const pairAddr = await factory.getPair(a, b);
      if (!isZero(pairAddr)) {
        const pair = new ethers.Contract(pairAddr, ABI.pair, provider);
        $("lpBal").textContent = "LP balance: " + ethers.formatUnits(await pair.balanceOf(account), 18);
      } else $("lpBal").textContent = "No pair yet";
    }
  } catch {}
}
async function formatBal(addr) {
  if (addr === NATIVE) return Number(ethers.formatEther(await provider.getBalance(account))).toPrecision(6) + " " + (cfg().nativeSymbol || "POL");
  const t = tokenMeta(addr);
  return Number(ethers.formatUnits(await erc20(addr).balanceOf(account), t.decimals || 18)).toPrecision(6) + " " + (t.symbol || "");
}
function boot() {
  $("brandName").textContent = cfg().name || "V2 Exchange";
  document.title = cfg().name || "V2 Exchange";
  $("feeToLabel").textContent = cfg().feeTo || "";
  fillSelects();
  document.querySelectorAll("nav button").forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll("nav button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      $("swapTab").classList.toggle("hidden", btn.dataset.tab !== "swap");
      $("poolTab").classList.toggle("hidden", btn.dataset.tab !== "pool");
    };
  });
  $("connectBtn").onclick = () => connect().catch((e) => setStatus("swapStatus", e.message, true));
  $("flipBtn").onclick = () => { const a = $("tokenIn").value; $("tokenIn").value = $("tokenOut").value; $("tokenOut").value = a; quote(); refreshBalances(); };
  $("amountIn").addEventListener("input", quote);
  $("tokenIn").addEventListener("change", () => { quote(); refreshBalances(); });
  $("tokenOut").addEventListener("change", () => { quote(); refreshBalances(); });
  $("tokenA").addEventListener("change", refreshBalances);
  $("tokenB").addEventListener("change", refreshBalances);
  $("swapBtn").onclick = doSwap; $("addBtn").onclick = addLiquidity; $("removeBtn").onclick = removeLiquidity;
  if (window.ethereum) { window.ethereum.on("accountsChanged", () => location.reload()); window.ethereum.on("chainChanged", () => location.reload()); }
}
boot();
