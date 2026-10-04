(() => {
  const CFG = window.BLAZARSWAP;
  const ABIS = window.BLAZAR_ABIS;
  const ZERO = "0x0000000000000000000000000000000000000000";
  const $ = (id) => document.getElementById(id);
  const state = { provider: null, signer: null, account: null, chainId: null, bal: {} };
  const configured = () => CFG.router && CFG.router !== ZERO && CFG.factory !== ZERO && CFG.baseToken !== ZERO;
  function tokenByAddress(addr) {
    if (!addr) return null;
    return CFG.tokens.find((t) => t.address.toLowerCase() === addr.toLowerCase()) || { symbol: addr.slice(0, 6), name: "Unknown", address: addr, decimals: 18 };
  }
  function routeAddress(token) {
    return token && token.isNative ? CFG.weth : token.address;
  }
  function fillSelects() {
    ["tokenIn", "tokenOut", "liqTokenA", "liqTokenB"].forEach((id) => {
      const el = $(id);
      el.innerHTML = "";
      CFG.tokens.forEach((t) => {
        const opt = document.createElement("option");
        opt.value = t.address;
        opt.textContent = t.symbol + (t.isBase ? " · BASE" : "");
        el.appendChild(opt);
        if (id === "tokenIn" && t.isNative) el.selectedIndex = el.options.length - 1;
        if (id === "tokenOut" && t.isBase) el.selectedIndex = el.options.length - 1;
        if (id === "liqTokenB" && t.isBase) el.selectedIndex = el.options.length - 1;
      });
    });
    paintLiqLabels();
  }
  function paintLiqLabels() {
    const a = $("liqTokenA") && tokenByAddress($("liqTokenA").value);
    const b = $("liqTokenB") && tokenByAddress($("liqTokenB").value);
    if ($("liqLabelA")) $("liqLabelA").textContent = a && a.symbol ? a.symbol : "Token";
    if ($("liqLabelB")) $("liqLabelB").textContent = b && b.symbol ? b.symbol : "Token";
    paintLiqPrices();
  }
  const QUICK = "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff";
  const USDC_PRICE = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
  const USDCE_PRICE = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
  const WETH_PRICE = "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619";
  const usdCache = new Map();
  let usdProvider = null;
  let pxSeq = 0;
  function fmtPx(n) {
    if (!Number.isFinite(n) || n <= 0) return "";
    if (n >= 1) return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: n >= 100 ? 0 : 2 });
    if (n >= 0.01) return "$" + n.toFixed(4);
    return "$" + n.toPrecision(2);
  }
  async function tokenUsd(token) {
    if (!token) return null;
    if (token.symbol === "USDC" || token.symbol === "USDT") return 1;
    const key = (token.isNative ? CFG.weth : token.address).toLowerCase();
    const hit = usdCache.get(key);
    if (hit && Date.now() - hit.at < 30000) return hit.usd;
    if (!usdProvider) usdProvider = new ethers.JsonRpcProvider(CFG.rpcUrl, CFG.chainId, { staticNetwork: true });
    const router = new ethers.Contract(QUICK, ["function getAmountsOut(uint256,address[]) view returns (uint256[])"], usdProvider);
    const sell = token.isNative ? CFG.weth : token.address;
    const unit = 10n ** BigInt(token.decimals || 18);
    const paths = [
      [sell, USDC_PRICE],
      [sell, USDCE_PRICE],
      [sell, CFG.weth, USDC_PRICE],
      [sell, WETH_PRICE, USDC_PRICE],
      [sell, CFG.weth, USDCE_PRICE]
    ];
    for (const path of paths) {
      const clean = [];
      path.forEach((addr) => {
        if (!clean.length || clean[clean.length - 1].toLowerCase() !== String(addr).toLowerCase()) clean.push(addr);
      });
      if (clean.length < 2) continue;
      try {
        const out = await router.getAmountsOut(unit, clean);
        const usd = Number(out[out.length - 1]) / 1e6;
        if (usd > 0 && Number.isFinite(usd)) {
          usdCache.set(key, { usd, at: Date.now() });
          return usd;
        }
      } catch {}
    }
    return null;
  }
  function paintLiqPrices() {
    const seq = ++pxSeq;
    const a = $("liqTokenA") && tokenByAddress($("liqTokenA").value);
    const b = $("liqTokenB") && tokenByAddress($("liqTokenB").value);
    const tin = $("tokenIn") && tokenByAddress($("tokenIn").value);
    const tout = $("tokenOut") && tokenByAddress($("tokenOut").value);
    Promise.all([tokenUsd(a), tokenUsd(b), tokenUsd(tin), tokenUsd(tout)]).then(([pa, pb, pin, pout]) => {
      if (seq !== pxSeq) return;
      if ($("liqPriceA")) $("liqPriceA").textContent = fmtPx(pa);
      if ($("liqPriceB")) $("liqPriceB").textContent = fmtPx(pb);
      if ($("swapPriceIn")) $("swapPriceIn").textContent = fmtPx(pin);
      if ($("swapPriceOut")) $("swapPriceOut").textContent = fmtPx(pout);
    }).catch(() => {});
  }
  function setLog(id, msg, kind) {
    const el = $(id);
    el.textContent = msg;
    el.className = "log" + (kind ? " " + kind : "");
  }
  const short = (addr) => addr ? addr.slice(0, 6) + "…" + addr.slice(-4) : "—";
  function parseAmt(raw, decimals) {
    const v = String(raw || "").trim();
    if (!v || Number(v) === 0) return 0n;
    return ethers.parseUnits(v, decimals);
  }
  async function connect() {
    if (!window.ethereum) { setLog("swapLog", "No wallet found. Install MetaMask.", "err"); return; }
    try { localStorage.removeItem("blazar_logged_out"); } catch {}
    state.provider = new ethers.BrowserProvider(window.ethereum);
    await state.provider.send("eth_requestAccounts", []);
    state.signer = await state.provider.getSigner();
    state.account = await state.signer.getAddress();
    const net = await state.provider.getNetwork();
    state.chainId = Number(net.chainId);
    $("connectBtn").textContent = short(state.account);
    $("networkChip").textContent = state.chainId === CFG.chainId ? CFG.chainName : "CHAIN " + state.chainId;
    if (state.chainId !== CFG.chainId) {
      try {
        await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + CFG.chainId.toString(16) }] });
      } catch (err) {
        if (err.code === 4902) {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: "0x" + CFG.chainId.toString(16),
              chainName: CFG.chainName,
              nativeCurrency: CFG.nativeCurrency,
              rpcUrls: [CFG.rpcUrl],
              blockExplorerUrls: [CFG.explorer]
            }]
          });
        }
      }
    }
    await refreshBalances();
    await refreshPairs();
    quoteOut();
  }
  function closeWalletMenu() {
    const drop = $("walletDrop");
    if (!drop) return;
    drop.hidden = true;
    if ($("connectBtn")) $("connectBtn").setAttribute("aria-expanded", "false");
  }
  function toggleWalletMenu() {
    const drop = $("walletDrop");
    if (!drop) return;
    const open = drop.hidden;
    drop.hidden = !open;
    $("connectBtn").setAttribute("aria-expanded", open ? "true" : "false");
  }
  async function disconnect() {
    closeWalletMenu();
    try { localStorage.setItem("blazar_logged_out", "1"); } catch {}
    try {
      if (window.ethereum && window.ethereum.request) {
        await window.ethereum.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
      }
    } catch {}
    state.account = null;
    state.signer = null;
    state.provider = null;
    state.chainId = null;
    state.bal = {};
    $("connectBtn").textContent = "Connect";
    $("networkChip").textContent = "Not connected";
    ["balIn", "balOut", "balLiqA", "balLiqB"].forEach((id) => { if ($(id)) $(id).textContent = "Balance —"; });
    if ($("balPol")) $("balPol").textContent = "POL —";
    if ($("balWpol")) $("balWpol").textContent = "WPOL —";
    refreshPairs();
  }
  const router = () => new ethers.Contract(CFG.router, ABIS.Router, state.signer || state.provider);
  const factory = () => new ethers.Contract(CFG.factory, ABIS.Factory, state.signer || state.provider);
  const erc20 = (addr) => new ethers.Contract(addr, ABIS.ERC20, state.signer || state.provider);
  function slipBps() {
    const raw = String(($("slippage") && $("slippage").value) || "0.5").replace("%", "").trim();
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return 50;
    return BigInt(Math.min(5000, Math.round(n * 100)));
  }
  function applySlip(amount) {
    const bps = slipBps();
    if (bps <= 0n) return amount;
    const min = amount - (amount * bps) / 10000n;
    return min < 0n ? 0n : min;
  }
  function unitsToInput(amount, decimals) {
    let text = ethers.formatUnits(amount, decimals);
    if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
    return text || "0";
  }
  function syncSlip(value, source) {
    const v = String(value);
    document.querySelectorAll(".slip-input").forEach((el) => { if (el !== source) el.value = v; });
    const n = Number(v);
    document.querySelectorAll("[data-slip]").forEach((btn) => {
      btn.classList.toggle("on", Number(btn.dataset.slip) === n);
    });
    try { localStorage.setItem("blazar_slip", v); } catch {}
  }
  async function ensureAllowance(token, owner, spender, amount, logId) {
    if (!spender || spender.toLowerCase() !== CFG.router.toLowerCase()) {
      throw new Error("Approve blocked: spender is not the BlazarSwap router.");
    }
    if (!amount || amount <= 0n) throw new Error("Approve blocked: bad amount.");
    const c = erc20(token);
    const current = await c.allowance(owner, spender);
    if (current >= amount) return;
    const t = tokenByAddress(token);
    setLog(logId || "swapLog", "Approve " + ethers.formatUnits(amount, t.decimals) + " " + t.symbol + " (exact)");
    const tx = await c.approve(spender, amount);
    await tx.wait();
  }
  function fmtBal(amount, token) {
    const n = Number(ethers.formatUnits(amount, token.decimals));
    let text = "—";
    if (Number.isFinite(n)) {
      if (n === 0) text = "0";
      else if (n >= 1000) text = n.toLocaleString(undefined, { maximumFractionDigits: 2 });
      else if (n >= 1) text = n.toLocaleString(undefined, { maximumFractionDigits: 4 });
      else text = n.toPrecision(4);
    }
    return "Balance " + text + (token.symbol ? " " + token.symbol : "");
  }
  async function refreshBalances() {
    if (!state.account || !configured()) return;
    const rows = [
      ["tokenIn", "balIn"],
      ["tokenOut", "balOut"],
      ["liqTokenA", "balLiqA"],
      ["liqTokenB", "balLiqB"]
    ];
    await Promise.all(rows.map(async ([selId, labId]) => {
      const lab = $(labId);
      const sel = $(selId);
      if (!lab || !sel) return;
      const token = tokenByAddress(sel.value);
      if (!token || !token.address) { lab.textContent = "Balance —"; return; }
      try {
        const bal = token.isNative
          ? await state.provider.getBalance(state.account)
          : await erc20(token.address).balanceOf(state.account);
        state.bal[selId] = bal;
        lab.textContent = fmtBal(bal, token);
      } catch {
        lab.textContent = "Balance —";
      }
    }));
    await refreshWrapBals();
  }
  async function quoteOut() {
    if (!configured() || !state.provider) return;
    const tin = tokenByAddress($("tokenIn").value);
    const tout = tokenByAddress($("tokenOut").value);
    const same = tin && tout && routeAddress(tin).toLowerCase() === routeAddress(tout).toLowerCase();
    if (!tin || !tout || (same && tin.address.toLowerCase() === tout.address.toLowerCase())) {
      $("amountOut").value = "";
      return;
    }
    if (same) {
      const rawSame = $("amountIn").value;
      const wrapping = !!tin.isNative;
      $("routeLabel").textContent = wrapping ? "Wrap POL" : "Unwrap WPOL";
      $("priceLabel").textContent = "1 POL = 1 WPOL";
      $("impactLabel").textContent = "0%";
      if (!rawSame || Number(rawSame) <= 0) { $("amountOut").value = ""; $("minOutLabel").textContent = "—"; return; }
      $("amountOut").value = rawSame;
      $("minOutLabel").textContent = rawSame + " " + tout.symbol;
      if ($("approveLabel")) $("approveLabel").textContent = "None. 1:1 " + (wrapping ? "wrap" : "unwrap") + ".";
      return;
    }
    const raw = $("amountIn").value;
    if (!raw || Number(raw) <= 0) { $("amountOut").value = ""; return; }
    const amountIn = parseAmt(raw, tin.decimals);
    const path = [routeAddress(tin), routeAddress(tout)];
    $("routeLabel").textContent = tin.symbol + (tin.isNative ? " (wrap)" : "") + " → " + tout.symbol + (tout.isNative ? " (unwrap)" : "");
    try {
      const r = router();
      const amounts = await r.getAmountsOut(amountIn, path);
      const out = amounts[amounts.length - 1];
      $("amountOut").value = ethers.formatUnits(out, tout.decimals);
      let resIn, resOut;
      try {
        [resIn, resOut] = await r.getReserves(routeAddress(tin), routeAddress(tout));
      } catch {
        const pairAddr = await factory().getPair(routeAddress(tin), routeAddress(tout));
        const pair = new ethers.Contract(pairAddr, ABIS.Pair, state.provider);
        const token0 = await pair.token0();
        const reserves = await pair.getReserves();
        if (routeAddress(tin).toLowerCase() === token0.toLowerCase()) { resIn = reserves[0]; resOut = reserves[1]; }
        else { resIn = reserves[1]; resOut = reserves[0]; }
      }
      const spot = Number(resOut) / Number(resIn);
      const exec = Number(out) / Number(amountIn);
      const impact = ((spot - exec) / spot) * 100;
      $("priceLabel").textContent = "1 " + tin.symbol + " ≈ " + (Number(out) / Number(amountIn)).toPrecision(6) + " " + tout.symbol;
      $("impactLabel").textContent = isFinite(impact) ? impact.toFixed(3) + "%" : "—";
      const minOut = applySlip(out);
      $("minOutLabel").textContent = ethers.formatUnits(minOut, tout.decimals) + " " + tout.symbol;
      if ($("approveLabel")) $("approveLabel").textContent = tin.isNative ? "None. POL wraps inside this swap." : unitsToInput(amountIn, tin.decimals) + " " + tin.symbol + " exact";
    } catch {
      $("amountOut").value = "";
      $("priceLabel").textContent = "No pool or no liquidity";
      $("impactLabel").textContent = "—";
    }
  }
  async function doSwap() {
    try {
      if (!state.signer) await connect();
      if (!configured()) throw new Error("Set factory and router in js/config.js.");
      const tin = tokenByAddress($("tokenIn").value);
      const tout = tokenByAddress($("tokenOut").value);
      const amountIn = parseAmt($("amountIn").value, tin.decimals);
      if (amountIn === 0n) throw new Error("Enter an input amount.");
      const same = routeAddress(tin).toLowerCase() === routeAddress(tout).toLowerCase();
      if (same) {
        if (tin.address.toLowerCase() === tout.address.toLowerCase()) throw new Error("Pick two different tokens.");
        const wrapped = new ethers.Contract(CFG.weth, ["function deposit() payable", "function withdraw(uint256)"], state.signer);
        setLog("swapLog", tin.isNative ? "Wrapping POL…" : "Unwrapping WPOL…");
        const txw = tin.isNative ? await wrapped.deposit({ value: amountIn }) : await wrapped.withdraw(amountIn);
        setLog("swapLog", "Pending " + txw.hash);
        await txw.wait();
        setLog("swapLog", "Done. " + txw.hash, "ok");
        await refreshBalances();
        return;
      }
      const path = [routeAddress(tin), routeAddress(tout)];
      const amounts = await router().getAmountsOut(amountIn, path);
      const minOut = applySlip(amounts[amounts.length - 1]);
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
      let tx;
      if (tin.isNative) {
        setLog("swapLog", "Wrapping POL and swapping…");
        tx = await router().swapExactETHForTokens(minOut, path, state.account, deadline, { value: amountIn });
      } else if (tout.isNative) {
        await ensureAllowance(tin.address, state.account, CFG.router, amountIn, "swapLog");
        setLog("swapLog", "Swapping and unwrapping to POL…");
        tx = await router().swapExactTokensForETH(amountIn, minOut, path, state.account, deadline);
      } else {
        await ensureAllowance(tin.address, state.account, CFG.router, amountIn, "swapLog");
        setLog("swapLog", "Sending swap…");
        tx = await router().swapExactTokensForTokens(amountIn, minOut, path, state.account, deadline);
      }
      setLog("swapLog", "Pending " + tx.hash);
      await tx.wait();
      setLog("swapLog", "Done. " + tx.hash, "ok");
      await refreshBalances();
    } catch (err) {
      setLog("swapLog", err.shortMessage || err.message || String(err), "err");
    }
  }

  function safeParse(raw, decimals) {
    try { return parseAmt(String(raw || "").trim().replace(/\.$/, ""), decimals); }
    catch { return 0n; }
  }
  let liqQuoteSeq = 0;
  function paintLiqApproval() {
    if (!$("approveLiqLabel")) return;
    const a = tokenByAddress($("liqTokenA").value);
    const b = tokenByAddress($("liqTokenB").value);
    if (!a || !b) return;
    const amtA = safeParse($("liqAmtA").value, a.decimals);
    const amtB = safeParse($("liqAmtB").value, b.decimals);
    const left = amtA > 0n ? unitsToInput(amtA, a.decimals) + " " + a.symbol : "—";
    const right = amtB > 0n ? unitsToInput(amtB, b.decimals) + " " + b.symbol : "—";
    $("approveLiqLabel").textContent = left + " + " + right;
  }
  async function quoteLiq(sourceId) {
    const seq = ++liqQuoteSeq;
    const a = tokenByAddress($("liqTokenA").value);
    const b = tokenByAddress($("liqTokenB").value);
    if (!configured() || !a || !b || routeAddress(a).toLowerCase() === routeAddress(b).toLowerCase()) {
      if (a && b && routeAddress(a).toLowerCase() === routeAddress(b).toLowerCase() && a.address.toLowerCase() !== b.address.toLowerCase()) {
        $("liqLog").textContent = "POL and WPOL are the same asset. Pick another token.";
      }
      return;
    }
    const fromA = sourceId !== "liqAmtB";
    const raw = $(fromA ? "liqAmtA" : "liqAmtB").value;
    const otherEl = $(fromA ? "liqAmtB" : "liqAmtA");
    const otherToken = fromA ? b : a;
    if (!raw || Number(raw) <= 0) { paintLiqApproval(); return; }
    let amount;
    try {
      amount = parseAmt(String(raw).trim().replace(/\.$/, ""), (fromA ? a : b).decimals);
    } catch {
      return;
    }
    if (amount === 0n) { paintLiqApproval(); return; }
    try {
      const provider = state.provider || new ethers.JsonRpcProvider((CFG.rpcUrls && CFG.rpcUrls[0]) || CFG.rpcUrl);
      const r = new ethers.Contract(CFG.router, ABIS.Router, provider);
      const reserves = await r.getReserves(routeAddress(a), routeAddress(b));
      if (seq !== liqQuoteSeq) return;
      const reserveA = reserves[0];
      const reserveB = reserves[1];
      if (reserveA === 0n || reserveB === 0n) {
        $("liqLog").textContent = "New pair. Enter both amounts to set the starting price.";
        $("liqLog").className = "log";
        paintLiqApproval();
        return;
      }
      const reserveIn = fromA ? reserveA : reserveB;
      const reserveOut = fromA ? reserveB : reserveA;
      const quoted = (amount * reserveOut) / reserveIn;
      if (seq !== liqQuoteSeq) return;
      if (quoted === 0n) {
        otherEl.value = "";
        $("liqLog").textContent = "Amount is too small to match this pool 50/50.";
        $("liqLog").className = "log";
        paintLiqApproval();
        return;
      }
      otherEl.value = unitsToInput(quoted, otherToken.decimals);
      $("liqLog").textContent = "Pair exists. Other amount set for a 50/50 deposit.";
      $("liqLog").className = "log";
      paintLiqApproval();
    } catch {
      if (seq !== liqQuoteSeq) return;
      $("liqLog").textContent = "No pair yet. Enter both amounts, or create the pair.";
      $("liqLog").className = "log";
      paintLiqApproval();
    }
  }

  async function addLiquidity() {
    try {
      if (!state.signer) await connect();
      if (!configured()) throw new Error("Set factory and router in js/config.js.");
      const a = tokenByAddress($("liqTokenA").value);
      const b = tokenByAddress($("liqTokenB").value);
      const amtA = parseAmt($("liqAmtA").value, a.decimals);
      const amtB = parseAmt($("liqAmtB").value, b.decimals);
      if (amtA === 0n || amtB === 0n) throw new Error("Both amounts required.");
      if ($("approveLiqLabel")) $("approveLiqLabel").textContent = unitsToInput(amtA, a.decimals) + " " + a.symbol + " + " + unitsToInput(amtB, b.decimals) + " " + b.symbol;
      if (routeAddress(a).toLowerCase() === routeAddress(b).toLowerCase()) throw new Error("POL and WPOL are the same asset.");
      if (a.isNative) {
        setLog("liqLog", "Wrapping POL…");
        const wrapTx = await new ethers.Contract(CFG.weth, ["function deposit() payable"], state.signer).deposit({ value: amtA });
        await wrapTx.wait();
      }
      if (b.isNative) {
        setLog("liqLog", "Wrapping POL…");
        const wrapTx = await new ethers.Contract(CFG.weth, ["function deposit() payable"], state.signer).deposit({ value: amtB });
        await wrapTx.wait();
      }
      const addrA = routeAddress(a);
      const addrB = routeAddress(b);
      await ensureAllowance(addrA, state.account, CFG.router, amtA, "liqLog");
      await ensureAllowance(addrB, state.account, CFG.router, amtB, "liqLog");
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
      const minA = applySlip(amtA);
      const minB = applySlip(amtB);
      setLog("liqLog", "Adding liquidity…");
      const tx = await router().addLiquidity(addrA, addrB, amtA, amtB, minA, minB, state.account, deadline);
      await tx.wait();
      setLog("liqLog", "Done. " + tx.hash, "ok");
      await refreshPairs();
      await refreshBalances();
    } catch (err) {
      setLog("liqLog", err.shortMessage || err.message || String(err), "err");
    }
  }
  async function createPair() {
    try {
      if (!state.signer) await connect();
      setLog("liqLog", "Creating pair…");
      const a = tokenByAddress($("liqTokenA").value);
      const b = tokenByAddress($("liqTokenB").value);
      const tx = await factory().createPair(routeAddress(a), routeAddress(b));
      await tx.wait();
      setLog("liqLog", "Pair created. " + tx.hash, "ok");
      await refreshPairs();
    } catch (err) {
      setLog("liqLog", err.shortMessage || err.message || String(err), "err");
    }
  }
  async function removeLiquidity() {
    try {
      if (!state.signer) await connect();
      const pairAddr = $("removePair").value;
      if (!pairAddr) throw new Error("No pair selected.");
      const pair = new ethers.Contract(pairAddr, ABIS.Pair, state.signer);
      const lpBal = await pair.balanceOf(state.account);
      const pctNum = Math.min(100, Math.max(0, Number($("removePct").value || "0")));
      if (pctNum <= 0) throw new Error("Move the slider above 0%.");
      const pct = BigInt(Math.round(pctNum));
      const liquidity = lpBal * pct / 100n;
      if (liquidity === 0n) throw new Error("No LP tokens.");
      const token0 = await pair.token0();
      const token1 = await pair.token1();
      const current = await pair.allowance(state.account, CFG.router);
      if (current < liquidity) {
        setLog("posLog", "Approve LP tokens (exact share)");
        const txA = await pair.approve(CFG.router, liquidity);
        await txA.wait();
      }
      const reserves = await pair.getReserves();
      const supply = await pair.totalSupply();
      const exp0 = supply === 0n ? 0n : liquidity * reserves[0] / supply;
      const exp1 = supply === 0n ? 0n : liquidity * reserves[1] / supply;
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
      setLog("posLog", "Removing liquidity…");
      const tx = await router().removeLiquidity(token0, token1, liquidity, applySlip(exp0), applySlip(exp1), state.account, deadline);
      await tx.wait();
      setLog("posLog", "Removed. " + tx.hash, "ok");
      await refreshPairs();
    } catch (err) {
      setLog("posLog", err.shortMessage || err.message || String(err), "err");
    }
  }
  async function refreshPairs() {
    const list = $("poolList");
    const sel = $("removePair");
    list.innerHTML = "";
    sel.innerHTML = "";
    if (!configured()) { $("pairCount").textContent = "0"; return; }
    try {
      const readProvider = state.provider || new ethers.JsonRpcProvider((CFG.rpcUrls && CFG.rpcUrls[0]) || CFG.rpcUrl);
      const fac = new ethers.Contract(CFG.factory, ABIS.Factory, readProvider);
      const n = Number(await fac.allPairsLength());
      $("pairCount").textContent = String(n);
      if (!state.account) {
        list.innerHTML = "<div class='mono'>Connect a wallet to see your positions.</div>";
        return;
      }
      let held = 0;
      for (let i = 0; i < n; i++) {
        const pairAddr = await fac.allPairs(i);
        const pair = new ethers.Contract(pairAddr, ABIS.Pair, readProvider);
        const bal = await pair.balanceOf(state.account);
        if (bal === 0n) continue;
        held += 1;
        const [t0, t1, reserves, supply] = await Promise.all([pair.token0(), pair.token1(), pair.getReserves(), pair.totalSupply()]);
        const a = tokenByAddress(t0);
        const b = tokenByAddress(t1);
        const mine0 = supply === 0n ? 0n : (bal * reserves[0]) / supply;
        const mine1 = supply === 0n ? 0n : (bal * reserves[1]) / supply;
        const share = supply === 0n ? "0.00" : (Number((bal * 10000n) / supply) / 100).toFixed(2);
        const row = document.createElement("div");
        row.className = "pool-row";
        row.innerHTML = "<div><b>" + a.symbol + " / " + b.symbol + "</b><div class='mono'>" + short(pairAddr) + "</div></div>" +
          "<div>" + Number(ethers.formatUnits(mine0, a.decimals)).toPrecision(4) + " " + a.symbol + "</div>" +
          "<div>" + Number(ethers.formatUnits(mine1, b.decimals)).toPrecision(4) + " " + b.symbol + "</div>" +
          "<div class='mono'>" + share + "% of pool</div>";
        list.appendChild(row);
        const opt = document.createElement("option");
        opt.value = pairAddr;
        opt.textContent = a.symbol + " / " + b.symbol;
        sel.appendChild(opt);
      }
      if (!held) list.innerHTML = "<div class='mono'>This wallet has no liquidity on BlazarSwap.</div>";
    } catch {
      $("pairCount").textContent = "—";
    }
  }
  const chartCache = {};
  function chartUrl(id, kind) {
    return "https://www.geckoterminal.com/polygon_pos/" + kind + "/" + id + "?embed=1&info=0&swaps=0&light_chart=0&chart_type=price&resolution=15m&bg_color=030712";
  }
  function chartToken(addr) {
    const t = tokenByAddress(addr);
    return t && t.isNative ? CFG.weth : addr;
  }
  async function loadChart(addr) {
    const frame = $("geckoChart");
    if (!frame || !addr) return;
    const a = addr.toLowerCase();
    if (frame.dataset.addr === a) return;
    frame.dataset.addr = a;
    const token = tokenByAddress(addr);
    const link = $("chartLink");
    if (link) {
      link.href = "https://www.geckoterminal.com/polygon_pos/tokens/" + a;
      link.textContent = (token && token.symbol ? token.symbol : "Token") + " on GeckoTerminal";
    }
    let src = chartCache[a] || chartUrl(a, "tokens");
    if (!chartCache[a]) {
      try {
        const res = await fetch("https://api.geckoterminal.com/api/v2/networks/polygon_pos/tokens/" + a + "/pools?page=1");
        if (res.ok) {
          const body = await res.json();
          const pool = body.data && body.data[0] && body.data[0].attributes && body.data[0].attributes.address;
          if (pool) src = chartUrl(String(pool).toLowerCase(), "pools");
        }
      } catch {}
      chartCache[a] = src;
    }
    frame.src = src;
  }
  async function refreshWrapBals() {
    if (!state.account || !$("balPol")) return;
    try {
      const [pol, wrapped] = await Promise.all([
        state.provider.getBalance(state.account),
        erc20(CFG.weth).balanceOf(state.account)
      ]);
      state.bal.pol = pol;
      state.bal.wpol = wrapped;
      $("balPol").textContent = "POL " + unitsToInput(pol, 18);
      $("balWpol").textContent = "WPOL " + unitsToInput(wrapped, 18);
    } catch {
      $("balPol").textContent = "POL —";
      $("balWpol").textContent = "WPOL —";
    }
  }
  async function wrapPol(unwrap) {
    try {
      if (!state.signer) await connect();
      const amt = parseAmt($("wrapAmt").value, 18);
      if (amt === 0n) throw new Error("Enter an amount.");
      const c = new ethers.Contract(CFG.weth, ["function deposit() payable", "function withdraw(uint256)"], state.signer);
      setLog("wrapLog", unwrap ? "Unwrapping WPOL…" : "Wrapping POL…");
      const tx = unwrap ? await c.withdraw(amt) : await c.deposit({ value: amt });
      setLog("wrapLog", "Pending " + tx.hash);
      await tx.wait();
      setLog("wrapLog", (unwrap ? "Unwrapped. " : "Wrapped. ") + tx.hash, "ok");
      await refreshBalances();
    } catch (err) {
      setLog("wrapLog", err.shortMessage || err.message || String(err), "err");
    }
  }
  function wireUi() {
    fillSelects();
    document.querySelectorAll(".desk > .tabs [data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".desk > .tabs [data-tab]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        document.querySelectorAll(".stack > .pane").forEach((p) => p.classList.remove("visible"));
        $("pane-" + btn.dataset.tab).classList.add("visible");
        if (btn.dataset.tab === "add") { paintLiqLabels(); refreshBalances(); }
        if (btn.dataset.tab === "positions") refreshPairs();
        if (btn.dataset.tab === "m421" && window.m421Refresh) window.m421Refresh();
        if (btn.dataset.tab === "draw" && window.drawRefresh) window.drawRefresh();
      });
    });
    $("connectBtn").addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (state.account) toggleWalletMenu();
      else connect();
    });
    $("disconnectBtn").addEventListener("click", (ev) => {
      ev.stopPropagation();
      disconnect();
    });
    document.addEventListener("click", () => closeWalletMenu());
    $("swapBtn").addEventListener("click", doSwap);
    $("flipBtn").addEventListener("click", () => {
      const a = $("tokenIn").value;
      $("tokenIn").value = $("tokenOut").value;
      $("tokenOut").value = a;
      $("amountIn").value = $("amountOut").value;
      $("tokenIn").dispatchEvent(new Event("change"));
      $("tokenOut").dispatchEvent(new Event("change"));
      quoteOut();
      refreshBalances();
      paintLiqPrices();
      loadChart(chartToken($("tokenOut").value));
    });
    async function fillMax(selectId, inputId) {
      if (!state.account) await connect();
      await refreshBalances();
      const token = tokenByAddress($(selectId).value);
      const bal = state.bal[selectId];
      if (!token || bal == null) return;
      const keep = token.isNative ? ethers.parseEther("0.05") : 0n;
      const spend = bal > keep ? bal - keep : 0n;
      $(inputId).value = unitsToInput(token.isNative ? spend : bal, token.decimals);
      if (inputId === "amountIn") quoteOut();
      if (inputId === "liqAmtA" || inputId === "liqAmtB") await quoteLiq(inputId);
    }
    $("maxIn").addEventListener("click", () => fillMax("tokenIn", "amountIn").catch((err) => setLog("swapLog", err.shortMessage || err.message || String(err), "err")));
    $("maxA").addEventListener("click", () => fillMax("liqTokenA", "liqAmtA").catch((err) => setLog("liqLog", err.shortMessage || err.message || String(err), "err")));
    $("maxB").addEventListener("click", () => fillMax("liqTokenB", "liqAmtB").catch((err) => setLog("liqLog", err.shortMessage || err.message || String(err), "err")));
    $("maxRemove").addEventListener("click", () => { $("removePct").value = "100"; paintRemovePct(); });
    $("removePct").addEventListener("input", paintRemovePct);
    function paintRemovePct() {
      const n = Math.min(100, Math.max(0, Math.round(Number($("removePct").value || "0"))));
      if ($("removePctLabel")) $("removePctLabel").textContent = n + "%";
    }
    document.querySelectorAll("[data-slip]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const v = btn.dataset.slip;
        document.querySelectorAll(".slip-input").forEach((el) => { el.value = v; });
        syncSlip(v);
        quoteOut();
      });
    });
    document.querySelectorAll(".slip-input").forEach((el) => {
      el.addEventListener("input", () => { syncSlip(el.value, el); quoteOut(); });
    });
    try {
      const saved = localStorage.getItem("blazar_slip");
      if (saved) { document.querySelectorAll(".slip-input").forEach((el) => { el.value = saved; }); syncSlip(saved); }
    } catch {}
    $("amountIn").addEventListener("input", quoteOut);
    $("tokenIn").addEventListener("change", () => { quoteOut(); refreshBalances(); paintLiqPrices(); });
    $("tokenOut").addEventListener("change", () => { quoteOut(); refreshBalances(); loadChart(chartToken($("tokenOut").value)); paintLiqPrices(); });
    $("liqAmtA").addEventListener("input", () => quoteLiq("liqAmtA"));
    $("liqAmtB").addEventListener("input", () => quoteLiq("liqAmtB"));
    const onLiqToken = () => {
      paintLiqLabels();
      refreshBalances();
      if ($("liqAmtA").value) quoteLiq("liqAmtA");
      else quoteLiq("liqAmtB");
    };
    $("liqTokenA").addEventListener("change", onLiqToken);
    $("liqTokenB").addEventListener("change", onLiqToken);
    $("addLiqBtn").addEventListener("click", addLiquidity);
    $("createPairBtn").addEventListener("click", createPair);
    $("removeLiqBtn").addEventListener("click", removeLiquidity);
    loadChart(chartToken($("tokenOut").value));
    if (window.ethereum) {
      window.ethereum.on("accountsChanged", (accounts) => {
        if (!accounts || !accounts.length) disconnect();
        else connect();
      });
      window.ethereum.on("chainChanged", () => window.location.reload());
      window.ethereum.request({ method: "eth_accounts" }).then((accounts) => {
        let loggedOut = false;
        try { loggedOut = localStorage.getItem("blazar_logged_out") === "1"; } catch {}
        if (accounts && accounts.length && !loggedOut) connect();
      }).catch(() => {});
    }
    refreshPairs();
  }
  wireUi();
})();
