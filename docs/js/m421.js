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
    weth: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"
  };
  const TOKENS = [
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
    "function zapOut(uint256,address,uint256,uint256)"
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
      setLog("Swapping into the basket…");
      await approve(token.address, M.vault, amount);
      const tx = await new ethers.Contract(M.vault, VAULT, signer).zapIn(token.address, amount, 0, 300, 1500);
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

  loadDesk().catch((err) => setLog(err.shortMessage || err.message || "Desk unavailable", "err"));
})();
