/**
 * Profile tab: a wallet's tokens and DeFi positions with approximate USD
 * values. Read-only. Every section loads on its own so a failed RPC or price
 * source never blocks the rest of the page.
 */
import {
  AAVE_V3,
  DEXSCREENER_TOKENS,
  NATIVE,
  PROTOCOLS,
  WPOL,
  aaveLines,
  blockscoutErc20s,
  capByDepth,
  fmtRaw,
  fmtPrice,
  dexBatches,
  fmtAmount,
  fmtUsd,
  groupPositions,
  healthLabel,
  isAddress,
  lower,
  oraclePrice,
  pickDexPrice,
  priceKey,
  protocolOf,
  rankTokens,
  recentDayIds,
  sumPieces,
  toFloat,
  usdOf,
} from "./profile-core.mjs?v=desk23";

const ethers = window.ethers;
const $ = (id) => document.getElementById(id);
const MAX128 = (1n << 128n) - 1n;
const PRICE_CACHE_KEY = "blazar.prices.v1";
const PRICE_TTL = 5 * 60 * 1000;
const FOUND_CACHE_KEY = "blazar.profile.found.v1";

const erc20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const multiIface = new ethers.Interface(["function getEthBalance(address) view returns (uint256)"]);
const stakeIface = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function earned(address) view returns (uint256)",
]);
const rewardIface = new ethers.Interface(["function claimable(uint256 dayId,address trader) view returns (uint256)"]);
const aavePool = new ethers.Interface([
  "function getReservesList() view returns (address[])",
  "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
]);
const aaveData = new ethers.Interface([
  "function getAllReservesTokens() view returns ((string symbol,address tokenAddress)[])",
  "function getUserReserveData(address,address) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint40,bool)",
  "function getReserveConfigurationData(address) view returns (uint256,uint256,uint256,uint256,uint256,bool,bool,bool,bool,bool)",
  "function getReserveTokensAddresses(address) view returns (address,address,address)",
]);
/** Aave receipt / debt tokens, so wallet balances don't double count Aave positions. */
const AAVE_RECEIPT = /^(aPol|aMat|variableDebtPol|stableDebtPol|variableDebtM|stableDebtM)/;
const aaveTokens = new Set();
const aaveOracle = new ethers.Interface(["function getAssetsPrices(address[]) view returns (uint256[])"]);
const collectIface = new ethers.Interface([
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) returns (uint256,uint256)",
]);

let deps = null;
const view = {
  gen: 0,
  address: null,
  override: null,
  tokens: [],
  positions: [],
  failed: [],
  showSmall: false,
  expanded: false,
  loading: false,
};

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function logoImg(src, alt) {
  const wrap = el("span", "pf-logo");
  const fallback = String(alt || "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
  if (src) {
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.src = src;
    img.addEventListener("error", () => { img.remove(); wrap.textContent = fallback; }, { once: true });
    wrap.append(img);
  } else {
    wrap.textContent = fallback;
  }
  return wrap;
}

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || "{}") || {}; } catch { return {}; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota or private mode */ }
}

