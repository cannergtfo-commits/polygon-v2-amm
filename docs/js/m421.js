(() => {
  const M = {
    chainId: 137,
    rpc: "https://polygon-bor-rpc.publicnode.com",
    explorer: "https://polygonscan.com",
    vault: "0x213C7a13CC3C8A519867FA29cB010c575FBBB4F8",
    share: "0xd2aD34cab1fc6ee954276d28c67E219875397420",
    staking: "0x3d8C5cB54B3E2a18cf6F8015833aAC6B484Df72E",
    bzb: "0x462d8d82c2b2d2ddabf7f8a93928de09d47a5807",
    wbtc: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
    weth: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    wpol: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    quick: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"
  };
  const TOKENS = [
    { key: "pol", label: "POL", address: M.wpol, decimals: 18, native: true },
    { key: "bzb", label: "BzB", address: M.bzb, decimals: 18 },
    { key: "wbtc", label: "WBTC", address: M.wbtc, decimals: 8 },
    { key: "weth", label: "WETH", address: M.weth, decimals: 18 }
  ];
  const ERC20 = ["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)"];
  const VAULT = [
    "function reserveBzb() view returns (uint256)",
    "function reserveWbtc() view returns (uint256)",
    "function reserveWeth() view returns (uint256)",
    "function deposit(uint256,uint256,uint256,uint256,uint256) returns (uint256)",
    "function withdraw(uint256,uint256,uint256,uint256)",
    "function zapIn(address,uint256,uint256,uint256,uint256) returns (uint256)",
    "function zapOut(uint256,address,uint256,uint256)",
    "function values(uint256,uint256,uint256) view returns (uint256,uint256,uint256)"
  ];
  const SHARE = ["function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)"];
  const STAKE = [
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function earned(address) view returns (uint256)",
    "function currentDailyRate() view returns (uint256)",
    "function start() view returns (uint256)",
    "function rewardAllocated() view returns (uint256)",
    "function stake(uint256)",
    "function withdraw(uint256)",
    "function getReward()",
    "function exit()"
  ];
  const $ = (id) => document.getElementById(id);
  let signer = null;
  let account = null;
  let px = null;

  function trim(value, digits) {
    const n = Number(value);
    if (!Number.isFinite(n)) return value;
    return n.toLocaleString(undefined, { maximumFractionDigits: digits });
  }
  function setLog(msg, kind) {
    const el = $("m421Log");
    if (!el) return;
    el.textContent = msg;
    el.className = "log" + (kind ? " " + kind : "");
  }
  function read() {
    return new ethers.JsonRpcProvider(M.rpc, M.chainId, { staticNetwork: true });
  }
  async function loadPrices(provider) {
    const router = new ethers.Contract(M.quick, ["function getAmountsOut(uint256,address[]) view returns (uint256[])"], provider);
    const btcFeed = new ethers.Contract(BTC_USD, FEED, provider);
    const ethFeed = new ethers.Contract(ETH_USD, FEED, provider);
    const [spot, btcRound, ethRound] = await Promise.all([
      router.getAmountsOut(10n ** 18n, [M.bzb, USDC]),
      btcFeed.latestRoundData(),
      ethFeed.latestRoundData()
    ]);
    return { usdPerBzb: spot[1] * 100n, btcPrice: BigInt(btcRound[1]), ethPrice: BigInt(ethRound[1]) };
  }
  function usdOf(kind, amount, prices) {
    if (!prices || amount === 0n) return 0n;
    if (kind === "bzb") return (amount * prices.usdPerBzb) / 10n ** 18n;
    if (kind === "wbtc") return (amount * prices.btcPrice) / 10n ** 8n;
    return (amount * prices.ethPrice) / 10n ** 18n;
  }
  function fmtUsd(usd8) {
    const n = Number(usd8) / 1e8;
    if (!Number.isFinite(n)) return "—";
    if (n > 0 && n < 0.01) return "$" + n.toPrecision(2);
    return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  }
  function paintInputUsd() {
    if (!px) return;
    ["bzb", "wbtc", "weth"].forEach((kind) => {
      const el = $("m421In" + kind[0].toUpperCase() + kind.slice(1) + "Usd");
      if (!el) return;
      let amount = 0n;
      try { amount = ethers.parseUnits(String($(fields[kind].id).value || "0").trim() || "0", fields[kind].dec); } catch { amount = 0n; }
      el.textContent = fmtUsd(usdOf(kind, amount, px));
    });
  }
  async function loadDesk() {
    const provider = read();
    const vault = new ethers.Contract(M.vault, VAULT, provider);
    const share = new ethers.Contract(M.share, SHARE, provider);
    const staking = new ethers.Contract(M.staking, STAKE, provider);
    const bzb = new ethers.Contract(M.bzb, ERC20, provider);
    const [rb, rt, re, supply, staked, daily, start, funded, allocated] = await Promise.all([
      vault.reserveBzb(), vault.reserveWbtc(), vault.reserveWeth(), share.totalSupply(),
      staking.totalSupply(), staking.currentDailyRate(), staking.start(),
      bzb.balanceOf(M.staking), staking.rewardAllocated()
    ]);
    $("m421Bzb").textContent = trim(ethers.formatUnits(rb, 18), 4);
    $("m421Wbtc").textContent = trim(ethers.formatUnits(rt, 8), 6);
    $("m421Weth").textContent = trim(ethers.formatUnits(re, 18), 6);
    $("m421Supply").textContent = trim(ethers.formatUnits(supply, 18), 4) + " M421";
    try {
      px = await loadPrices(provider);
      $("m421BzbUsd").textContent = fmtUsd(usdOf("bzb", rb, px));
      $("m421WbtcUsd").textContent = fmtUsd(usdOf("wbtc", rt, px));
      $("m421WethUsd").textContent = fmtUsd(usdOf("weth", re, px));
      paintInputUsd();
    } catch {
      $("m421BzbUsd").textContent = "—";
      $("m421WbtcUsd").textContent = "—";
      $("m421WethUsd").textContent = "—";
    }
    const now = Math.floor(Date.now() / 1000);
    const day = now <= Number(start) ? 1 : Math.floor((now - Number(start)) / 86400) + 1;
    const available = funded > allocated ? funded - allocated : 0n;
    $("m421Rate").textContent = trim(ethers.formatUnits(daily, 18), 0) + " BzB / day";
    $("m421Fund").textContent = "Day " + day + " · " + trim(ethers.formatUnits(available, 18), 2) + " BzB funded · " + trim(ethers.formatUnits(staked, 18), 4) + " M421 staked";
    if (account) {
      const [shares, mine, earned] = await Promise.all([
        share.balanceOf(account), staking.balanceOf(account), staking.earned(account)
      ]);
      $("m421Pos").textContent = trim(ethers.formatUnits(shares, 18), 4) + " M421 free · " + trim(ethers.formatUnits(mine, 18), 4) + " staked · " + trim(ethers.formatUnits(earned, 18), 4) + " BzB earned";
    }
  }
  async function wallet() {
    if (!window.ethereum) throw new Error("No wallet found. Connect one at the top of the page.");
    const provider = new ethers.BrowserProvider(window.ethereum);
    const net = await provider.getNetwork();
    if (Number(net.chainId) !== M.chainId) {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x89" }] });
    }
    await provider.send("eth_requestAccounts", []);
    signer = await provider.getSigner();
    account = await signer.getAddress();
    $("m421Account").textContent = account.slice(0, 6) + "…" + account.slice(-4);
    return signer;
  }
  async function approve(token, spender, amount) {
    const erc = new ethers.Contract(token, ERC20, signer);
    const current = await erc.allowance(account, spender);
    if (current >= amount) return;
    const tx = await erc.approve(spender, amount);
    await tx.wait();
  }
  function tokenByKey(key) {
    return TOKENS.find((t) => t.key === key);
  }
  function show(mode) {
    ["deposit", "withdraw", "stake"].forEach((name) => {
      $("m421-" + name).hidden = name !== mode;
      $("m421tab-" + name).classList.toggle("active", name === mode);
    });
  }

  document.querySelectorAll("[data-m421tab]").forEach((btn) => {
    btn.addEventListener("click", () => show(btn.getAttribute("data-m421tab")));
  });
  $("m421Account").addEventListener("click", async () => {
    try { await wallet(); await loadDesk(); setLog("Wallet ready.", "ok"); }
    catch (err) { setLog(err.shortMessage || err.message, "err"); }
  });
  $("m421Deposit").addEventListener("click", async () => {
    try {
      await wallet();
      const bzb = ethers.parseUnits($("m421AmtBzb").value || "0", 18);
      const wbtc = ethers.parseUnits($("m421AmtWbtc").value || "0", 8);
      const weth = ethers.parseUnits($("m421AmtWeth").value || "0", 18);
      if (bzb === 0n || wbtc === 0n || weth === 0n) throw new Error("Enter all three amounts.");
      const reader = new ethers.Contract(M.vault, VAULT, read());
      const supply = await new ethers.Contract(M.share, SHARE, read()).totalSupply();
      if (supply === 0n) {
        const [va, vb, vc] = await reader.values(bzb, wbtc, weth);
        const hi = va > vb ? (va > vc ? va : vc) : (vb > vc ? vb : vc);
        const lo = va < vb ? (va < vc ? va : vc) : (vb < vc ? vb : vc);
        if (lo === 0n) throw new Error("One amount is too small to price. Use a larger deposit.");
        const drift = ((hi - lo) * 10000n) / hi;
        if (drift > 500n) throw new Error("Not equal value. Those three are " + (Number(drift) / 100).toFixed(2) + "% apart. The BzB pool is small, so use a smaller amount and let the other two fill.");
        if (va + vb + vc < 1000000000n) throw new Error("The first deposit has to be at least $10 in total.");
      }
      setLog("Approving basket tokens…");
      await approve(M.bzb, M.vault, bzb);
      await approve(M.wbtc, M.vault, wbtc);
      await approve(M.weth, M.vault, weth);
      setLog("Depositing…");
      const tx = await new ethers.Contract(M.vault, VAULT, signer).deposit(bzb, wbtc, weth, 0, 500);
      await tx.wait();
      setLog("Deposited. M421 is in your wallet.", "ok");
      await loadDesk();
    } catch (err) { setLog(err.shortMessage || err.message, "err"); }
  });
  $("m421ZapIn").addEventListener("click", async () => {
    try {
      await wallet();
      const token = tokenByKey($("m421ZapToken").value);
      const amount = ethers.parseUnits($("m421ZapAmt").value || "0", token.decimals);
      if (amount === 0n) throw new Error("Enter a zap amount.");
      let zapToken = token.address;
      let zapAmount = amount;
      if (token.native) {
        setLog("Buying WETH with POL…");
        const quick = new ethers.Contract(M.quick, [
          "function getAmountsOut(uint256,address[]) view returns (uint256[])",
          "function swapExactETHForTokens(uint256,address[],address,uint256) payable returns (uint256[])"
        ], signer);
        const weth = new ethers.Contract(M.weth, ERC20, signer);
        const before = await weth.balanceOf(account);
        const quoted = await quick.getAmountsOut(amount, [M.wpol, M.weth]);
        const minOut = (quoted[quoted.length - 1] * 97n) / 100n;
        const swapTx = await quick.swapExactETHForTokens(minOut, [M.wpol, M.weth], account, Math.floor(Date.now() / 1000) + 1200, { value: amount });
        await swapTx.wait();
        zapAmount = (await weth.balanceOf(account)) - before;
        if (zapAmount <= 0n) throw new Error("POL swap returned no WETH.");
        zapToken = M.weth;
      }
      setLog("Swapping into the basket…");
      await approve(zapToken, M.vault, zapAmount);
      const tx = await new ethers.Contract(M.vault, VAULT, signer).zapIn(zapToken, zapAmount, 0, 300, 1500);
      await tx.wait();
      setLog("Zap deposited.", "ok");
      await loadDesk();
    } catch (err) { setLog(err.shortMessage || err.message, "err"); }
  });
  $("m421Withdraw").addEventListener("click", async () => {
    try {
      await wallet();
      const shares = ethers.parseUnits($("m421Shares").value || "0", 18);
      if (shares === 0n) throw new Error("Enter an M421 amount.");
      const tx = await new ethers.Contract(M.vault, VAULT, signer).withdraw(shares, 0, 0, 0);
      await tx.wait();
      setLog("Your share of BzB, WBTC, and WETH is back.", "ok");
      await loadDesk();
    } catch (err) { setLog(err.shortMessage || err.message, "err"); }
  });
  $("m421ZapOut").addEventListener("click", async () => {
    try {
      await wallet();
      const token = tokenByKey($("m421ZapOutToken").value);
      const shares = ethers.parseUnits($("m421Shares").value || "0", 18);
      if (shares === 0n) throw new Error("Enter an M421 amount.");
      const tx = await new ethers.Contract(M.vault, VAULT, signer).zapOut(shares, token.address, 0, 300);
      await tx.wait();
      setLog("Withdrew into " + token.label + ".", "ok");
      await loadDesk();
    } catch (err) { setLog(err.shortMessage || err.message, "err"); }
  });
  $("m421Stake").addEventListener("click", async () => {
    try {
      await wallet();
      const amount = ethers.parseUnits($("m421StakeAmt").value || "0", 18);
      if (amount === 0n) throw new Error("Enter an M421 amount.");
      await approve(M.share, M.staking, amount);
      const tx = await new ethers.Contract(M.staking, STAKE, signer).stake(amount);
      await tx.wait();
      setLog("Staked.", "ok");
      await loadDesk();
    } catch (err) { setLog(err.shortMessage || err.message, "err"); }
  });
  $("m421Unstake").addEventListener("click", async () => {
    try {
      await wallet();
      const amount = ethers.parseUnits($("m421StakeAmt").value || "0", 18);
      if (amount === 0n) throw new Error("Enter an M421 amount.");
      const tx = await new ethers.Contract(M.staking, STAKE, signer).withdraw(amount);
      await tx.wait();
      setLog("Unstaked.", "ok");
      await loadDesk();
    } catch (err) { setLog(err.shortMessage || err.message, "err"); }
  });
  $("m421Claim").addEventListener("click", async () => {
    try {
      await wallet();
      const tx = await new ethers.Contract(M.staking, STAKE, signer).getReward();
      await tx.wait();
      setLog("BzB claimed.", "ok");
      await loadDesk();
    } catch (err) { setLog(err.shortMessage || err.message, "err"); }
  });
  $("m421Exit").addEventListener("click", async () => {
    try {
      await wallet();
      const tx = await new ethers.Contract(M.staking, STAKE, signer).exit();
      await tx.wait();
      setLog("Exited.", "ok");
      await loadDesk();
    } catch (err) { setLog(err.shortMessage || err.message, "err"); }
  });

  const USDC = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
  const BTC_USD = "0xc907e116054ad103354f2d350fd2514433d57f6f";
  const ETH_USD = "0xf9680d99d6c9589e2a93a78a04a279e509205945";
  const FEED = ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"];
  const fields = {
    bzb: { id: "m421AmtBzb", dec: 18 },
    wbtc: { id: "m421AmtWbtc", dec: 8 },
    weth: { id: "m421AmtWeth", dec: 18 }
  };
  let fillLock = false;
  let fillSeq = 0;
  let fillTimer = null;
  function showUnits(amount, decimals) {
    const s = ethers.formatUnits(amount, decimals);
    return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
  }
  async function bzbForUsd(provider, router, targetUsd) {
    const factory = new ethers.Contract("0x5757371414417b8c6caad45baef941abc7d3ab32", ["function getPair(address,address) view returns (address)"], provider);
    const pairAddr = await factory.getPair(M.bzb, USDC);
    if (!pairAddr || pairAddr === ethers.ZeroAddress) throw new Error("No BzB/USDC pool to price the basket.");
    const pair = new ethers.Contract(pairAddr, [
      "function getReserves() view returns (uint112,uint112,uint32)",
      "function token0() view returns (address)"
    ], provider);
    const [reserves, token0] = await Promise.all([pair.getReserves(), pair.token0()]);
    const usdcSide = token0.toLowerCase() === USDC.toLowerCase();
    const reserveOut = usdcSide ? reserves[0] : reserves[1];
    const reserveIn = usdcSide ? reserves[1] : reserves[0];
    const amountOut = targetUsd / 100n;
    if (amountOut === 0n || amountOut >= reserveOut) {
      const cap = Number((reserveOut - 1n) * 100n) / 1e8;
      throw new Error("BzB's pool can only match about $" + cap.toFixed(2) + " per token. Use a smaller amount.");
    }
    let guess = (amountOut * reserveIn * 1000n) / ((reserveOut - amountOut) * 997n) + 1n;
    const quoted = (await router.getAmountsOut(guess, [M.bzb, USDC]))[1] * 100n;
    if (quoted > 0n && quoted !== targetUsd) guess = (guess * targetUsd) / quoted;
    if (guess === 0n) throw new Error("Amount is too small to match BzB.");
    return guess;
  }
  async function quoteEqual(source) {
    const seq = ++fillSeq;
    const raw = String($(fields[source].id).value || "").trim();
    const others = Object.keys(fields).filter((k) => k !== source);
    if (!raw || Number(raw) === 0) {
      fillLock = true;
      others.forEach((k) => { $(fields[k].id).value = ""; });
      fillLock = false;
      paintInputUsd();
      return;
    }
    const amount = ethers.parseUnits(raw, fields[source].dec);
    const provider = read();
    const vault = new ethers.Contract(M.vault, VAULT.concat(["function router() view returns (address)"]), provider);
    const share = new ethers.Contract(M.share, SHARE, provider);
    const [rb, rt, re, supply, routerAddr] = await Promise.all([
      vault.reserveBzb(), vault.reserveWbtc(), vault.reserveWeth(), share.totalSupply(), vault.router()
    ]);
    if (seq !== fillSeq) return;
    const reserves = { bzb: rb, wbtc: rt, weth: re };
    const out = {};
    let note = "Matched to equal value.";
    if (supply > 0n && rb > 0n && rt > 0n && re > 0n) {
      if (reserves[source] === 0n) return;
      others.forEach((k) => { out[k] = (amount * reserves[k]) / reserves[source]; });
      note = "Matched to the basket.";
    } else {
      const router = new ethers.Contract(routerAddr, ["function getAmountsOut(uint256,address[]) view returns (uint256[])"], provider);
      const btcFeed = new ethers.Contract(BTC_USD, FEED, provider);
      const ethFeed = new ethers.Contract(ETH_USD, FEED, provider);
      const one = 10n ** 18n;
      const [, btcPx] = await btcFeed.latestRoundData();
      const [, ethPx] = await ethFeed.latestRoundData();
      const btcPrice = BigInt(btcPx);
      const ethPrice = BigInt(ethPx);
      const spot = await router.getAmountsOut(one, [M.bzb, USDC]);
      const usdPerBzb = spot[1] * 100n;
      if (usdPerBzb === 0n || btcPrice <= 0n || ethPrice <= 0n) throw new Error("Price unavailable.");
      let usd;
      if (source === "bzb") usd = (await router.getAmountsOut(amount, [M.bzb, USDC]))[1] * 100n;
      else if (source === "wbtc") usd = (amount * btcPrice) / 10n ** 8n;
      else usd = (amount * ethPrice) / one;
      if (usd === 0n) return;
      if (source !== "bzb") out.bzb = await bzbForUsd(provider, router, usd);
      if (source !== "wbtc") out.wbtc = (usd * 10n ** 8n) / btcPrice;
      if (source !== "weth") out.weth = (usd * one) / ethPrice;
    }
    if (seq !== fillSeq) return;
    fillLock = true;
    others.forEach((k) => { $(fields[k].id).value = out[k] > 0n ? showUnits(out[k], fields[k].dec) : ""; });
    fillLock = false;
    paintInputUsd();
    setLog(note);
  }
  function scheduleFill(source) {
    if (fillLock) return;
    paintInputUsd();
    clearTimeout(fillTimer);
    fillTimer = setTimeout(() => {
      quoteEqual(source).catch((err) => setLog(err.shortMessage || err.message || "Could not match the basket.", "err"));
    }, 350);
  }
  $("m421AmtBzb").addEventListener("input", () => scheduleFill("bzb"));
  $("m421AmtWbtc").addEventListener("input", () => scheduleFill("wbtc"));
  $("m421AmtWeth").addEventListener("input", () => scheduleFill("weth"));

  loadDesk().catch((err) => setLog(err.shortMessage || err.message || "Desk unavailable", "err"));
})();
