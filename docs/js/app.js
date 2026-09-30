(() => {
  const CFG = window.BLAZARSWAP;
  const ABIS = window.BLAZAR_ABIS;
  const ZERO = "0x0000000000000000000000000000000000000000";
  const $ = (id) => document.getElementById(id);
  const state = { provider: null, signer: null, account: null, chainId: null };
  const configured = () => CFG.router && CFG.router !== ZERO && CFG.factory !== ZERO && CFG.baseToken !== ZERO;
  function tokenByAddress(addr) {
    if (!addr) return null;
    return CFG.tokens.find((t) => t.address.toLowerCase() === addr.toLowerCase()) || { symbol: addr.slice(0, 6), name: "Unknown", address: addr, decimals: 18 };
  }
  function fillSelects() {
    ["tokenIn", "tokenOut", "liqTokenA", "liqTokenB"].forEach((id) => {
      const el = $(id);
      el.innerHTML = "";
      CFG.tokens.forEach((t, i) => {
        const opt = document.createElement("option");
        opt.value = t.address;
        opt.textContent = t.symbol + (t.isBase ? " · BASE" : "");
        el.appendChild(opt);
        if (id === "tokenIn" && t.isBase) el.selectedIndex = i;
        if (id === "tokenOut" && !t.isBase && el.selectedIndex === 0) el.selectedIndex = i;
        if (id === "liqTokenB" && t.isBase) el.selectedIndex = i;
      });
    });
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
  }
  const router = () => new ethers.Contract(CFG.router, ABIS.Router, state.signer || state.provider);
  const factory = () => new ethers.Contract(CFG.factory, ABIS.Factory, state.signer || state.provider);
  const erc20 = (addr) => new ethers.Contract(addr, ABIS.ERC20, state.signer || state.provider);
  async function ensureAllowance(token, owner, spender, amount) {
    if (!spender || spender.toLowerCase() !== CFG.router.toLowerCase()) {
      throw new Error("Approve blocked: spender is not the BlazarSwap router.");
    }
    if (!amount || amount <= 0n) throw new Error("Approve blocked: bad amount.");
    const c = erc20(token);
    const current = await c.allowance(owner, spender);
    if (current >= amount) return;
    setLog("swapLog", "Approve token…");
    const tx = await c.approve(spender, amount);
    await tx.wait();
  }
  async function refreshBalances() {
    if (!state.account || !configured()) return;
    const tin = tokenByAddress($("tokenIn").value);
    const tout = tokenByAddress($("tokenOut").value);
    try {
      const [bin, bout] = await Promise.all([erc20(tin.address).balanceOf(state.account), erc20(tout.address).balanceOf(state.account)]);
      $("balIn").textContent = "Balance " + Number(ethers.formatUnits(bin, tin.decimals)).toPrecision(6);
      $("balOut").textContent = "Balance " + Number(ethers.formatUnits(bout, tout.decimals)).toPrecision(6);
    } catch {
      $("balIn").textContent = "Balance —";
      $("balOut").textContent = "Balance —";
    }
  }
  async function quoteOut() {
    if (!configured() || !state.provider) return;
    const tin = tokenByAddress($("tokenIn").value);
    const tout = tokenByAddress($("tokenOut").value);
    if (!tin || !tout || tin.address === tout.address) return;
    const raw = $("amountIn").value;
    if (!raw || Number(raw) <= 0) { $("amountOut").value = ""; return; }
    const amountIn = parseAmt(raw, tin.decimals);
    const path = [tin.address, tout.address];
    $("routeLabel").textContent = tin.symbol + " → " + tout.symbol;
    try {
      const r = router();
      const amounts = await r.getAmountsOut(amountIn, path);
      const out = amounts[amounts.length - 1];
      $("amountOut").value = ethers.formatUnits(out, tout.decimals);
      let resIn, resOut;
      try {
        [resIn, resOut] = await r.getReserves(tin.address, tout.address);
      } catch {
        const pairAddr = await factory().getPair(tin.address, tout.address);
        const pair = new ethers.Contract(pairAddr, ABIS.Pair, state.provider);
        const token0 = await pair.token0();
        const reserves = await pair.getReserves();
        if (tin.address.toLowerCase() === token0.toLowerCase()) { resIn = reserves[0]; resOut = reserves[1]; }
        else { resIn = reserves[1]; resOut = reserves[0]; }
      }
      const spot = Number(resOut) / Number(resIn);
      const exec = Number(out) / Number(amountIn);
      const impact = ((spot - exec) / spot) * 100;
      $("priceLabel").textContent = "1 " + tin.symbol + " ≈ " + (Number(out) / Number(amountIn)).toPrecision(6) + " " + tout.symbol;
      $("impactLabel").textContent = isFinite(impact) ? impact.toFixed(3) + "%" : "—";
      const slip = Number($("slippage").value || "0.5") / 100;
      const minOut = out - (out * BigInt(Math.floor(slip * 10000))) / 10000n;
      $("minOutLabel").textContent = ethers.formatUnits(minOut, tout.decimals) + " " + tout.symbol;
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
      const path = [tin.address, tout.address];
      const amounts = await router().getAmountsOut(amountIn, path);
      const slip = Number($("slippage").value || "0.5") / 100;
      const minOut = amounts[1] - (amounts[1] * BigInt(Math.floor(slip * 10000))) / 10000n;
      await ensureAllowance(tin.address, state.account, CFG.router, amountIn);
      setLog("swapLog", "Sending swap…");
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
      const tx = await router().swapExactTokensForTokens(amountIn, minOut, path, state.account, deadline);
      setLog("swapLog", "Pending " + tx.hash);
      await tx.wait();
      setLog("swapLog", "Done. " + tx.hash, "ok");
      await refreshBalances();
    } catch (err) {
      setLog("swapLog", err.shortMessage || err.message || String(err), "err");
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
      await ensureAllowance(a.address, state.account, CFG.router, amtA);
      await ensureAllowance(b.address, state.account, CFG.router, amtB);
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
      const minA = amtA - amtA * 50n / 10000n;
      const minB = amtB - amtB * 50n / 10000n;
      setLog("liqLog", "Adding liquidity…");
      const tx = await router().addLiquidity(a.address, b.address, amtA, amtB, minA, minB, state.account, deadline);
      await tx.wait();
      setLog("liqLog", "Done. " + tx.hash, "ok");
      await refreshPairs();
    } catch (err) {
      setLog("liqLog", err.shortMessage || err.message || String(err), "err");
    }
  }
  async function createPair() {
    try {
      if (!state.signer) await connect();
      setLog("liqLog", "Creating pair…");
      const tx = await factory().createPair($("liqTokenA").value, $("liqTokenB").value);
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
      const pct = BigInt(Math.min(100, Math.max(1, Number($("removePct").value || "100"))));
      const liquidity = lpBal * pct / 100n;
      if (liquidity === 0n) throw new Error("No LP tokens.");
      const token0 = await pair.token0();
      const token1 = await pair.token1();
      const current = await pair.allowance(state.account, CFG.router);
      if (current < liquidity) {
        const txA = await pair.approve(CFG.router, liquidity);
        await txA.wait();
      }
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
      const tx = await router().removeLiquidity(token0, token1, liquidity, 0, 0, state.account, deadline);
      await tx.wait();
      setLog("liqLog", "Removed. " + tx.hash, "ok");
      await refreshPairs();
    } catch (err) {
      setLog("liqLog", err.shortMessage || err.message || String(err), "err");
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
      for (let i = 0; i < n; i++) {
        const pairAddr = await fac.allPairs(i);
        const pair = new ethers.Contract(pairAddr, ABIS.Pair, readProvider);
        const [t0, t1, reserves, supply] = await Promise.all([pair.token0(), pair.token1(), pair.getReserves(), pair.totalSupply()]);
        const s0 = tokenByAddress(t0).symbol;
        const s1 = tokenByAddress(t1).symbol;
        const row = document.createElement("div");
        row.className = "pool-row";
        row.innerHTML = "<div><b>" + s0 + " / " + s1 + "</b><div class='mono'>" + short(pairAddr) + "</div></div>" +
          "<div>" + Number(ethers.formatUnits(reserves[0], tokenByAddress(t0).decimals)).toPrecision(4) + " " + s0 + "</div>" +
          "<div>" + Number(ethers.formatUnits(reserves[1], tokenByAddress(t1).decimals)).toPrecision(4) + " " + s1 + "</div>" +
          "<div class='mono'>LP " + Number(ethers.formatUnits(supply, 18)).toPrecision(4) + "</div>";
        list.appendChild(row);
        const opt = document.createElement("option");
        opt.value = pairAddr;
        opt.textContent = s0 + " / " + s1;
        sel.appendChild(opt);
      }
    } catch {
      $("pairCount").textContent = "—";
    }
  }
  function wireUi() {
    fillSelects();
    document.querySelectorAll(".tabs button").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        document.querySelectorAll(".pane").forEach((p) => p.classList.remove("visible"));
        $("pane-" + btn.dataset.tab).classList.add("visible");
      });
    });
    $("connectBtn").addEventListener("click", connect);
    $("swapBtn").addEventListener("click", doSwap);
    $("flipBtn").addEventListener("click", () => {
      const a = $("tokenIn").value;
      $("tokenIn").value = $("tokenOut").value;
      $("tokenOut").value = a;
      $("amountIn").value = $("amountOut").value;
      quoteOut();
      refreshBalances();
    });
    $("amountIn").addEventListener("input", quoteOut);
    $("tokenIn").addEventListener("change", () => { quoteOut(); refreshBalances(); });
    $("tokenOut").addEventListener("change", () => { quoteOut(); refreshBalances(); });
    $("addLiqBtn").addEventListener("click", addLiquidity);
    $("createPairBtn").addEventListener("click", createPair);
    $("removeLiqBtn").addEventListener("click", removeLiquidity);
    if (window.ethereum) {
      window.ethereum.on("accountsChanged", () => connect());
      window.ethereum.on("chainChanged", () => window.location.reload());
    }
    refreshPairs();
  }
  wireUi();
})();