async function fetchJson(url, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function decode(iface, name, row) {
  if (!row?.success || !row.data || row.data === "0x") return null;
  try { return iface.decodeFunctionResult(name, row.data); } catch { return null; }
}

/* ---------------- token discovery and balances ---------------- */

async function discoverExtra(address) {
  const cache = readJson(FOUND_CACHE_KEY);
  const key = lower(address);
  const known = Array.isArray(cache[key]) ? cache[key] : [];
  try {
    const rows = await fetchJson(`https://polygon.blockscout.com/api/v2/addresses/${address}/token-balances`, 6000);
    const found = blockscoutErc20s(rows);
    cache[key] = [...new Set([...known, ...found.map(lower)])].slice(0, 200);
    writeJson(FOUND_CACHE_KEY, cache);
    return { list: cache[key], indexer: true };
  } catch {
    return { list: known, indexer: false };
  }
}

async function loadTokens(address) {
  const listed = deps.tokens();
  const seen = new Set(listed.map((t) => lower(t.address)));
  const extra = await discoverExtra(address);
  const unknown = extra.list.filter((a) => !seen.has(lower(a)));
  const tokens = listed.map((t) => ({ ...t, listed: true }));
  if (unknown.length) {
    const metaRows = await deps.multicallChunked(unknown.flatMap((a) => [
      { to: a, data: erc20.encodeFunctionData("symbol", []) },
      { to: a, data: erc20.encodeFunctionData("decimals", []) },
    ]));
    unknown.forEach((a, i) => {
      const sym = decode(erc20, "symbol", metaRows[i * 2]);
      const dec = decode(erc20, "decimals", metaRows[i * 2 + 1]);
      if (!dec) return;
      const symbol = String(sym?.[0] || `${a.slice(0, 6)}…`).slice(0, 16);
      tokens.push({ symbol, name: symbol, address: ethers.getAddress(a), decimals: Number(dec[0]), logo: "", listed: false });
    });
  }
  const calls = tokens.map((t) => (lower(t.address) === lower(NATIVE)
    ? { to: deps.MULTICALL, data: multiIface.encodeFunctionData("getEthBalance", [address]) }
    : { to: t.address, data: erc20.encodeFunctionData("balanceOf", [address]) }));
  const rows = await deps.multicallChunked(calls);
  const out = [];
  tokens.forEach((t, i) => {
    const native = lower(t.address) === lower(NATIVE);
    const res = decode(native ? multiIface : erc20, native ? "getEthBalance" : "balanceOf", rows[i]);
    const amount = res ? BigInt(res[0]) : 0n;
    if (amount > 0n) out.push({ ...t, amount });
  });
  return { rows: out, indexer: extra.indexer };
}

/* ---------------- positions ---------------- */

function lpRow(row) {
  const pieces = [
    { symbol: row.meta0.symbol, address: row.token0, decimals: row.meta0.decimals, amount: row.amount0 },
    { symbol: row.meta1.symbol, address: row.token1, decimals: row.meta1.decimals, amount: row.amount1 },
  ];
  const base = {
    protocol: protocolOf(row.venueId),
    venue: row.venue,
    title: `${row.meta0.symbol} / ${row.meta1.symbol}`,
    pieces,
    fees: [],
    manageUrl: row.venueId === "blazar" ? "#liquidity" : row.manageUrl,
    manageLabel: row.venueId === "blazar" ? "Manage on Liquidity tab" : `Manage on ${row.venue}`,
    tags: [],
  };
  if (row.kind === "v2") {
    base.type = `${row.venue} LP`;
    base.detail = `${row.shareBps.toFixed(2)}% of pool`;
  } else {
    base.type = `${row.venue} position #${row.tokenId}`;
    base.tokenId = row.tokenId;
    base.venueId = row.venueId;
    base.detail = row.rangeLabel || "";
    if (row.feeLabel) base.tags.push(row.feeLabel);
    base.tags.push(row.inRange ? "In range" : "Out of range");
    base.inRange = row.inRange;
    base.fees = [
      { symbol: row.meta0.symbol, address: row.token0, decimals: row.meta0.decimals, amount: row.owed0 || 0n },
      { symbol: row.meta1.symbol, address: row.token1, decimals: row.meta1.decimals, amount: row.owed1 || 0n },
    ];
  }
  return base;
}

/** Live uncollected fees: simulate collect() as the owner (eth_call, nothing is sent). */
async function liveFees(rows, owner) {
  const jobs = rows.filter((r) => r.tokenId != null).slice(0, 20);
  await Promise.all(jobs.map(async (row) => {
    const manager = deps.LP_NFT_MANAGERS.find((m) => m.id === row.venueId);
    if (!manager) return;
    try {
      const data = collectIface.encodeFunctionData("collect", [[row.tokenId, owner, MAX128, MAX128]]);
      const raw = await deps.callFrom(manager.manager, data, owner);
      const [a0, a1] = collectIface.decodeFunctionResult("collect", raw);
      row.fees[0].amount = BigInt(a0);
      row.fees[1].amount = BigInt(a1);
      row.feesLive = true;
    } catch { /* keep tokensOwed from the last update */ }
  }));
}

async function loadLp(address) {
  const tasks = [
    deps.loadBlazarV2Positions(address).then((rows) => ({ rows })),
    ...deps.LP_NFT_MANAGERS.map((m) => deps.loadNftPositions(address, m)),
    deps.loadExternalV2Positions(address).then((rows) => ({ rows })),
  ];
  const names = ["BlazarSwap V2", ...deps.LP_NFT_MANAGERS.map((m) => m.name), "QuickSwap/Sushi/Ape V2"];
  const settled = await Promise.allSettled(tasks);
  const rows = [];
  const failed = [];
  settled.forEach((res, i) => {
    if (res.status === "fulfilled") rows.push(...((res.value && res.value.rows) || []).filter(Boolean).map(lpRow));
    else failed.push(names[i]);
  });
  await liveFees(rows, address);
  return { rows, failed };
}

async function loadBlazarStake(address) {
  const rows = await deps.multicall([
    { to: deps.STAKING, data: stakeIface.encodeFunctionData("balanceOf", [address]) },
    { to: deps.STAKING, data: stakeIface.encodeFunctionData("earned", [address]) },
  ]);
  const staked = BigInt(decode(stakeIface, "balanceOf", rows[0])?.[0] ?? 0n);
  const earned = BigInt(decode(stakeIface, "earned", rows[1])?.[0] ?? 0n);
  if (staked === 0n && earned === 0n) return [];
  return [{
    protocol: "blazar-stake",
    venue: "BlazarSwap",
    title: "BZB",
    type: "Staked",
    pieces: [{ symbol: "BZB", address: deps.BZB, decimals: 18, amount: staked }],
    fees: [{ symbol: "BZB", address: deps.BZB, decimals: 18, amount: earned }],
    feesLabel: "Earned",
    feesLive: true,
    manageUrl: "#stake",
    manageLabel: "Manage on Stake tab",
    tags: [],
  }];
}

async function loadBlazarRewards(address) {
  const days = recentDayIds(Date.now() / 1000, 30);
  const rows = await deps.multicall(days.map((d) => ({ to: deps.REWARDS, data: rewardIface.encodeFunctionData("claimable", [d, address]) })));
  let total = 0n;
  let count = 0;
  rows.forEach((row) => {
    const v = BigInt(decode(rewardIface, "claimable", row)?.[0] ?? 0n);
    if (v > 0n) { total += v; count += 1; }
  });
  if (total === 0n) return [];
  return [{
    protocol: "blazar-rewards",
    venue: "BlazarSwap",
    title: "BZB",
    type: "Claimable trading rewards",
    detail: `${count} day${count === 1 ? "" : "s"} unclaimed (last 30 days)`,
    pieces: [{ symbol: "BZB", address: deps.BZB, decimals: 18, amount: total }],
    fees: [],
    manageUrl: "#board",
    manageLabel: "Claim on Leaderboard tab",
    tags: [],
  }];
}

async function loadAave(address, prices) {
  const head = await deps.multicall([
    { to: AAVE_V3.pool, data: aavePool.encodeFunctionData("getUserAccountData", [address]) },
    { to: AAVE_V3.dataProvider, data: aaveData.encodeFunctionData("getAllReservesTokens", []) },
  ]);
  const account = decode(aavePool, "getUserAccountData", head[0]);
  const list = decode(aaveData, "getAllReservesTokens", head[1]);
  if (!list) throw new Error("Aave reserves unreadable");
  const reserves = list[0].map((r) => ({ symbol: r.symbol ?? r[0], asset: r.tokenAddress ?? r[1] }));
  const detail = await deps.multicall([
    ...reserves.map((r) => ({ to: AAVE_V3.dataProvider, data: aaveData.encodeFunctionData("getUserReserveData", [r.asset, address]) })),
    ...reserves.map((r) => ({ to: AAVE_V3.dataProvider, data: aaveData.encodeFunctionData("getReserveConfigurationData", [r.asset]) })),
    { to: AAVE_V3.oracle, data: aaveOracle.encodeFunctionData("getAssetsPrices", [reserves.map((r) => r.asset)]) },
    ...reserves.map((r) => ({ to: AAVE_V3.dataProvider, data: aaveData.encodeFunctionData("getReserveTokensAddresses", [r.asset]) })),
  ]);
  const n = reserves.length;
  const priceRow = decode(aaveOracle, "getAssetsPrices", detail[2 * n]);
  reserves.forEach((r, i) => {
    const wrapped = decode(aaveData, "getReserveTokensAddresses", detail[2 * n + 1 + i]);
    if (wrapped) for (const a of wrapped) aaveTokens.add(lower(a));
    const listed = deps.tokens().find((t) => lower(t.address) === lower(r.asset));
    if (listed) r.symbol = listed.symbol;
    const cfg = decode(aaveData, "getReserveConfigurationData", detail[n + i]);
    r.decimals = cfg ? Number(cfg[0]) : 18;
    const p = priceRow ? oraclePrice(priceRow[0][i], 8) : null;
    r.price = p;
    if (p != null) prices.set(priceKey(r.asset), { price: p, source: "Aave oracle" });
  });
  const datas = reserves.map((r, i) => decode(aaveData, "getUserReserveData", detail[i]));
  const lines = aaveLines(reserves, datas);
  if (!lines.supplied.length && !lines.borrowed.length) return [];
  const out = [];
  if (lines.supplied.length) {
    out.push({
      protocol: "aave",
      venue: "Aave v3",
      title: lines.supplied.map((r) => r.symbol).join(" + "),
      type: "Supplied",
      pieces: lines.supplied.map((r) => ({ symbol: r.symbol, address: r.asset, decimals: r.decimals, amount: r.amount })),
      fees: [],
      manageUrl: AAVE_V3.app,
      manageLabel: "Manage on Aave",
      tags: [account ? healthLabel(account[5]) : ""].filter(Boolean),
    });
  }
  if (lines.borrowed.length) {
    out.push({
      protocol: "aave",
      venue: "Aave v3",
      title: lines.borrowed.map((r) => r.symbol).join(" + "),
      type: "Borrowed",
      debt: true,
      pieces: lines.borrowed.map((r) => ({ symbol: r.symbol, address: r.asset, decimals: r.decimals, amount: r.amount })),
      fees: [],
      manageUrl: AAVE_V3.app,
      manageLabel: "Manage on Aave",
      tags: [],
    });
  }
  return out;
}

/* ---------------- prices ---------------- */

async function loadPrices(addresses, prices) {
  const cache = readJson(PRICE_CACHE_KEY);
  const now = Date.now();
  const need = [];
  for (const a of addresses) {
    const key = priceKey(a);
    if (prices.has(key)) continue;
    const hit = cache[key];
    if (hit && now - (hit.ts || 0) < PRICE_TTL) {
      if (hit.price > 0) prices.set(key, { price: hit.price, thin: hit.thin, liquidity: hit.liq, source: "DexScreener" });
      continue;
    }
    need.push(key);
  }
  const batches = dexBatches(need);
  await Promise.all(batches.map(async (batch) => {
    try {
      const pairs = await fetchJson(DEXSCREENER_TOKENS + batch.join(","), 8000);
      for (const key of batch) {
        const pick = pickDexPrice(pairs, key);
        cache[key] = pick ? { price: pick.price, thin: pick.thin, liq: pick.liquidity, ts: now } : { price: 0, ts: now };
        if (pick) prices.set(key, { price: pick.price, thin: pick.thin, liquidity: pick.liquidity, source: "DexScreener" });
      }
    } catch { /* leave unpriced; on-chain fallback below */ }
  }));
  writeJson(PRICE_CACHE_KEY, cache);
  // On-chain fallback: the desk's own V2 reserve pricing vs WPOL / USDC.
  const missing = addresses.map(priceKey).filter((k) => !prices.has(k));
  if (missing.length && deps.reservePrice) {
    const wpol = prices.get(lower(WPOL))?.price;
    await Promise.all([...new Set(missing)].slice(0, 30).map(async (key) => {
      try {
        const p = await deps.reservePrice(key, wpol);
        if (p && p.price > 0) prices.set(key, { price: p.price, thin: p.liquidity < 1000, liquidity: p.liquidity, source: "pool reserves" });
      } catch { /* unpriced */ }
    }));
  }
}

/* ---------------- render ---------------- */

function priced(prices, piece) {
  const hit = prices.get(priceKey(piece.address));
  return hit ? hit.price : null;
}

function valuePosition(row, prices) {
  const main = sumPieces(row.pieces.map((p) => ({ ...p, price: priced(prices, p) })));
  const fees = sumPieces((row.fees || []).map((p) => ({ ...p, price: priced(prices, p) })));
  const gross = main.usd + fees.usd;
  row.feesUsd = fees.usd;
  row.partial = main.partial || fees.partial;
  const any = row.pieces.some((p) => priced(prices, p) != null) || (row.fees || []).some((p) => priced(prices, p) != null);
  row.usd = any ? (row.debt ? -gross : gross) : null;
}

function skeleton(lines = 3) {
  const box = el("div", "pf-skel-box");
  for (let i = 0; i < lines; i++) box.append(el("div", "pf-skel"));
  return box;
}

function paintSkeleton() {
  $("pfNet").textContent = "";
  $("pfNet").append(el("span", "pf-skel pf-skel-wide"));
  $("pfSplit").textContent = "Reading wallet and positions…";
  $("pfTokens").replaceChildren(skeleton(4));
  $("pfPositions").replaceChildren(skeleton(3));
  $("pfTokenMore").hidden = true;
  $("pfSmall").hidden = true;
  $("pfNote").textContent = "";
}

function tokenRow(row) {
  const line = el("div", "pf-row");
  const who = el("div", "pf-who");
  who.append(logoImg(row.logo, row.symbol));
  const names = el("div", "pf-names");
  names.append(el("b", "", row.symbol), el("small", "", row.price != null ? `${fmtPrice(row.price)}${row.thin ? " · thin pool" : ""}` : "No price"));
  who.append(names);
  const nums = el("div", "pf-nums");
  const value = el("b", "", row.usd != null ? `≈ ${fmtUsd(row.usd)}${row.capped ? "*" : ""}` : "—");
  if (row.capped) value.title = "Capped at what the pool could pay: half its liquidity";
  nums.append(value, el("small", "", fmtRaw(row.amount, row.decimals)));
  line.append(who, nums);
  return line;
}

function paintTokens() {
  const box = $("pfTokens");
  const ranked = rankTokens(view.tokens, { showSmall: view.showSmall, expanded: view.expanded });
  box.replaceChildren();
  if (!ranked.shown.length) {
    box.append(el("p", "status", view.tokens.length ? "Only small or unpriced balances. Turn on small balances to see them." : "No token balances found on Polygon."));
  }
  for (const row of ranked.shown) box.append(tokenRow(row));
  const more = $("pfTokenMore");
  if (ranked.count > ranked.shown.length || view.expanded) {
    more.hidden = false;
    more.textContent = view.expanded ? "Show fewer tokens" : `Show all tokens (${ranked.count})`;
  } else {
    more.hidden = true;
  }
  const small = $("pfSmall");
  small.hidden = !(ranked.hiddenSmall > 0 || view.showSmall);
  small.textContent = view.showSmall ? "Hide small balances" : `Show small balances (${ranked.hiddenSmall})`;
  $("pfTokTotal").textContent = `≈ ${fmtUsd(ranked.total)}`;
}

function piecesText(pieces) {
  return pieces.filter((p) => BigInt(p.amount || 0n) > 0n).map((p) => `${fmtRaw(p.amount, p.decimals)} ${p.symbol}`).join(" + ") || "0";
}

function positionCard(row) {
  const card = el("div", "pf-pos");
  const top = el("div", "pf-pos-top");
  const left = el("div", "pf-names");
  left.append(el("b", "", row.title), el("small", "", row.type));
  const right = el("div", "pf-nums");
  right.append(el("b", row.debt ? "pf-debt" : "", row.usd != null ? `≈ ${fmtUsd(row.usd)}${row.partial ? "+" : ""}` : "No price"));
  top.append(left, right);
  card.append(top);
  const body = el("p", "pos-meta", piecesText(row.pieces));
  card.append(body);
  if (row.fees && row.fees.some((f) => BigInt(f.amount || 0n) > 0n)) {
    const label = row.feesLabel || (row.feesLive ? "Uncollected fees" : "Fees (last update)");
    card.append(el("p", "pos-meta", `${label}: ${piecesText(row.fees)}${row.feesUsd ? ` · ≈ ${fmtUsd(row.feesUsd)}` : ""}`));
  }
  const foot = el("div", "pf-pos-foot");
  for (const tag of row.tags || []) {
    const cls = tag === "In range" ? "pf-tag pos-in" : tag === "Out of range" ? "pf-tag pos-out" : "pf-tag";
    foot.append(el("span", cls, tag));
  }
  if (row.detail && !String(row.detail).startsWith("Full range") && !String(row.detail).startsWith("Ticks")) foot.append(el("span", "pf-tag", row.detail));
  if (row.detail && String(row.detail).startsWith("Full range")) foot.append(el("span", "pf-tag", "Full range"));
  if (row.manageUrl) {
    const link = el("a", "pos-manage", row.manageLabel || "Manage");
    link.href = row.manageUrl;
    if (row.manageUrl.startsWith("#")) {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        deps.showTab(row.manageUrl.slice(1) === "liquidity" ? "liq" : row.manageUrl.slice(1));
      });
    } else {
      link.target = "_blank";
      link.rel = "noopener";
    }
    foot.append(link);
  }
  card.append(foot);
  return card;
}

