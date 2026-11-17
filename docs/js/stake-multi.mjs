/**
 * Stake BZB tab for BlazarMultiRewardStaking: stake BZB, earn up to 5 reward tokens, each with up to
 * 5 independent runs. Hidden unless window.BLAZARSWAP.multiStaking is set to a deployed address.
 * Reads go through the desk's read RPC; every write is estimated (+25%, 1.1M floor on withdraw/emergency/checkpoint, 1.2M on stake/compound, 2.2M on exit/claimAll) and
 * waits for the wallet's signature.
 */
import {
  CURVE_PRESETS,
  LIMITS,
  aprPercent,
  curveDetail,
  curveEmitted,
  curveLabel,
  curvePreviewPaths,
  curveRate,
  daysHoursToSec,
  durationLabel,
  formatApr,
  gasLimitFor,
  isAddressLike,
  parseAddressList,
  runStatus,
  startTimeFor,
  sumApr,
  toFloatUnits,
  validateNewTokens,
  validateRecover,
  validateRuns,
} from "./stake-multi-core.mjs?v=desk26";
import { DEXSCREENER_TOKENS, dexBatches, fmtUsd, pickDexPrice, priceKey } from "./profile-core.mjs?v=desk23";

import { ERROR_TEXT, FEATURES, decodeRevert, erc20Iface, iface } from "./stake-multi-contract.mjs?v=desk26";

const ethers = window.ethers;
const $ = (id) => document.getElementById(id);
const PRICE_TTL = 5 * 60 * 1000;

let deps = null;
const ms = {
  address: "",
  enabled: false,
  wired: false,
  loading: false,
  gen: 0,
  data: null,
  meta: new Map(),
  prices: new Map(),
  pricesAt: 0,
  drafts: [],
  draftSeq: 0,
  mode: "stake",
  expanded: new Set(),
  timer: null,
};

function configured() {
  const raw = String(window.BLAZARSWAP?.multiStaking || "").trim();
  return isAddressLike(raw) ? ethers.getAddress(raw) : "";
}

export function multiStakeEnabled() {
  return !!configured();
}

function lower(a) {
  return String(a || "").toLowerCase();
}

