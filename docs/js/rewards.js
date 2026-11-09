(() => {
  const CFG = window.BLAZARSWAP;
  const $ = (id) => document.getElementById(id);
  const ERC20 = [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)"
  ];
  const STAKE = [
    "function paused() view returns (bool)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function earned(address) view returns (uint256)",
    "function dailyRate() view returns (uint256)",
    "function stake(uint256)",
    "function withdraw(uint256)",
    "function getReward()",
    "function exit()"
  ];
  const DAILY = [
    "function dailyCap() view returns (uint256)",
    "function startDay() view returns (uint256)",
    "function claimable(uint256,address) view returns (uint256)",
    "function winner(uint256,uint256) view returns (address,uint256)",
    "function dayInfo(uint256) view returns (uint64 postedAt,uint64 deadline,uint256 total,uint256 claimedTotal,bool posted)",
    "function claimMany(uint256[]) returns (uint256)"
  ];
  let busy = false;

  function wallet() {
    return (window.blazarWallet && window.blazarWallet()) || {};
  }
  function reader() {
    const live = wallet();
    if (live.provider) return live.provider;
    return new ethers.JsonRpcProvider(CFG.rpcUrls[0], CFG.chainId, { staticNetwork: true });
  }
  function fmt(amount) {
    const n = Number(ethers.formatUnits(amount || 0n, 18));
    if (!Number.isFinite(n)) return "—";
    if (n === 0) return "0";
    if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
    return n.toPrecision(4);
  }
  function setLog(id, msg, kind) {
    const el = $(id);
    if (!el) return;
    el.textContent = msg;
    el.className = "log" + (kind ? " " + kind : "");
  }
  function parseAmt(raw) {
    const v = String(raw || "").trim();
    if (!v || Number(v) === 0) return 0n;
    return ethers.parseUnits(v, 18);
  }
  async function signer() {
    const live = wallet();
    if (live.signer && live.account) return live;
    throw new Error("Connect a wallet first.");
  }
  async function allow(token, owner, spender, amount, who) {
    const c = new ethers.Contract(token, ERC20, who);
    if (await c.allowance(owner, spender) >= amount) return;
    setLog("stakeLog", "Approving " + fmt(amount) + " BzB");
    await (await c.approve(spender, amount)).wait();
  }

  async function refreshStake(quiet) {
    if (!CFG.staking || !$("stakeYours")) return;
    const provider = reader();
    const stake = new ethers.Contract(CFG.staking, STAKE, provider);
    const bzb = new ethers.Contract(CFG.baseToken, ERC20, provider);
    const account = wallet().account;
    const [total, rate, paused, yours, earned] = await Promise.all([
      stake.totalSupply(),
      stake.dailyRate(),
      stake.paused(),
      account ? stake.balanceOf(account) : 0n,
      account ? stake.earned(account) : 0n
    ]);
    $("stakeTotal").textContent = fmt(total);
    $("stakeRate").textContent = fmt(rate);
    $("stakeYours").textContent = account ? fmt(yours) : "—";
    $("stakeEarned").textContent = account ? fmt(earned) : "—";
    if (quiet) return;
    if (paused) setLog("stakeLog", "New stakes are paused. Withdraw and claim stay open.");
    else if (rate === 0n) setLog("stakeLog", "No rewards are streaming until the contract is funded.");
    else setLog("stakeLog", "Rewards are streaming " + fmt(rate) + " BzB per day.");
  }

  async function refreshRewards(quiet) {
    if (!CFG.dailyRewards || !$("rewardPot")) return;
    const provider = reader();
    const daily = new ethers.Contract(CFG.dailyRewards, DAILY, provider);
    const bzb = new ethers.Contract(CFG.baseToken, ERC20, provider);
    const [pot, cap, startDay, block] = await Promise.all([
      bzb.balanceOf(CFG.dailyRewards),
      daily.dailyCap(),
      daily.startDay(),
      provider.getBlock("latest")
    ]);
    $("rewardPot").textContent = fmt(pot);
    $("rewardCap").textContent = fmt(cap);
    const today = Math.floor(Number(block.timestamp) / 86400);
    const from = Math.max(Number(startDay), today - 30);
    const account = wallet().account;
    const ready = [];
    let mine = 0n;
    let postedDay = 0;
    for (let day = today; day >= from; day--) {
      const info = await daily.dayInfo(day);
      if (!info.posted && !info[4]) continue;
      if (!postedDay) postedDay = day;
      if (account) {
        const amt = await daily.claimable(day, account);
        if (amt > 0n) {
          ready.push(day);
          mine += amt;
        }
      }
    }
    $("rewardMine").textContent = account ? fmt(mine) : "—";
    $("rewardClaim").dataset.days = ready.join(",");
    const board = $("rewardBoard");
    board.innerHTML = "";
    if (!postedDay) {
      if (!quiet) setLog("rewardLog", pot === 0n ? "The pot is empty. Nothing has been posted." : "No day has been posted yet.");
      return;
    }
    const title = document.createElement("p");
    title.className = "draw-kicker";
    title.textContent = "Day " + postedDay;
    board.appendChild(title);
    const list = document.createElement("div");
    list.className = "draw-list";
    for (let i = 0; i < 25; i++) {
      const row = await daily.winner(postedDay, i);
      const who = row.trader || row[0];
      const amt = row.amount || row[1];
      if (!who || who === ethers.ZeroAddress || amt === 0n) continue;
      const line = document.createElement("div");
      line.className = "draw-holder";
      const name = document.createElement("span");
      name.textContent = who.slice(0, 6) + "…" + who.slice(-4);
      const pay = document.createElement("b");
      pay.textContent = fmt(amt) + " BzB";
      line.append(name, pay);
      list.appendChild(line);
    }
    board.appendChild(list);
    if (quiet) return;
    if (mine > 0n) setLog("rewardLog", fmt(mine) + " BzB is ready to claim.", "ok");
    else if (!account) setLog("rewardLog", postedDay ? "Day " + postedDay + " is posted." : "No posted reward is waiting.");
    else setLog("rewardLog", "Nothing is waiting for this wallet.");
  }

  async function stakeAct(kind) {
    if (busy) return;
    busy = true;
    try {
      const live = await signer();
      const stake = new ethers.Contract(CFG.staking, STAKE, live.signer);
      if (kind === "claim") {
        setLog("stakeLog", "Claiming…");
        const tx = await stake.getReward();
        await tx.wait();
        setLog("stakeLog", "Claimed. " + tx.hash, "ok");
      } else if (kind === "exit") {
        setLog("stakeLog", "Exiting…");
        const tx = await stake.exit();
        await tx.wait();
        setLog("stakeLog", "Exited. " + tx.hash, "ok");
      } else {
        const amount = parseAmt($("stakeAmt").value);
        if (amount === 0n) throw new Error("Enter an amount.");
        if (kind === "stake") {
          await allow(CFG.baseToken, live.account, CFG.staking, amount, live.signer);
          setLog("stakeLog", "Staking…");
          const tx = await stake.stake(amount);
          await tx.wait();
          setLog("stakeLog", "Staked. " + tx.hash, "ok");
        } else {
          setLog("stakeLog", "Withdrawing…");
          const tx = await stake.withdraw(amount);
          await tx.wait();
          setLog("stakeLog", "Withdrawn. " + tx.hash, "ok");
        }
      }
      await refreshStake(true);
    } catch (err) {
      setLog("stakeLog", err.shortMessage || err.reason || err.message || String(err), "err");
    } finally {
      busy = false;
    }
  }

  async function claimRewards() {
    if (busy) return;
    busy = true;
    try {
      const live = await signer();
      await refreshRewards();
      const days = String($("rewardClaim").dataset.days || "").split(",").filter(Boolean).map((n) => BigInt(n));
      if (!days.length) throw new Error("Nothing to claim.");
      const daily = new ethers.Contract(CFG.dailyRewards, DAILY, live.signer);
      setLog("rewardLog", "Claiming…");
      const tx = await daily.claimMany(days);
      await tx.wait();
      setLog("rewardLog", "Claimed. " + tx.hash, "ok");
      await refreshRewards(true);
    } catch (err) {
      setLog("rewardLog", err.shortMessage || err.reason || err.message || String(err), "err");
    } finally {
      busy = false;
    }
  }

  window.blazarStakeRefresh = () => { refreshStake().catch(() => {}); };
  window.blazarRewardRefresh = () => { refreshRewards().catch(() => {}); };

  function wire() {
    if (!$("stakeBtn")) return;
    $("stakeBtn").addEventListener("click", () => stakeAct("stake"));
    $("stakeWithdraw").addEventListener("click", () => stakeAct("withdraw"));
    $("stakeClaim").addEventListener("click", () => stakeAct("claim"));
    $("stakeExit").addEventListener("click", () => stakeAct("exit"));
    $("stakeMax").addEventListener("click", async () => {
      try {
        const live = await signer();
        const bal = await new ethers.Contract(CFG.baseToken, ERC20, reader()).balanceOf(live.account);
        $("stakeAmt").value = ethers.formatUnits(bal, 18).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
      } catch (err) {
        setLog("stakeLog", err.shortMessage || err.message || String(err), "err");
      }
    });
    $("rewardClaim").addEventListener("click", claimRewards);
    window.addEventListener("blazar-wallet", () => {
      refreshStake().catch(() => {});
      refreshRewards().catch(() => {});
    });
    refreshStake().catch(() => {});
    refreshRewards().catch(() => {});
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