function paintPositions() {
  const box = $("pfPositions");
  box.replaceChildren();
  const groups = groupPositions(view.positions);
  if (!groups.length) {
    box.append(el("p", "status", view.failed.length ? "No positions found in the protocols that loaded." : "No DeFi positions found in the supported protocols."));
  }
  for (const group of groups) {
    const card = el("section", "pf-group");
    const head = el("div", "pf-group-head");
    const who = el("div", "pf-who");
    who.append(logoImg(group.logo, group.name), el("b", "", group.name), el("span", "pf-count", String(group.positions.length)));
    head.append(who, el("b", group.usd < 0 ? "pf-debt" : "", `≈ ${fmtUsd(group.usd)}`));
    card.append(head);
    for (const row of group.positions) card.append(positionCard(row));
    box.append(card);
  }
  const total = groups.reduce((s, g) => s + g.usd, 0);
  $("pfPosTotal").textContent = `≈ ${fmtUsd(total)}`;
  return total;
}

function paintAll() {
  paintTokens();
  const defi = paintPositions();
  const wallet = rankTokens(view.tokens, { showSmall: true }).total;
  $("pfNet").textContent = fmtUsd(wallet + defi);
  $("pfSplit").textContent = `Wallet ≈ ${fmtUsd(wallet)} · DeFi ≈ ${fmtUsd(defi)}`;
  const notes = ["Values are approximate: Aave oracle prices for majors, DexScreener for the rest, BlazarSwap/QuickSwap pool reserves as a fallback."];
  if (view.tokens.some((t) => t.capped)) notes.push("* Capped at half the pool's liquidity, about the most that pool could pay for the bag.");
  if (view.failed.length) notes.push(`Could not read: ${view.failed.join(", ")}. Press Refresh to retry.`);
  if (!view.indexer) notes.push("Token scan used BlazarSwap's token lists only (the public indexer did not answer), so unlisted tokens may be missing.");
  $("pfNote").textContent = notes.join(" ");
}