function short(addr) {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "—";
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function fmt(amount, decimals, frac = 4) {
  return deps.formatUnits(BigInt(amount), Number(decimals), frac);
}

function fmtNice(amount, decimals) {
  const n = toFloatUnits(amount, decimals);
  if (n === 0) return "0";
  if (n >= 1e6) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return fmt(amount, decimals, 8);
}

function when(ts) {
  const d = new Date(Number(ts) * 1000);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

function svgCurve(startWeight, endWeight, { width = 240, height = 72, nowFrac = null } = {}) {
  const NS = "http://www.w3.org/2000/svg";
  const p = curvePreviewPaths(startWeight, endWeight, { width, height, pad: 4 });
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "ms-curve");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${curveLabel(startWeight, endWeight)} curve`);
  const add = (cls, d) => {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("class", cls);
    path.setAttribute("d", d);
    svg.appendChild(path);
  };
  add("area", p.rateArea);
  add("rate", p.rateLine);
  add("cum", p.cumLine);
  if (nowFrac != null && nowFrac >= 0 && nowFrac <= 1) {
    const x = (4 + nowFrac * (width - 8)).toFixed(1);
    add("now", `M${x} 2 L${x} ${height - 2}`);
  }
  return svg;
}

function legend() {
  const box = el("div", "ms-legend");
  box.innerHTML = '<i></i>reward rate <i class="cum"></i>total emitted';
  return box;
}

function explain(err) {
  return decodeRevert(err) || deps.explainError(err) || "Request failed";
}

async function multiRead(rows) {
  const res = await deps.multicall(rows.map((r) => ({ to: r.to || ms.address, data: (r.iface || iface).encodeFunctionData(r.fn, r.args || []) })));
  return res.map((row, i) => {
    if (!row.success) return null;
    try {
      return (rows[i].iface || iface).decodeFunctionResult(rows[i].fn, row.data);
    } catch {
      return null;
    }
  });
}

async function tokenMeta(addresses) {
  // Re-read tokens whose decimals() failed last time (L-4) instead of trusting a guessed 18.
  const need = addresses.filter((a) => !ms.meta.has(lower(a)) || ms.meta.get(lower(a)).decimalsKnown === false);
  const known = [];
  for (const a of need) {
    const t = deps.tokenByAddress(a);
    if (t) ms.meta.set(lower(a), { address: ethers.getAddress(a), symbol: t.symbol, decimals: Number(t.decimals), decimalsKnown: true, logo: t.logo || "" });
    else known.push(a);
  }
  if (known.length) {
    const rows = await multiRead(known.flatMap((a) => [
      { to: a, iface: erc20Iface, fn: "symbol" },
      { to: a, iface: erc20Iface, fn: "decimals" },
    ]));
    known.forEach((a, i) => {
      const sym = rows[i * 2]?.[0];
      const dec = rows[i * 2 + 1]?.[0];
      const decOk = dec != null && Number.isInteger(Number(dec)) && Number(dec) >= 0 && Number(dec) <= 36;
      // decimals 18 is a display-only fallback; decimalsKnown:false blocks run creation (L-4).
      ms.meta.set(lower(a), { address: ethers.getAddress(a), symbol: sym ? String(sym).slice(0, 16) : short(a), decimals: decOk ? Number(dec) : 18, decimalsKnown: decOk, logo: "" });
    });
  }
  return addresses.map((a) => ms.meta.get(lower(a)));
}

async function fetchJson(url, ms_ = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms_);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** USD prices: DexScreener (profile-core picker) first, then the desk's own pool-reserve fallback. */
async function loadPrices(addresses) {
  const now = Date.now();
  if (now - ms.pricesAt > PRICE_TTL) {
    ms.prices = new Map();
    ms.pricesAt = now;
  }
  const need = addresses.map(priceKey).filter((k) => !ms.prices.has(k));
  if (!need.length) return ms.prices;
  await Promise.all(dexBatches(need).map(async (batch) => {
    try {
      const pairs = await fetchJson(DEXSCREENER_TOKENS + batch.join(","));
      for (const key of batch) {
        const pick = pickDexPrice(pairs, key);
        if (pick) ms.prices.set(key, { price: pick.price, thin: pick.thin, source: "DexScreener" });
      }
    } catch { /* fallback below */ }
  }));
  const missing = need.filter((k) => !ms.prices.has(k));
  if (missing.length && deps.reservePrice && deps.wpolUsd) {
    let wpol = null;
    try { wpol = await deps.wpolUsd(); } catch { /* unpriced */ }
    await Promise.all(missing.map(async (key) => {
      try {
        const p = await deps.reservePrice(key, wpol);
        if (p && p.price > 0) ms.prices.set(key, { price: p.price, thin: p.liquidity < 1000, source: "pool reserves" });
      } catch { /* unpriced */ }
    }));
  }
  for (const k of need) if (!ms.prices.has(k)) ms.prices.set(k, null);
  return ms.prices;
}

function priceOf(address) {
  const hit = ms.prices.get(priceKey(address));
  return hit ? hit.price : null;
}

/* ---------------- load ---------------- */

export async function loadMultiStake() {
  const addr = configured();
  ms.address = addr;
  ms.enabled = !!addr;
  paintMode();
  if (!ms.enabled || !deps) return;
  wire();
  const gen = ++ms.gen;
  try {
    const account = deps.state.account;
    const [codeHex, block] = await deps.withReadProvider(async (rpc) => [await rpc.getCode(addr), await rpc.getBlock("latest")]);
    if (!codeHex || codeHex === "0x") throw new Error("The staking contract has no code at the configured address.");
    const base = await multiRead([
      { fn: "stakingToken" },
      { fn: "minStake" },
      { fn: "totalStaked" },
      { fn: "paused" },
      { fn: "owner" },
      { fn: "pendingOwner" },
      { fn: "rewardTokens" },
      ...(account ? [{ fn: "balanceOf", args: [account] }, { to: deps.BZB, iface: erc20Iface, fn: "balanceOf", args: [account] }] : []),
    ]);
    if (gen !== ms.gen) return;
    const stakingToken = base[0]?.[0];
    if (!stakingToken || lower(stakingToken) !== lower(deps.BZB)) throw new Error("The configured contract doesn't stake BZB. Nothing will be sent to it.");
    const tokens = (base[6]?.[0] || []).map((a) => ethers.getAddress(a));
    const owner = base[4]?.[0] || ethers.ZeroAddress;
    const pending = base[5]?.[0] || ethers.ZeroAddress;
    const isOwner = !!account && lower(owner) === lower(account);
    const per = tokens.length ? await multiRead(tokens.flatMap((t) => [
      { fn: "getRuns", args: [t] },
      { fn: "rewardRate", args: [t] },
      { fn: "activeRunCount", args: [t] },
      ...(account ? [{ fn: "earned", args: [account, t] }] : []),
    ])) : [];
    const width = account ? 4 : 3;
    const metas = await tokenMeta([...tokens, deps.BZB]);
    let ownerExtra = null;
    if (isOwner) {
      const recTokens = [...tokens];
      if (!tokens.some((t) => lower(t) === lower(deps.BZB))) recTokens.push(ethers.getAddress(deps.BZB));
      const rows = await multiRead(recTokens.flatMap((t) => [
        { fn: "recoverable", args: [t] },
        { fn: "reserved", args: [t] },
        { to: t, iface: erc20Iface, fn: "balanceOf", args: [addr] },
        { to: t, iface: erc20Iface, fn: "balanceOf", args: [account] },
      ]));
      ownerExtra = recTokens.map((t, i) => ({
        token: t,
        recoverable: BigInt(rows[i * 4]?.[0] ?? 0n),
        reserved: BigInt(rows[i * 4 + 1]?.[0] ?? 0n),
        held: BigInt(rows[i * 4 + 2]?.[0] ?? 0n),
        ownerBal: BigInt(rows[i * 4 + 3]?.[0] ?? 0n),
      }));
    }
    if (gen !== ms.gen) return;
    const rewards = tokens.map((t, i) => {
      const runsRaw = per[i * width]?.[0] || [];
      return {
        token: t,
        meta: metas[i],
        runs: runsRaw.map((r) => ({
          slot: Number(r.slot),
          id: Number(r.id),
          amount: BigInt(r.amount),
          emittedNow: BigInt(r.emittedNow),
          start: Number(r.start),
          end: Number(r.end),
          startWeight: Number(r.startWeight),
          endWeight: Number(r.endWeight),
          ratePerSecond: BigInt(r.ratePerSecond),
        })),
        rate: BigInt(per[i * width + 1]?.[0] ?? 0n),
        activeRuns: Number(per[i * width + 2]?.[0] ?? 0n),
        earned: account ? BigInt(per[i * width + 3]?.[0] ?? 0n) : null,
      };
    });
    ms.data = {
      account,
      now: Number(block?.timestamp || Math.floor(Date.now() / 1000)),
      minStake: BigInt(base[1]?.[0] ?? LIMITS.MIN_STAKE),
      totalStaked: BigInt(base[2]?.[0] ?? 0n),
      paused: !!base[3]?.[0],
      owner,
      pending,
      isOwner,
      isPending: !!account && lower(pending) === lower(account) && lower(pending) !== lower(ethers.ZeroAddress),
      tokens,
      rewards,
      staked: account ? BigInt(base[7]?.[0] ?? 0n) : null,
      wallet: account ? BigInt(base[8]?.[0] ?? 0n) : null,
      ownerExtra,
      bzbMeta: metas[metas.length - 1],
    };
    paint();
    loadPrices([deps.BZB, ...tokens]).then(() => { if (gen === ms.gen) paint(); }).catch(() => {});
  } catch (err) {
    if (gen !== ms.gen) return;
    deps.log("msLog", `Could not read the staking contract. ${explain(err)}`, "err");
  }
}

/* ---------------- paint ---------------- */

function paintMode() {
  const on = ms.enabled;
  $("msStake").hidden = !on;
  // Legacy staking stays fully usable (stake, withdraw, claim) next to the new contract (security B-2).
  // Once the new contract is live it sits underneath as a compact "Legacy staking" card.
  $("legacyStake").hidden = false;
  $("stakeBtn").hidden = false;
  $("legacyTitle").textContent = on ? "Legacy staking" : "Stake BZB";
}

function setMode(mode) {
  ms.mode = mode === "withdraw" ? "withdraw" : "stake";
  const stake = ms.mode === "stake";
  $("msModeStake").classList.toggle("on", stake);
  $("msModeWithdraw").classList.toggle("on", !stake);
  $("msModeStake").setAttribute("aria-selected", String(stake));
  $("msModeWithdraw").setAttribute("aria-selected", String(!stake));
  paintAction();
}

function paintAction() {
  const d = ms.data;
  const stake = ms.mode !== "withdraw";
  const acct = !!d?.account;
  $("msActionBtn").textContent = !acct ? "Connect wallet" : stake ? "Stake" : "Withdraw";
  $("msActionBtn").disabled = acct && stake && !!d?.paused;
  $("msBalLabel").firstChild.textContent = stake ? "Wallet " : "Staked ";
  $("msWallet").textContent = acct ? fmtNice(stake ? d.wallet : d.staked, 18) : "—";
}

function paint() {
  const d = ms.data;
  if (!d) return;
  const acct = !!d.account;
  $("msStaked").textContent = acct ? fmtNice(d.staked, 18) : "—";
  $("msTotal").textContent = fmtNice(d.totalStaked, 18);
  $("msPausedTag").hidden = !d.paused;
  const bzbPrice = priceOf(deps.BZB);
  const aprs = [];
  for (const r of d.rewards) {
    r.apr = aprPercent({ ratePerSecond: r.rate, rewardDecimals: r.meta.decimals, rewardPriceUsd: priceOf(r.token), totalStaked: d.totalStaked, stakePriceUsd: bzbPrice });
    aprs.push(r.apr);
  }
  $("msApr").textContent = formatApr(sumApr(aprs));
  $("msHint").textContent = d.paused
    ? "Staking is paused. Withdraw and claims still work."
    : `No lock, no fee. Min ${fmt(d.minStake, 18, 6)} BZB.`;
  paintAction();
  paintEarned(d);
  paintRuns(d);
  paintClaimTo(d);
  // Hooks for the next contract version (multireward-agent). Hidden while FEATURES flags are off.
  $("msCompoundBtn").hidden = !FEATURES.compound;
  $("msCompoundBtn").disabled = !d.account || !d.staked;
  $("msSkipBrokenWrap").hidden = !FEATURES.claimAllSkipping;
  $("msAccept").hidden = !d.isPending;
  $("msOwner").hidden = !d.isOwner;
  if (d.isOwner) paintOwner(d);
}

function tokenLogo(meta) {
  const box = el("span", "pf-logo");
  if (meta.logo) {
    const img = document.createElement("img");
    img.src = meta.logo;
    img.alt = "";
    img.onerror = () => { box.textContent = meta.symbol.slice(0, 3); };
    box.appendChild(img);
  } else box.textContent = meta.symbol.slice(0, 3);
  return box;
}

function paintEarned(d) {
  const box = $("msEarned");
  box.replaceChildren();
  $("msClaimAllBtn").disabled = true;
  if (!d.account) {
    box.append(el("div", "ms-empty", "Connect a wallet to see your rewards."));
    return;
  }
  if (!d.rewards.length) {
    box.append(el("div", "ms-empty", "No reward tokens yet."));
    return;
  }
  let any = false;
  for (const r of d.rewards) {
    const row = el("div", "ms-tok");
    row.dataset.token = r.token;
    const price = priceOf(r.token);
    const usd = price != null ? toFloatUnits(r.earned, r.meta.decimals) * price : null;
    const amt = el("div", "ms-amt");
    amt.append(el("b", "ms-earned", fmtNice(r.earned, r.meta.decimals)));
    if (usd != null && r.earned > 0n) amt.append(el("small", "", `≈ ${fmtUsd(usd)}`));
    const btn = el("button", "ms-link", "Claim");
    btn.type = "button";
    btn.dataset.claim = r.token;
    btn.disabled = r.earned === 0n;
    if (r.earned > 0n) any = true;
    row.append(tokenLogo(r.meta), el("span", "ms-sym", r.meta.symbol), amt, btn);
    box.append(row);
  }
  $("msClaimAllBtn").disabled = !any;
}

function runDetail(r, run, d) {
  const st = runStatus(run, d.now);
  const box = el("div", "ms-run-detail");
  const dur = run.end - run.start;
  const pct = run.amount > 0n ? Number((run.emittedNow * 10_000n) / run.amount) / 100 : 0;
  const apr = aprPercent({ ratePerSecond: run.ratePerSecond, rewardDecimals: r.meta.decimals, rewardPriceUsd: priceOf(r.token), totalStaked: d.totalStaked, stakePriceUsd: priceOf(deps.BZB) });
  const kv = el("div", "ms-kv");
  const cell = (label, value) => { const c = el("div", "", label); c.append(el("b", "", value)); kv.append(c); };
  const startRate = curveRate(run.amount, dur, run.startWeight, run.endWeight, 0) * 86_400n;
  const endRate = curveRate(run.amount, dur, run.startWeight, run.endWeight, dur - 1) * 86_400n;
  cell("Total", `${fmtNice(run.amount, r.meta.decimals)} ${r.meta.symbol}`);
  cell("Paid out", `${fmtNice(run.emittedNow, r.meta.decimals)} · ${pct.toFixed(1)}%`);
  cell("Starts", when(run.start));
  cell("Ends", when(run.end));
  cell("Rate now", st === "live" ? `${fmtNice(run.ratePerSecond * 86_400n, r.meta.decimals)}/day` : "Not started");
  cell("Est. APR", st === "live" ? formatApr(apr) : "—");
  cell("Start → end rate", `${fmtNice(startRate, r.meta.decimals)} → ${fmtNice(endRate, r.meta.decimals)}`);
  cell("Length", durationLabel(dur));
  const cap = el("div", "ms-curve-cap", `Run #${run.id} · ${curveLabel(run.startWeight, run.endWeight)} · ${curveDetail(run.startWeight, run.endWeight)}`);
  const nowFrac = dur > 0 ? Math.min(1, Math.max(0, (d.now - run.start) / dur)) : null;
  box.append(kv, cap, svgCurve(run.startWeight, run.endWeight, { width: 280, height: 56, nowFrac: st === "live" ? nowFrac : null }), legend());
  return box;
}

function paintRuns(d) {
  const box = $("msRuns");
  box.replaceChildren();
  const all = d.rewards.flatMap((r) => r.runs.map((run) => ({ r, run })));
  $("msRunCount").textContent = all.length ? `${all.length} run${all.length === 1 ? "" : "s"}` : "";
  if (!all.length) {
    box.append(el("div", "ms-empty", "No active reward runs right now."));
    return;
  }
  for (const { r, run } of all) {
    const key = `${lower(r.token)}:${run.id}`;
    const open = ms.expanded.has(key);
    const st = runStatus(run, d.now);
    const pct = run.amount > 0n ? Number((run.emittedNow * 10_000n) / run.amount) / 100 : 0;
    const strip = el("button", "ms-strip");
    strip.type = "button";
    strip.dataset.runKey = key;
    strip.dataset.runId = String(run.id);
    strip.dataset.token = r.token;
    strip.setAttribute("aria-expanded", String(open));
    const mini = el("span", "ms-mini");
    const fill = el("i");
    fill.style.width = `${Math.min(100, pct)}%`;
    mini.append(fill);
    const rate = st === "live" ? `${fmtNice(run.ratePerSecond * 86_400n, r.meta.decimals)}/day` : `${fmtNice(run.amount, r.meta.decimals)} total`;
    const state = el("span", `ms-state${st === "live" ? "" : " ms-sched"}`, st === "live" ? `${pct.toFixed(0)}%` : `in ${durationLabel(run.start - d.now)}`);
    strip.append(tokenLogo(r.meta), el("span", "ms-sym", r.meta.symbol), el("span", "ms-rate", rate), mini, state, el("span", "ms-chev", "›"));
    box.append(strip);
    if (open) box.append(runDetail(r, run, d));
  }
}

function paintClaimTo(d) {
  const sel = $("msClaimToToken");
  const keep = sel.value;
  sel.replaceChildren();
  const all = el("option", "", "All tokens with rewards");
  all.value = "all";
  sel.append(all);
  for (const r of d.rewards) {
    const o = el("option", "", `${r.meta.symbol}${d.account ? ` (${fmtNice(r.earned, r.meta.decimals)})` : ""}`);
    o.value = r.token;
    sel.append(o);
  }
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

/* ---------------- owner panel ---------------- */

const QUICK = [
  ["BZB", "0x462D8d82C2B2D2DDabf7f8a93928De09d47A5807"],
  ["USDC", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"],
  ["USDT", "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"],
  ["WPOL", "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"],
  ["WETH", "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"],
  ["BBY", "0xb837f0e111596348A27e424e43938eb01753cf34"],
];

function paintOwner(d) {
  $("msPauseState").textContent = d.paused ? "paused" : "active";
  $("msPauseBtn").textContent = d.paused ? "Unpause" : "Pause";
  $("msTokenSlots").textContent = `${d.tokens.length}/${LIMITS.MAX_REWARD_TOKENS}`;
  const full = d.tokens.length >= LIMITS.MAX_REWARD_TOKENS;
  $("msAddTokensBtn").disabled = full;
  $("msAddTokens").disabled = full;
  const quick = $("msQuickTokens");
  quick.replaceChildren();
  for (const [sym, addr] of QUICK) {
    const b = el("button", "", `+ ${sym}`);
    b.type = "button";
    b.dataset.quick = addr;
    b.disabled = full || d.tokens.some((t) => lower(t) === lower(addr));
    quick.append(b);
  }
  const fresh = !ms.drafts.length;
  if (fresh) addDraft();
  // Re-render the run form only when its inputs' context changed, never just because of the refresh timer.
  const sig = `${d.tokens.join(",")}|${(d.ownerExtra || []).map((x) => x.ownerBal).join(",")}|${ms.drafts.length}`;
  if (fresh || sig !== ms.draftSig || !$("msDrafts").children.length) {
    ms.draftSig = sig;
    paintDrafts();
  }
  // surplus
  const box = $("msSurplus");
  box.replaceChildren();
  const sel = $("msRecoverToken");
  const keep = sel.value;
  sel.replaceChildren();
  for (const x of d.ownerExtra || []) {
    const meta = ms.meta.get(lower(x.token));
    const row = el("div", "ms-surplus-row");
    row.dataset.token = x.token;
    row.title = `Held ${fmtNice(x.held, meta.decimals)} · reserved ${fmtNice(x.reserved, meta.decimals)}`;
    const right = el("span", "", "");
    right.append(el("b", "ms-surplus", fmtNice(x.recoverable, meta.decimals)), " recoverable");
    row.append(el("span", "", meta.symbol), right);
    box.append(row);
    const o = el("option", "", meta.symbol);
    o.value = x.token;
    sel.append(o);
  }
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  if (!$("msRecoverTo").value) $("msRecoverTo").value = d.account;
}

function newDraft() {
  return { id: ++ms.draftSeq, token: "", amount: "", startMode: "now", delayDays: "0", delayHours: "0", durationDays: "30", startWeight: 10_000, endWeight: 10_000 };
}

function addDraft() {
  const d = newDraft();
  const data = ms.data;
  if (data?.tokens.length) {
    const last = ms.drafts[ms.drafts.length - 1];
    d.token = last?.token || data.tokens[0];
  }
  ms.drafts.push(d);
}

function draftToRun(draft) {
  const meta = ms.meta.get(lower(draft.token));
  let amount = 0n;
  let amountErr = null;
  if (meta && meta.decimalsKnown === false) {
    amountErr = `Couldn't read ${meta.symbol}'s decimals, so the amount can't be converted safely. Try again later.`;
  } else if (meta && String(draft.amount).trim()) {
    try { amount = deps.parseUnits(String(draft.amount).trim(), meta.decimals); } catch (err) { amountErr = err.message; }
  }
  const delaySec = draft.startMode === "now" ? 0 : daysHoursToSec(draft.delayDays, draft.delayHours);
  const durDays = Number(draft.durationDays);
  const durationSec = Number.isFinite(durDays) ? Math.round(durDays * 86_400) : NaN;
  return { token: draft.token, amount, amountErr, delaySec, durationSec, startWeight: Number(draft.startWeight), endWeight: Number(draft.endWeight), meta };
}

function draftSummary(draft) {
  const run = draftToRun(draft);
  const d = ms.data;
  if (!run.meta || run.amount <= 0n || !Number.isFinite(run.durationSec) || run.durationSec <= 0) return "Pick a token, amount, and duration to see the schedule.";
  const s = Number(run.startWeight);
  const e = Number(run.endWeight);
  if (!(s + e > 0)) return "Start and end weight can't both be zero.";
  const start = (d?.now || Math.floor(Date.now() / 1000)) + (run.delaySec || 0);
  const end = start + run.durationSec;
  const sym = run.meta.symbol;
  const dec = run.meta.decimals;
  const r0 = curveRate(run.amount, run.durationSec, s, e, 0) * 86_400n;
  const r1 = curveRate(run.amount, run.durationSec, s, e, run.durationSec - 1) * 86_400n;
  const half = curveEmitted(run.amount, run.durationSec, s, e, Math.floor(run.durationSec / 2));
  const avg = (run.amount * 86_400n) / BigInt(run.durationSec);
  return `${run.delaySec ? `Starts ${when(start)}` : "Starts when mined"} · ends ~${when(end)}. ${curveLabel(s, e)}: ${fmtNice(r0, dec)} → ${fmtNice(r1, dec)} ${sym}/day (avg ${fmtNice(avg, dec)}/day). Half the run pays ${fmtNice(half, dec)} ${sym}.`;
}

function paintDrafts() {
  const box = $("msDrafts");
  const d = ms.data;
  const focusId = document.activeElement?.dataset?.f ? `${document.activeElement.closest(".ms-draft")?.dataset.draft}:${document.activeElement.dataset.f}` : null;
  box.replaceChildren();
  ms.drafts.forEach((draft, idx) => {
    const card = el("div", "ms-draft");
    card.dataset.draft = String(draft.id);
    const head = el("div", "ms-draft-head");
    head.append(el("b", "", `Run ${idx + 1}`));
    if (ms.drafts.length > 1) {
      const x = el("button", "ms-x", "×");
      x.type = "button";
      x.title = "Remove this run";
      x.dataset.removeDraft = String(draft.id);
      head.append(x);
    }
    const body = el("div", "ms-draft-body");
    const left = el("div");
    const row1 = el("div", "ms-row");
    const field = (label, input, grow) => { const f = el("label", `ms-field${grow ? " ms-grow" : ""}`); f.append(el("span", "", label), input); return f; };
    const tokSel = el("select", "ms-input");
    tokSel.dataset.f = "token";
    if (!d?.tokens.length) tokSel.append(el("option", "", "List a token first"));
    for (const t of d?.tokens || []) {
      const meta = ms.meta.get(lower(t));
      const o = el("option", "", meta?.symbol || short(t));
      o.value = t;
      tokSel.append(o);
    }
    if (draft.token) tokSel.value = draft.token;
    else if (d?.tokens.length) draft.token = tokSel.value;
    const meta = ms.meta.get(lower(draft.token));
    const ownerBal = d?.ownerExtra?.find((x) => lower(x.token) === lower(draft.token))?.ownerBal;
    const amt = inputEl("amount", draft.amount, "0.0", "decimal");
    row1.append(field("Reward token", tokSel), field(`Amount${meta && ownerBal != null ? ` (wallet ${fmtNice(ownerBal, meta.decimals)})` : ""}`, amt, true));
    const row2 = el("div", "ms-row");
    const startSel = el("select", "ms-input");
    startSel.dataset.f = "startMode";
    for (const [v, t] of [["now", "Start now"], ["delay", "Start later"]]) { const o = el("option", "", t); o.value = v; startSel.append(o); }
    startSel.value = draft.startMode;
    row2.append(field("Start", startSel));
    if (draft.startMode === "delay") {
      row2.append(field("Delay days (0-30)", inputEl("delayDays", draft.delayDays, "0", "numeric")), field("+ hours", inputEl("delayHours", draft.delayHours, "0", "numeric")));
    }
    row2.append(field("Duration days (1-365)", inputEl("durationDays", draft.durationDays, "30", "decimal")));
    const row3 = el("div", "ms-row");
    const presets = el("div", "ms-presets");
    for (const [k, p] of Object.entries(CURVE_PRESETS)) {
      const b = el("button", "", p.label);
      b.type = "button";
      b.dataset.preset = k;
      presets.append(b);
    }
    row3.append(field("Curve", presets), field("Start weight (0-10000)", inputEl("startWeight", String(draft.startWeight), "10000", "numeric")), field("End weight (0-10000)", inputEl("endWeight", String(draft.endWeight), "10000", "numeric")));
    const sum = el("p", "ms-sum", draftSummary(draft));
    left.append(row1, row2, row3, sum);
    body.append(left, draftPreview(draft));
    card.append(head, body);
    markPresets(card, draft);
    box.append(card);
  });
  if (focusId) {
    const [id, f] = focusId.split(":");
    const target = box.querySelector(`.ms-draft[data-draft="${id}"] [data-f="${f}"]`);
    if (target) {
      target.focus();
      if (target.setSelectionRange && typeof target.value === "string") target.setSelectionRange(target.value.length, target.value.length);
    }
  }
}

function draftPreview(draft) {
  const box = el("div", "ms-preview");
  const sw = Number(draft.startWeight);
  const ew = Number(draft.endWeight);
  const ok = (w) => Number.isInteger(w) && w >= 0 && w <= LIMITS.MAX_WEIGHT;
  if (ok(sw) && ok(ew) && sw + ew > 0) box.append(svgCurve(sw, ew, { width: 200, height: 64 }), legend());
  else box.append(el("p", "ms-sum", "Weights must be 0 to 10,000 and not both zero."));
  return box;
}

function markPresets(card, draft) {
  for (const b of card.querySelectorAll("button[data-preset]")) {
    const p = CURVE_PRESETS[b.dataset.preset];
    b.classList.toggle("on", Number(draft.startWeight) === p.startWeight && Number(draft.endWeight) === p.endWeight);
  }
}

function refreshDraftCard(card, draft) {
  const sum = card.querySelector(".ms-sum");
  if (sum) sum.textContent = draftSummary(draft);
  const prev = card.querySelector(".ms-preview");
  if (prev) prev.replaceWith(draftPreview(draft));
  markPresets(card, draft);
}

function inputEl(f, value, placeholder, mode) {
  const i = el("input", "ms-input");
  i.type = "text";
  i.inputMode = mode;
  i.autocomplete = "off";
  i.placeholder = placeholder;
  i.value = value;
  i.dataset.f = f;
  return i;
}

function errs(id, list) {
  const box = $(id);
  box.replaceChildren();
  for (const e of list || []) box.append(el("div", "", e));
}

/* ---------------- writes ---------------- */

async function sendCall(fn, args, action, logId) {
  if (!deps.state.account) {
    $("connectBtn").click();
    throw new Error("Connect a wallet first.");
  }
  await deps.assertChain();
  const data = iface.encodeFunctionData(fn, args);
  const tx = { to: ms.address, data, value: 0n, chainId: 137n };
  let est;
  try {
    est = await deps.withReadProvider((rpc) => rpc.estimateGas({ ...tx, from: deps.state.account }));
  } catch (err) {
    throw new Error(decodeRevert(err) || "Simulation failed. Nothing was sent.");
  }
  tx.gasLimit = gasLimitFor(est, action || fn);
  deps.log(logId, `Waiting for your wallet (gas limit ${tx.gasLimit.toLocaleString("en-US")})…`, "");
  return deps.send(tx, logId);
}

async function run(logId, task) {
  if (deps.state.busy) return;
  deps.state.busy = true;
  deps.log(logId, "", "");
  try {
    const msg = await task();
    if (msg) deps.log(logId, msg, "ok");
    await loadMultiStake();
    deps.paintBalances?.().catch?.(() => {});
  } catch (err) {
    deps.log(logId, explain(err), "err");
  } finally {
    deps.state.busy = false;
  }
}

function amountInput() {
  return deps.parseUnits($("msAmount").value.trim(), 18);
}

function doStake() {
  return run("msLog", async () => {
    const d = ms.data;
    if (d?.paused) throw new Error(ERROR_TEXT.EnforcedPause);
    const amount = amountInput();
    if (d && d.wallet != null && amount > d.wallet) throw new Error("That's more BZB than this wallet holds.");
    if (d && (d.staked || 0n) + amount < d.minStake) throw new Error(`The minimum position is ${fmt(d.minStake, 18, 6)} BZB.`);
    await deps.assertChain();
    // Approve is folded into the same button: exact-amount approval first (skipped if already enough).
    deps.log("msLog", "Checking BZB approval…", "");
    await deps.ensureAllowance({ address: deps.BZB, symbol: "BZB", decimals: 18 }, ms.address, amount, "msLog");
    const receipt = await sendCall("stake", [amount], "stake", "msLog");
    $("msAmount").value = "";
    return `Staked ${fmt(amount, 18, 6)} BZB in block ${receipt.blockNumber}.`;
  });
}

function doWithdraw() {
  return run("msLog", async () => {
    const d = ms.data;
    const amount = amountInput();
    if (d && d.staked != null) {
      if (amount > d.staked) throw new Error(ERROR_TEXT.InsufficientBalance);
      const left = d.staked - amount;
      if (left !== 0n && left < d.minStake) throw new Error(ERROR_TEXT.BelowMinStake);
    }
    const receipt = await sendCall("withdraw", [amount], "withdraw", "msLog");
    $("msAmount").value = "";
    return `Withdrew ${fmt(amount, 18, 6)} BZB in block ${receipt.blockNumber}. Your earned rewards stay claimable.`;
  });
}

function doExit() {
  return run("msLog", async () => {
    if (!ms.data?.staked && !ms.data?.rewards.some((r) => r.earned > 0n)) throw new Error("Nothing staked or earned.");
    const receipt = await sendCall("exit", [], "exit", "msLog");
    return `Withdrew everything and claimed all rewards in block ${receipt.blockNumber}.`;
  });
}

function doClaim(token) {
  return run("msLog", async () => {
    const receipt = await sendCall("claim", [token], "claim", "msLog");
    return `Claimed ${ms.meta.get(lower(token))?.symbol || "rewards"} in block ${receipt.blockNumber}.`;
  });
}

function doCompound() {
  return run("msLog", async () => {
    // multireward-agent (aeaf3e6) only; the button stays hidden until FEATURES.compound is switched on.
    if (!FEATURES.compound) throw new Error("Compound isn't available on this contract version.");
    const receipt = await sendCall("compound", [], "compound", "msLog");
    return `Restaked your BZB rewards in block ${receipt.blockNumber}.`;
  });
}

function doClaimAll() {
  return run("msLog", async () => {
    if (FEATURES.claimAllSkipping && $("msSkipBroken").checked) {
      // multireward-agent (aeaf3e6) only. Skipped tokens stay credited and can be claimed later.
      const receipt = await sendCall("claimAllSkipping", [], "claimAllSkipping", "msLog");
      const skipped = receipt.logs.filter((l) => lower(l.address) === lower(ms.address)).map((l) => { try { return iface.parseLog(l); } catch { return null; } }).filter((e) => e?.name === "RewardSkipped").length;
      return `Claimed in block ${receipt.blockNumber}.${skipped ? ` ${skipped} token${skipped === 1 ? "" : "s"} skipped; still claimable later.` : ""}`;
    }
    const receipt = await sendCall("claimAll", [], "claimAll", "msLog");
    return `Claimed every reward token in block ${receipt.blockNumber}. If a claim-all ever fails, claim tokens one at a time.`;
  });
}

function doClaimTo() {
  return run("msLog", async () => {
    const to = $("msClaimToAddr").value.trim();
    if (!isAddressLike(to) || /^0x0{40}$/i.test(to)) throw new Error("Enter the address to send rewards to.");
    if (lower(to) === lower(ms.address)) throw new Error("You can't send rewards to the staking contract.");
    const dest = ethers.getAddress(to);
    const code = await deps.withReadProvider((rpc) => rpc.getCode(dest));
    if (code && code !== "0x" && !$("msClaimToAddr").dataset.contractOk) {
      $("msClaimToAddr").dataset.contractOk = "1";
      throw new Error("That address is a contract. If it can't move tokens they'll be stuck. Press Claim to address again to send anyway.");
    }
    const pick = $("msClaimToToken").value;
    let receipt;
    if (pick === "all") {
      const tokens = ms.data.rewards.filter((r) => r.earned > 0n).map((r) => r.token);
      if (!tokens.length) throw new Error("Nothing to claim yet.");
      receipt = await sendCall("claimManyTo", [tokens, dest], "claimManyTo", "msLog");
    } else {
      receipt = await sendCall("claimTo", [pick, dest], "claimTo", "msLog");
    }
    delete $("msClaimToAddr").dataset.contractOk;
    return `Sent rewards to ${short(dest)} in block ${receipt.blockNumber}.`;
  });
}

function doCheckpoint() {
  return run("msLog", async () => {
    const tokens = ms.data?.tokens || [];
    if (!tokens.length) throw new Error("No reward tokens are listed.");
    const receipt = await sendCall("checkpoint", [tokens], "checkpoint", "msLog");
    return `Recorded your rewards for ${tokens.length} token${tokens.length === 1 ? "" : "s"} in block ${receipt.blockNumber}. Nothing was transferred.`;
  });
}

function doEmergency() {
  return run("msLog", async () => {
    if (!$("msEmergencyAck").checked) throw new Error("Tick the box to confirm first.");
    if (!ms.data?.staked) throw new Error("Nothing staked.");
    const receipt = await sendCall("emergencyWithdraw", [], "emergencyWithdraw", "msLog");
    $("msEmergencyAck").checked = false;
    $("msEmergencyBtn").disabled = true;
    return `Emergency withdraw done in block ${receipt.blockNumber}. All your BZB is back. What you earned is still claimable above.`;
  });
}

function doAccept() {
  return run("msLog", async () => {
    const receipt = await sendCall("acceptOwnership", [], "acceptOwnership", "msLog");
    return `You're now the owner (block ${receipt.blockNumber}).`;
  });
}

function doPause() {
  return run("msOwnerLog", async () => {
    const fn = ms.data.paused ? "unpause" : "pause";
    const receipt = await sendCall(fn, [], fn, "msOwnerLog");
    return `${fn === "pause" ? "Paused" : "Unpaused"} in block ${receipt.blockNumber}.`;
  });
}

function doAddTokens() {
  return run("msOwnerLog", async () => {
    errs("msAddErrs", []);
    const list = parseAddressList($("msAddTokens").value);
    const checked = list.filter(isAddressLike);
    const hasCode = {};
    await Promise.all(checked.map(async (a) => {
      const code = await deps.withReadProvider((rpc) => rpc.getCode(a));
      hasCode[a.toLowerCase()] = !!code && code !== "0x";
    }));
    const v = validateNewTokens(list, { listed: ms.data.tokens, self: ms.address, hasCode });
    if (!v.ok) {
      errs("msAddErrs", v.errors);
      throw new Error("Fix the token list first.");
    }
    const tokens = v.tokens.map((a) => ethers.getAddress(a));
    const receipt = tokens.length === 1
      ? await sendCall("addRewardToken", [tokens[0]], "addRewardToken", "msOwnerLog")
      : await sendCall("addRewardTokens", [tokens], "addRewardTokens", "msOwnerLog");
    $("msAddTokens").value = "";
    return `Listed ${tokens.length} reward token${tokens.length === 1 ? "" : "s"} in block ${receipt.blockNumber}. Listing is permanent.`;
  });
}

function doCreateRuns() {
  return run("msOwnerLog", async () => {
    errs("msRunErrs", []);
    const d = ms.data;
    const runs = ms.drafts.map(draftToRun);
    const pre = runs.map((r, i) => (r.amountErr ? `Run ${i + 1}: ${r.amountErr}` : null)).filter(Boolean);
    const activeRuns = {};
    const balances = {};
    for (const r of d.rewards) activeRuns[lower(r.token)] = r.activeRuns;
    for (const x of d.ownerExtra || []) balances[lower(x.token)] = x.ownerBal;
    const v = validateRuns(runs, { listed: d.tokens, activeRuns, balances, paused: d.paused });
    const all = [...pre, ...v.errors];
    if (all.length) {
      errs("msRunErrs", all);
      throw new Error("Fix the runs first.");
    }
    await deps.assertChain();
    for (const [key, total] of Object.entries(v.perTokenAmount)) {
      const meta = ms.meta.get(key);
      deps.log("msOwnerLog", `Approving ${fmtNice(total, meta.decimals)} ${meta.symbol}…`, "");
      await deps.ensureAllowance({ address: meta.address, symbol: meta.symbol, decimals: meta.decimals }, ms.address, total, "msOwnerLog");
    }
    const block = await deps.withReadProvider((rpc) => rpc.getBlock("latest"));
    const now = Number(block.timestamp);
    const cfgs = runs.map((r) => [ethers.getAddress(r.token), r.amount, BigInt(r.durationSec), startTimeFor(r.delaySec, now), r.startWeight, r.endWeight]);
    const receipt = cfgs.length === 1
      ? await sendCall("notifyRewardAmount", [cfgs[0]], "notifyRewardAmount", "msOwnerLog")
      : await sendCall("notifyRewardAmounts", [cfgs], "notifyRewardAmounts", "msOwnerLog");
    ms.drafts = [];
    return `Created ${cfgs.length} run${cfgs.length === 1 ? "" : "s"} in block ${receipt.blockNumber}.`;
  });
}

function recoverPick() {
  const token = $("msRecoverToken").value;
  const x = ms.data?.ownerExtra?.find((r) => lower(r.token) === lower(token));
  return { token, x, meta: ms.meta.get(lower(token)) };
}

function doRecover() {
  return run("msOwnerLog", async () => {
    errs("msRecoverErrs", []);
    const { token, x, meta } = recoverPick();
    if (!x || !meta) throw new Error("Pick a token.");
    let amount = 0n;
    try { amount = deps.parseUnits($("msRecoverAmount").value.trim(), meta.decimals); } catch (err) { errs("msRecoverErrs", [err.message]); throw err; }
    const to = $("msRecoverTo").value.trim();
    const v = validateRecover({ amount, recoverable: x.recoverable, to });
    if (!v.ok) {
      errs("msRecoverErrs", v.errors);
      throw new Error("Fix the recover inputs first.");
    }
    const receipt = await sendCall("recover", [token, amount, ethers.getAddress(to)], "recover", "msOwnerLog");
    $("msRecoverAmount").value = "";
    return `Recovered ${fmt(amount, meta.decimals, 6)} ${meta.symbol} surplus in block ${receipt.blockNumber}.`;
  });
}

/* ---------------- wiring ---------------- */

function wire() {
  if (ms.wired) return;
  ms.wired = true;
  $("msActionBtn").addEventListener("click", () => {
    if (!deps.state.account) {
      $("connectBtn").click();
      return;
    }
    if (ms.mode === "withdraw") doWithdraw();
    else doStake();
  });
  $("msModeStake").addEventListener("click", () => setMode("stake"));
  $("msModeWithdraw").addEventListener("click", () => setMode("withdraw"));
  $("msRuns").addEventListener("click", (e) => {
    const strip = e.target.closest("button[data-run-key]");
    if (!strip) return;
    const key = strip.dataset.runKey;
    if (ms.expanded.has(key)) ms.expanded.delete(key);
    else ms.expanded.add(key);
    if (ms.data) paintRuns(ms.data);
  });
  $("msExitBtn").addEventListener("click", doExit);
  $("msClaimAllBtn").addEventListener("click", doClaimAll);
  $("msCompoundBtn").addEventListener("click", doCompound);
  $("msClaimToBtn").addEventListener("click", doClaimTo);
  $("msClaimToAddr").addEventListener("input", () => { delete $("msClaimToAddr").dataset.contractOk; });
  $("msCheckpointBtn").addEventListener("click", doCheckpoint);
  $("msEmergencyAck").addEventListener("change", () => { $("msEmergencyBtn").disabled = !$("msEmergencyAck").checked; });
  $("msEmergencyBtn").addEventListener("click", doEmergency);
  $("msAcceptBtn").addEventListener("click", doAccept);
  $("msPauseBtn").addEventListener("click", doPause);
  $("msAddTokensBtn").addEventListener("click", doAddTokens);
  $("msCreateRunsBtn").addEventListener("click", doCreateRuns);
  $("msRecoverBtn").addEventListener("click", doRecover);
  $("msMax").addEventListener("click", () => {
    const v = ms.mode === "withdraw" ? ms.data?.staked : ms.data?.wallet;
    if (v != null) $("msAmount").value = fmt(v, 18, 18);
  });
  $("msRecoverMax").addEventListener("click", () => {
    const { x, meta } = recoverPick();
    if (x && meta) $("msRecoverAmount").value = fmt(x.recoverable, meta.decimals, meta.decimals);
  });
  $("msEarned").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-claim]");
    if (b) doClaim(b.dataset.claim);
  });
  $("msQuickTokens").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-quick]");
    if (!b) return;
    const cur = parseAddressList($("msAddTokens").value);
    if (!cur.some((a) => lower(a) === lower(b.dataset.quick))) cur.push(b.dataset.quick);
    $("msAddTokens").value = cur.join(", ");
  });
  $("msAddDraftBtn").addEventListener("click", () => {
    addDraft();
    ms.draftSig = "";
    paintDrafts();
  });
  const drafts = $("msDrafts");
  drafts.addEventListener("click", (e) => {
    const rm = e.target.closest("button[data-remove-draft]");
    if (rm) {
      ms.drafts = ms.drafts.filter((x) => String(x.id) !== rm.dataset.removeDraft);
      paintDrafts();
      return;
    }
    const pb = e.target.closest("button[data-preset]");
    if (pb) {
      const draft = ms.drafts.find((x) => String(x.id) === pb.closest(".ms-draft").dataset.draft);
      const p = CURVE_PRESETS[pb.dataset.preset];
      if (draft && p) {
        const card = pb.closest(".ms-draft");
        draft.startWeight = p.startWeight;
        draft.endWeight = p.endWeight;
        card.querySelector('[data-f="startWeight"]').value = String(p.startWeight);
        card.querySelector('[data-f="endWeight"]').value = String(p.endWeight);
        refreshDraftCard(card, draft);
      }
    }
  });
  const onEdit = (e) => {
    const f = e.target.dataset.f;
    if (!f) return;
    const card = e.target.closest(".ms-draft");
    const draft = ms.drafts.find((x) => String(x.id) === card?.dataset.draft);
    if (!draft) return;
    draft[f] = e.target.value;
    errs("msRunErrs", []);
    // Selects change the card's layout (token balance label, delay fields): re-render.
    // Typed fields update only the summary, presets and preview, so the input being typed in stays put.
    if (f === "token" || f === "startMode") {
      if (e.type === "change") paintDrafts();
      return;
    }
    refreshDraftCard(card, draft);
  };
  drafts.addEventListener("input", onEdit);
  drafts.addEventListener("change", onEdit);
  // Keep earned numbers fresh while the tab is open.
  ms.timer = setInterval(() => {
    if (!$("pane-stake").hidden && deps.state.account && !deps.state.busy && document.visibilityState === "visible") loadMultiStake().catch(() => {});
  }, 30_000);
}

/** Called once from desk.js boot with the desk's RPC / wallet helpers. */
export function initMultiStake(d) {
  deps = d;
  ms.address = configured();
  ms.enabled = !!ms.address;
  paintMode();
}
