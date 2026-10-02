(() => {
  const DRAW = "0x48c66cd325FB48603E783166924Dee6f901aD2Bf";
  const RPC = "https://polygon-bor-rpc.publicnode.com";
  const STATUS = ["none", "open", "closed", "locked", "committed", "drawn", "paid", "cancelled"];
  const DRAW_ABI = [
    "function create(address,uint256,uint256,uint16) returns (uint256)",
    "function depositERC20(uint256,address,uint256)",
    "function depositERC721(uint256,address,uint256)",
    "function enroll(uint256,address[])",
    "function close(uint256)",
    "function lock(uint256)",
    "function commit(uint256)",
    "function draw(uint256)",
    "function pay(uint256)",
    "function cancel(uint256)",
    "function pullERC20(uint256,address)",
    "function pullNFT(uint256,uint256)",
    "function erc20Pull(uint256,address,address) view returns (uint256)",
    "function nftPull(uint256,uint256) view returns (address)",
    "function entryCount(uint256) view returns (uint256)",
    "function prizeCount(uint256) view returns (uint256)",
    "function entered(uint256,address) view returns (bool)",
    "function getPrizes(uint256) view returns (address[],uint8[],uint256[])",
    "function getWinners(uint256) view returns (address[])",
    "function raffles(uint256) view returns (address organizer,address ticket,uint256 minBalance,uint256 unit,uint16 winnerCount,uint8 status,uint256 liveWeight,uint64 lastEnrollBlock,uint64 lockBlock,uint64 targetBlock)",
    "event Created(uint256 indexed id, address indexed organizer, address ticket, uint256 minBalance, uint256 unit, uint16 winnerCount)"
  ];
  const ERC20 = [
    "function approve(address,uint256) returns (bool)",
    "function allowance(address,address) view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function name() view returns (string)"
  ];
  const ERC721 = [
    "function setApprovalForAll(address,bool)",
    "function isApprovedForAll(address,address) view returns (bool)"
  ];

  const $ = (id) => document.getElementById(id);
  let found = null;
  let skipped = {};
  let signer = null;
  let account = null;
  let busy = false;
  let pollTimer = 0;
  let chain = null;

  function short(addr) {
    return addr ? addr.slice(0, 6) + "…" + addr.slice(-4) : "—";
  }
  function setLog(msg, kind) {
    const el = $("drawLog");
    if (!el) return;
    el.textContent = msg;
    el.className = "log" + (kind ? " " + kind : "");
  }
  function explain(err) {
    const reason = err && (err.reason || err.shortMessage || err.message);
    const raw = String(reason || err || "Something failed.").replace(/^execution reverted:?\s*/i, "").replace(/"/g, "");
    const plain = {
      ticket: "That ticket address is not a contract.",
      min: "Minimum balance has to be above zero.",
      winners: "Pick between 1 and 10 winners.",
      organizer: "Only the wallet that created this draw can do that.",
      status: "That step is not available yet.",
      wait: "Wait for the next block, then try again.",
      contract: "A contract was in the list. Only wallets are allowed.",
      balance: "A wallet fell below the minimum.",
      empty: "Add at least one wallet before closing.",
      prizes: "Escrow a prize before closing.",
      nobody: "No wallet still qualifies.",
      early: "The target block has not been mined yet.",
      frozen: "Prizes are frozen.",
      full: "This draw already has 120 wallets.",
      duplicate: "That wallet or NFT is already in.",
      reentrancy: "The contract is busy. Try again."
    };
    return plain[raw] || raw;
  }
  function read() {
    return new ethers.JsonRpcProvider(RPC, 137, { staticNetwork: true });
  }
  function asAddress(value, label) {
    const trimmed = String(value || "").trim();
    if (!ethers.isAddress(trimmed)) throw new Error(label || "Enter a token contract address.");
    return ethers.getAddress(trimmed);
  }
  function setBusy(next) {
    busy = next;
    document.querySelectorAll(".draw-act").forEach((btn) => { btn.disabled = next; });
  }
  function minRaw() {
    if (!found) return 0n;
    try {
      return ethers.parseUnits(String($("drawMin").value || "0").trim() || "0", found.decimals);
    } catch {
      return 0n;
    }
  }
  function seated() {
    if (!found) return [];
    const min = minRaw();
    if (min <= 0n) return [];
    return found.holders.filter((holder) => !skipped[holder.address] && BigInt(holder.balance) >= min).slice(0, 120);
  }
  function paintSeat() {
    const n = seated().length;
    const el = $("drawSeat");
    if (el) el.textContent = found ? n + " wallets will be submitted, 120 maximum." : "Find holders first.";
  }
  function paintHolders() {
    const box = $("drawList");
    const meta = $("drawMeta");
    const wrap = $("drawFound");
    if (!box || !found) return;
    wrap.hidden = false;
    meta.textContent = found.name + " · " + found.symbol + " · " + found.holders.length + " wallets. " + found.excluded + " contracts left out." + (found.truncated ? " The list was longer than this draw can seat, so the largest wallets are shown." : "");
    const min = minRaw();
    box.replaceChildren();
    found.holders.forEach((holder) => {
      const enough = min > 0n && BigInt(holder.balance) >= min;
      const row = document.createElement("label");
      row.className = "draw-holder" + (enough ? "" : " dim");
      const left = document.createElement("span");
      const boxIn = document.createElement("input");
      boxIn.type = "checkbox";
      boxIn.checked = enough && !skipped[holder.address];
      boxIn.disabled = !enough;
      boxIn.addEventListener("change", () => {
        skipped[holder.address] = !boxIn.checked;
        paintSeat();
      });
      left.append(boxIn, document.createTextNode(" " + short(holder.address)));
      const right = document.createElement("span");
      right.textContent = trimAmount(holder.balance, found.decimals);
      row.append(left, right);
      box.append(row);
    });
    paintSeat();
  }
  function trimAmount(value, decimals) {
    const n = Number(ethers.formatUnits(value, decimals));
    if (!Number.isFinite(n)) return value;
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  function prizeRows() {
    return [...document.querySelectorAll("#drawPrizes .draw-prize")].map((row) => ({
      kind: row.querySelector(".draw-kind").value,
      token: row.querySelector(".draw-token").value.trim(),
      amount: row.querySelector(".draw-amount").value.trim()
    })).filter((prize) => prize.token && prize.amount);
  }
  function addPrizeRow(kind, token, amount) {
    const row = document.createElement("div");
    row.className = "draw-prize";
    row.innerHTML = '<select class="draw-kind"><option value="20">Tokens</option><option value="721">NFT id</option></select><input class="draw-token" placeholder="Prize contract" spellcheck="false" /><input class="draw-amount" placeholder="Amount" />';
    row.querySelector(".draw-kind").value = kind || "20";
    row.querySelector(".draw-token").value = token || "";
    row.querySelector(".draw-amount").value = amount || "";
    const amountInput = row.querySelector(".draw-amount");
    row.querySelector(".draw-kind").addEventListener("change", () => {
      amountInput.placeholder = row.querySelector(".draw-kind").value === "721" ? "Token id" : "Amount";
    });
    $("drawPrizes").append(row);
  }

  async function explorerHolders(token) {
    let url = "https://polygon.blockscout.com/api/v2/tokens/" + token + "/holders?items_count=50";
    const rows = [];
    let excluded = 0;
    let truncated = false;
    for (let page = 0; page < 12; page++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      let res;
      try {
        res = await fetch(url, { headers: { accept: "application/json" }, signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        if (rows.length || excluded) { truncated = true; break; }
        throw new Error("The holder list did not answer. Paste wallet addresses instead.");
      }
      const body = await res.json();
      for (const item of body.items || []) {
        const address = item.address && item.address.hash;
        if (!address || !ethers.isAddress(address)) continue;
        if (item.address.is_contract) { excluded += 1; continue; }
        rows.push({ address: ethers.getAddress(address), balance: String(item.value || "0") });
      }
      if (!body.next_page_params) break;
      const query = new URLSearchParams();
      Object.entries(body.next_page_params).forEach(([key, value]) => query.set(key, String(value)));
      url = "https://polygon.blockscout.com/api/v2/tokens/" + token + "/holders?" + query.toString();
      if (rows.length >= 120) { truncated = true; break; }
    }
    return { rows, excluded, truncated };
  }

  async function keepHumans(token, rows) {
    const provider = read();
    const erc = new ethers.Contract(token, ERC20, provider);
    const kept = [];
    let excluded = 0;
    for (let i = 0; i < rows.length; i += 12) {
      const slice = rows.slice(i, i + 12);
      const checked = await Promise.all(slice.map(async (row) => {
        const [code, balance] = await Promise.all([
          provider.getCode(row.address),
          erc.balanceOf(row.address).catch(() => 0n)
        ]);
        return { address: row.address, code, balance };
      }));
      checked.forEach((row) => {
        if (row.code !== "0x") { excluded += 1; return; }
        if (row.balance <= 0n) return;
        kept.push({ address: row.address, balance: row.balance.toString() });
      });
    }
    kept.sort((a, b) => (BigInt(a.balance) > BigInt(b.balance) ? -1 : 1));
    return { holders: kept.slice(0, 120), excluded, truncated: kept.length > 120 };
  }

  async function findHolders() {
    const token = asAddress($("drawToken").value, "Enter a token contract address.");
    const pasted = String($("drawPaste").value || "").split(/[\s,]+/).map((part) => part.trim()).filter(Boolean);
    if (pasted.length > 120) throw new Error("Paste at most 120 addresses.");
    pasted.forEach((part) => { if (!ethers.isAddress(part)) throw new Error(part + " is not a wallet address."); });
    const provider = read();
    const erc = new ethers.Contract(token, ERC20, provider);
    const [name, symbol, decimals] = await Promise.all([
      erc.name().catch(() => "Token"),
      erc.symbol().catch(() => "TOKEN"),
      erc.decimals().catch(() => 18)
    ]);
    let excluded = 0;
    let truncated = false;
    let rows = [];
    if (pasted.length) {
      rows = pasted.map((address) => ({ address: ethers.getAddress(address), balance: "0" }));
    } else {
      const listed = await explorerHolders(token);
      rows = listed.rows;
      excluded += listed.excluded;
      truncated = listed.truncated;
    }
    const seen = new Set();
    rows = rows.filter((row) => {
      const key = row.address.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const screened = await keepHumans(token, rows.slice(0, 160));
    return {
      name, symbol, decimals: Number(decimals), token,
      holders: screened.holders,
      excluded: excluded + screened.excluded,
      truncated: truncated || screened.truncated
    };
  }

  async function wallet() {
    if (!window.ethereum) throw new Error("No wallet found. Install one, then use Connect at the top.");
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x89" }] });
    } catch (err) {
      if (err && err.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: "0x89",
            chainName: "Polygon",
            nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
            rpcUrls: [RPC],
            blockExplorerUrls: ["https://polygonscan.com"]
          }]
        });
      } else if (!err || err.code !== 4001) {
        throw err;
      }
    }
    const provider = new ethers.BrowserProvider(window.ethereum);
    const net = await provider.getNetwork();
    if (Number(net.chainId) !== 137) throw new Error("Switch the wallet to Polygon.");
    await provider.send("eth_requestAccounts", []);
    signer = await provider.getSigner();
    account = await signer.getAddress();
    if ($("drawAccount")) $("drawAccount").textContent = short(account);
    return signer;
  }

  async function approveERC20(token, amount) {
    const erc = new ethers.Contract(token, ERC20, signer);
    const current = await erc.allowance(account, DRAW);
    if (current >= amount) return;
    setLog("Approving the prize token…");
    await (await erc.approve(DRAW, amount)).wait();
  }
  async function approveNFT(token) {
    const nft = new ethers.Contract(token, ERC721, signer);
    if (await nft.isApprovedForAll(account, DRAW)) return;
    setLog("Approving the NFT collection…");
    await (await nft.setApprovalForAll(DRAW, true)).wait();
  }

  function raffleId() {
    return String($("drawId").value || "").replace(/\D/g, "");
  }
  function remember(id) {
    $("drawId").value = id;
    try { localStorage.setItem("blazar-holder-draw", id); } catch {}
    watch();
  }

  async function depositPrizes(id) {
    const draw = new ethers.Contract(DRAW, DRAW_ABI, signer);
    const prizes = prizeRows();
    if (!prizes.length) throw new Error("Add a prize token or NFT.");
    const existing = await draw.getPrizes(id);
    const have = existing[0].map((token, index) => ({
      token: String(token).toLowerCase(),
      kind: Number(existing[1][index]),
      amount: existing[2][index]
    }));
    let sent = 0;
    for (const prize of prizes) {
      const token = asAddress(prize.token, "Prize contract is not an address.");
      if (prize.kind === "20") {
        if (have.some((item) => item.kind === 1 && item.token === token.toLowerCase() && item.amount > 0n)) continue;
        const meta = new ethers.Contract(token, ERC20, signer);
        const decimals = Number(await meta.decimals().catch(() => 18));
        const exact = ethers.parseUnits(prize.amount, decimals);
        if (exact <= 0n) throw new Error("Prize amount must be above zero.");
        await approveERC20(token, exact);
        setLog("Escrowing tokens…");
        await (await draw.depositERC20(id, token, exact)).wait();
        have.push({ token: token.toLowerCase(), kind: 1, amount: exact });
        sent += 1;
      } else {
        if (!/^\d+$/.test(prize.amount)) throw new Error("NFT prize needs a token id.");
        const tokenId = BigInt(prize.amount);
        if (have.some((item) => item.kind === 2 && item.token === token.toLowerCase() && item.amount === tokenId)) continue;
        await approveNFT(token);
        setLog("Escrowing NFT…");
        await (await draw.depositERC721(id, token, tokenId)).wait();
        have.push({ token: token.toLowerCase(), kind: 2, amount: tokenId });
        sent += 1;
      }
    }
    if (!sent && !have.length) throw new Error("Add a prize token or NFT.");
  }

  async function liveEligible() {
    if (!found) throw new Error("Find holders first.");
    const min = minRaw();
    if (min <= 0n) throw new Error("Set a minimum balance above zero.");
    const chosen = seated();
    if (!chosen.length) throw new Error("Nobody meets the minimum.");
    const erc = new ethers.Contract(found.token, ERC20, signer);
    const provider = signer.provider;
    if (!provider) throw new Error("Wallet has no connection.");
    const ready = [];
    for (let i = 0; i < chosen.length; i += 10) {
      const slice = chosen.slice(i, i + 10);
      const checks = await Promise.all(slice.map(async (holder) => {
        const [code, balance] = await Promise.all([
          provider.getCode(holder.address),
          erc.balanceOf(holder.address)
        ]);
        return code === "0x" && balance >= min ? holder.address : "";
      }));
      checks.forEach((address) => { if (address) ready.push(address); });
    }
    return ready;
  }

  async function enrollReady(id) {
    const ready = await liveEligible();
    if (!ready.length) throw new Error("Every wallet fell below the minimum, or gained contract code. Prizes can still be cancelled.");
    const draw = new ethers.Contract(DRAW, DRAW_ABI, signer);
    const fresh = [];
    for (let i = 0; i < ready.length; i += 20) {
      const slice = ready.slice(i, i + 20);
      const flags = await Promise.all(slice.map((address) => draw.entered(id, address)));
      slice.forEach((address, index) => { if (!flags[index]) fresh.push(address); });
    }
    if (!fresh.length) throw new Error("Those wallets are already in the draw.");
    for (let i = 0; i < fresh.length; i += 40) {
      const end = Math.min(i + 40, fresh.length);
      setLog("Adding wallets " + (i + 1) + "–" + end + "…");
      await (await draw.enroll(id, fresh.slice(i, i + 40), { gasLimit: 1800000 })).wait();
    }
  }

  async function createDraw() {
    const current = await wallet();
    if (!found) throw new Error("Find holders first.");
    const winners = Number($("drawWinners").value);
    if (!Number.isInteger(winners) || winners < 1 || winners > 10) throw new Error("Pick 1 to 10 winners.");
    if (minRaw() <= 0n) throw new Error("Set a minimum balance above zero.");
    if (!seated().length) throw new Error("Nobody meets the minimum.");
    if (!prizeRows().length) throw new Error("Add a prize token or NFT.");
    const unit = $("drawMode").value === "each" ? 0n : ethers.parseUnits("1", found.decimals);
    const draw = new ethers.Contract(DRAW, DRAW_ABI, current);
    setLog("Creating the draw…");
    const created = await (await draw.create(found.token, minRaw(), unit, winners)).wait();
    const parsed = created.logs.map((log) => {
      try { return draw.interface.parseLog(log); } catch { return null; }
    }).find((event) => event && event.name === "Created");
    const id = parsed && parsed.args && parsed.args.id;
    if (id === undefined) throw new Error("The draw was created, but the id was missing. Check the wallet activity.");
    const idText = id.toString();
    remember(idText);
    try {
      await depositPrizes(id);
      await enrollReady(id);
      setLog("Closing the list…");
      await (await draw.close(id)).wait();
    } catch (err) {
      throw new Error(explain(err) + " Draw " + idText + " is still open. Finish it below, or cancel to get prizes back.");
    }
    setLog("List closed. Lock on the next block so a one-transaction borrow cannot change the count.", "ok");
  }

  async function send(label, fn) {
    setBusy(true);
    try {
      await wallet();
      await fn();
      await refresh();
    } catch (err) {
      setLog(explain(err), "err");
    } finally {
      setBusy(false);
    }
    if (label) return;
  }

  function action(label, fn, ghost) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = (ghost ? "ghost" : "primary") + " full draw-act";
    btn.textContent = label;
    btn.disabled = busy;
    btn.addEventListener("click", () => send(label, fn));
    return btn;
  }

  async function refresh() {
    const id = raffleId();
    const box = $("drawStatus");
    const actions = $("drawActions");
    if (!id) {
      chain = null;
      if (box) box.textContent = "No draw loaded yet. The number appears after you create one.";
      if (actions) actions.replaceChildren();
      return;
    }
    try { localStorage.setItem("blazar-holder-draw", id); } catch {}
    const provider = read();
    const draw = new ethers.Contract(DRAW, DRAW_ABI, provider);
    const [raffle, block, winners, entryCount] = await Promise.all([
      draw.raffles(id),
      provider.getBlockNumber(),
      draw.getWinners(id),
      draw.entryCount(id)
    ]);
    if (raffle.organizer === ethers.ZeroAddress) {
      chain = null;
      box.textContent = "That draw number does not exist.";
      actions.replaceChildren();
      return;
    }
    const phase = Number(raffle.status);
    chain = {
      organizer: raffle.organizer,
      phase,
      liveWeight: raffle.liveWeight,
      lastEnrollBlock: Number(raffle.lastEnrollBlock),
      lockBlock: Number(raffle.lockBlock),
      targetBlock: Number(raffle.targetBlock),
      entryCount: Number(entryCount),
      winners,
      block
    };
    const lines = [
      STATUS[phase] || "unknown",
      chain.entryCount + " wallets · " + chain.liveWeight.toString() + " tickets · block " + chain.block
    ];
    if (chain.targetBlock) lines[1] += " · target " + chain.targetBlock;
    lines.push("Organizer " + short(chain.organizer));
    box.replaceChildren();
    lines.forEach((line, index) => {
      const p = document.createElement("p");
      p.className = index === 0 ? "draw-phase" : "draw-note";
      p.textContent = line;
      box.append(p);
    });
    if (winners.length) {
      const list = document.createElement("ul");
      list.className = "draw-winners";
      winners.forEach((winner, index) => {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = "https://polygonscan.com/address/" + winner;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = "Winner " + (index + 1) + ": " + short(winner);
        li.append(a);
        list.append(li);
      });
      box.append(list);
    }
    actions.replaceChildren();
    const idBig = BigInt(id);
    if (phase === 1) {
      actions.append(action("Deposit prizes listed above", () => depositPrizes(idBig), true));
      actions.append(action("Add the checked wallets", () => enrollReady(idBig), true));
      if (chain.entryCount > 0) {
        actions.append(action("Close the list", async () => {
          setLog("Closing the list…");
          await (await new ethers.Contract(DRAW, DRAW_ABI, signer).close(idBig)).wait();
          setLog("List closed. Lock on the next block.", "ok");
        }));
      }
    }
    if (phase === 2 && chain.block > chain.lastEnrollBlock) {
      actions.append(action("Lock tickets", async () => {
        setLog("Counting tickets from real balances…");
        await (await new ethers.Contract(DRAW, DRAW_ABI, signer).lock(idBig, { gasLimit: 6000000 })).wait();
        setLog("Tickets are locked. Commit on the next block. Cancelling is still possible until then.", "ok");
      }));
    } else if (phase === 2) {
      const wait = document.createElement("p");
      wait.className = "draw-note";
      wait.textContent = "Wait for the next block, then lock. That gap is what stops a flash loan.";
      actions.append(wait);
    }
    if (phase === 3 && chain.block > chain.lockBlock) {
      actions.append(action("Commit draw", async () => {
        setLog("Freezing the draw. Prizes cannot come back after this.");
        await (await new ethers.Contract(DRAW, DRAW_ABI, signer).commit(idBig)).wait();
        setLog("Committed. The winning block is a few blocks ahead.", "ok");
      }));
    }
    if (phase === 4 && chain.block > chain.targetBlock) {
      const stale = chain.block > chain.targetBlock + 250;
      actions.append(action(stale ? "Set a new target" : "Draw winners", async () => {
        setLog(stale ? "The old target expired. Setting a new one…" : "Drawing…");
        await (await new ethers.Contract(DRAW, DRAW_ABI, signer).draw(idBig, { gasLimit: 3000000 })).wait();
        setLog(stale ? "New target set. Draw again after that block." : "Winners are in. Send the prizes next.", "ok");
      }));
    } else if (phase === 4) {
      const wait = document.createElement("p");
      wait.className = "draw-note";
      wait.textContent = "Winning block is " + chain.targetBlock + ". Current block is " + chain.block + ".";
      actions.append(wait);
    }
    if (phase === 5) {
      actions.append(action("Send prizes", async () => {
        setLog("Sending prizes…");
        await (await new ethers.Contract(DRAW, DRAW_ABI, signer).pay(idBig, { gasLimit: 6000000 })).wait();
        setLog("Prizes sent. A token that refuses the transfer stays as a pull for that winner.", "ok");
      }));
    }
    if (phase === 1 || phase === 2 || phase === 3) {
      actions.append(action("Cancel and return prizes", async () => {
        setLog("Returning prizes…");
        await (await new ethers.Contract(DRAW, DRAW_ABI, signer).cancel(idBig)).wait();
        setLog("Cancelled. Prizes were sent back to the organizer.", "ok");
      }, true));
    }
    if (phase === 6 && account) {
      const prizes = await draw.getPrizes(id);
      const tokens = prizes[0];
      const kinds = prizes[1];
      for (let i = 0; i < tokens.length; i++) {
        if (Number(kinds[i]) === 1) {
          const owed = await draw.erc20Pull(id, account, tokens[i]);
          if (owed > 0n) {
            const token = tokens[i];
            actions.append(action("Pull " + short(token), async () => {
              setLog("Pulling tokens…");
              await (await new ethers.Contract(DRAW, DRAW_ABI, signer).pullERC20(idBig, token)).wait();
              setLog("Pulled.", "ok");
            }, true));
          }
        } else if ((await draw.nftPull(id, i)).toLowerCase() === account.toLowerCase()) {
          const index = i;
          actions.append(action("Pull NFT prize " + (index + 1), async () => {
            setLog("Pulling the NFT…");
            await (await new ethers.Contract(DRAW, DRAW_ABI, signer).pullNFT(idBig, index)).wait();
            setLog("Pulled.", "ok");
          }, true));
        }
      }
    }
  }

  function watch() {
    if (pollTimer) clearInterval(pollTimer);
    refresh().catch((err) => setLog(explain(err), "err"));
    pollTimer = setInterval(() => {
      if (document.hidden) return;
      refresh().catch(() => {});
    }, 4000);
  }

  async function quietAccount() {
    if (!window.ethereum) return;
    try {
      const accounts = await window.ethereum.request({ method: "eth_accounts" });
      if (accounts && accounts[0]) {
        account = ethers.getAddress(accounts[0]);
        if ($("drawAccount")) $("drawAccount").textContent = short(account);
      }
    } catch {}
  }

  function boot() {
    if (!$("pane-draw")) return;
    addPrizeRow("20", "", "");
    $("drawFind").addEventListener("click", () => {
      setBusy(true);
      setLog("Looking up holders…");
      findHolders().then((next) => {
        found = next;
        skipped = {};
        paintHolders();
        setLog(next.holders.length ? next.holders.length + " wallets can be tickets. " + next.excluded + " contracts were left out." : "No human wallets were found above a zero balance.", next.holders.length ? "ok" : "");
      }).catch((err) => setLog(explain(err), "err")).finally(() => setBusy(false));
    });
    $("drawAddPrize").addEventListener("click", () => {
      if (document.querySelectorAll("#drawPrizes .draw-prize").length >= 24) {
        setLog("24 prizes is the contract maximum.", "err");
        return;
      }
      addPrizeRow("20", "", "");
    });
    const bzb = $("drawBzb");
    if (bzb) {
      bzb.addEventListener("click", () => {
        const address = window.BLAZARSWAP && window.BLAZARSWAP.baseToken;
        if (address) $("drawToken").value = address;
      });
    }
    $("drawCreate").addEventListener("click", () => send("create", createDraw));
    $("drawAccount").addEventListener("click", () => send("", async () => { setLog("Wallet ready on Polygon.", "ok"); }));
    $("drawMin").addEventListener("input", () => { if (found) paintHolders(); });
    $("drawId").addEventListener("change", watch);
    try {
      const saved = localStorage.getItem("blazar-holder-draw");
      if (saved) $("drawId").value = saved;
    } catch {}
    quietAccount().finally(watch);
    window.drawRefresh = () => refresh().catch(() => {});
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