/* ---------------- flow ---------------- */

export async function loadProfile({ force = false } = {}) {
  if (!deps) return;
  const address = view.override || deps.state.account;
  $("pfAddr").textContent = address ? `${address.slice(0, 6)}…${address.slice(-4)}${view.override ? " · read-only view" : " · connected wallet"}` : "";
  $("pfMine").hidden = !view.override || !deps.state.account;
  if (!address) {
    $("pfBody").hidden = true;
    $("pfEmpty").hidden = false;
    return;
  }
  $("pfBody").hidden = false;
  $("pfEmpty").hidden = true;
  if (!force && view.address === address && view.at && Date.now() - view.at < 60_000) return;
  const gen = ++view.gen;
  view.address = address;
  view.expanded = false;
  paintSkeleton();
  const stale = () => gen !== view.gen;
  const prices = new Map();
  const failed = [];
  const [tok, lp, stake, rewards, aave] = await Promise.allSettled([
    loadTokens(address),
    loadLp(address),
    loadBlazarStake(address),
    loadBlazarRewards(address),
    loadAave(address, prices),
  ]);
  if (stale()) return;
  const tokens = (tok.status === "fulfilled" ? tok.value.rows : [])
    .filter((t) => !aaveTokens.has(lower(t.address)) && !AAVE_RECEIPT.test(String(t.symbol || "")));
  if (tok.status !== "fulfilled") failed.push("wallet tokens");
  view.indexer = tok.status === "fulfilled" ? tok.value.indexer : false;
  const positions = [];
  if (lp.status === "fulfilled") { positions.push(...lp.value.rows); failed.push(...lp.value.failed); } else failed.push("LP positions");
  if (stake.status === "fulfilled") positions.push(...stake.value); else failed.push("BZB staking");
  if (rewards.status === "fulfilled") positions.push(...rewards.value); else failed.push("trading rewards");
  if (aave.status === "fulfilled") positions.push(...aave.value); else failed.push("Aave v3");
  if (!prices.has(lower(WPOL))) {
    try {
      const p = await deps.wpolUsd();
      if (p) prices.set(lower(WPOL), { price: p, source: "Chainlink" });
    } catch { /* DexScreener will try */ }
  }
  const addrs = [
    ...tokens.map((t) => t.address),
    ...positions.flatMap((r) => [...r.pieces, ...(r.fees || [])].map((p) => p.address)),
  ];
  try { await loadPrices(addrs, prices); } catch { /* unpriced rows show "No price" */ }
  if (stale()) return;
  for (const t of tokens) {
    const hit = prices.get(priceKey(t.address));
    t.price = hit ? hit.price : null;
    t.thin = Boolean(hit?.thin);
    t.float = toFloat(t.amount, t.decimals);
    const capped = capByDepth(hit ? usdOf(t.amount, t.decimals, hit.price) : null, hit?.liquidity);
    t.usd = capped.usd;
    t.capped = capped.capped;
  }
  for (const row of positions) valuePosition(row, prices);
  view.tokens = tokens;
  view.positions = positions;
  view.failed = failed;
  view.at = Date.now();
  paintAll();
}

export function profileSnapshot() {
  return { address: view.address, tokens: view.tokens, positions: view.positions, failed: view.failed };
}

export function initProfile(options) {
  deps = options;
  $("pfTokenMore").addEventListener("click", () => { view.expanded = !view.expanded; paintTokens(); });
  $("pfSmall").addEventListener("click", () => { view.showSmall = !view.showSmall; paintTokens(); });
  $("pfRefresh").addEventListener("click", () => { loadProfile({ force: true }); });
  const go = () => {
    const text = $("pfInput").value.trim();
    if (!text) { view.override = null; loadProfile({ force: true }); return; }
    if (!isAddress(text)) { $("pfInputMsg").textContent = "That is not a Polygon address (0x + 40 hex)."; return; }
    $("pfInputMsg").textContent = "";
    view.override = ethers.getAddress(text.toLowerCase());
    try { history.replaceState(null, "", `#profile/${view.override}`); } catch { /* file:// */ }
    loadProfile({ force: true });
  };
  $("pfView").addEventListener("click", go);
  $("pfInput").addEventListener("keydown", (event) => { if (event.key === "Enter") go(); });
  $("pfMine").addEventListener("click", () => {
    view.override = null;
    $("pfInput").value = "";
    try { history.replaceState(null, "", "#profile"); } catch { /* file:// */ }
    loadProfile({ force: true });
  });
  const hash = String(location.hash || "");
  const m = hash.match(/^#profile(?:\/(0x[0-9a-fA-F]{40}))?$/);
  if (m) {
    if (m[1]) { view.override = ethers.getAddress(m[1].toLowerCase()); $("pfInput").value = view.override; }
    return true;
  }
  return false;
}

export function profileAccountChanged() {
  view.at = 0;
}

export { PROTOCOLS };
