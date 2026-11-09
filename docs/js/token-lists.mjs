/** Remote token lists merged into the swap picker. Pure helpers; desk.js does the fetch. */

/** PolyPump launchpad: every token that graduated (bonded) to QuickSwap V2 and was not removed. */
export const POLYPUMP_LIST_URL = "https://launch.blazarforce.net/tokenlist.json";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/*
 * Impersonation checks (review B-2). Same rules as PolyPump app/shared/reserved.js; keep in sync.
 * Symbols a permissionless launch must never be shown under (major assets and Blazar's own),
 * look-alike symbols (non-ASCII), reserved tickers with short suffixes, and names that impersonate
 * major assets on a TR39-style confusable skeleton. The launchpad already refuses and de-lists
 * these; this is a second, client-side check.
 */
// ---- B-2: confusable skeleton (subset of Unicode TR39 confusables, targeted at Latin look-alikes).
// NFKD + drop combining marks folds accents and compatibility forms (fullwidth, math alphanumerics,
// ligatures). The table then maps the Cyrillic / Greek / Armenian / Cherokee / misc letters that
// render like Latin capitals or lowercase, plus digit look-alikes (0->O, 1/l/|->I). Compare skeletons,
// never raw strings. Symbols are additionally restricted to ASCII so the table need not be complete.
const CONFUSABLE = {
  // Cyrillic capitals
  'А': 'A', 'В': 'B', 'Б': 'B', 'Ь': 'B', 'С': 'C', 'Е': 'E', 'Ё': 'E', 'Н': 'H', 'І': 'I', 'Ї': 'I', 'Ӏ': 'I', 'Ј': 'J', 'К': 'K', 'М': 'M', 'О': 'O', 'Р': 'P', 'Ѕ': 'S', 'Т': 'T', 'Х': 'X', 'У': 'Y', 'Ү': 'Y', 'З': '3', 'Ԁ': 'D', 'Ԛ': 'Q', 'Ԝ': 'W', 'П': 'N', 'И': 'N', 'Л': 'N', 'Ц': 'U', 'Џ': 'U', 'Г': 'R',
  // Cyrillic small
  'а': 'a', 'в': 'b', 'б': 'b', 'ь': 'b', 'с': 'c', 'ԁ': 'd', 'е': 'e', 'ё': 'e', 'һ': 'h', 'н': 'h', 'і': 'i', 'ї': 'i', 'ј': 'j', 'к': 'k', 'м': 'm', 'о': 'o', 'р': 'p', 'ԛ': 'q', 'ѕ': 's', 'т': 't', 'х': 'x', 'у': 'y', 'ү': 'y', 'ԝ': 'w', 'п': 'n', 'и': 'u', 'ц': 'u', 'џ': 'u', 'г': 'r', 'з': '3',
  // Greek
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X', 'Ϲ': 'C', 'Ϝ': 'F', 'Δ': 'A', 'Λ': 'A', 'Σ': 'E', 'Π': 'N', 'Ω': 'O',
  'α': 'a', 'β': 'b', 'γ': 'y', 'δ': 'd', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'σ': 'o', 'τ': 't', 'υ': 'u', 'χ': 'x', 'ω': 'w', 'ϲ': 'c', 'μ': 'u', 'µ': 'u', 'ϻ': 'm',
  // Armenian / Cherokee / Latin extras
  'Օ': 'O', 'օ': 'o', 'Ս': 'U', 'ս': 'u', 'Ꭺ': 'A', 'Ᏼ': 'B', 'Ꮯ': 'C', 'Ꭼ': 'E', 'Ꮋ': 'H', 'Ꮶ': 'K', 'Ꮇ': 'M', 'Ꮲ': 'P', 'Ꮪ': 'S', 'Ꭲ': 'T', 'Ꮃ': 'W',
  'ı': 'i', 'ȷ': 'j', 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D', 'ø': 'o', 'Ø': 'O', 'ß': 'ss', 'æ': 'ae', 'Æ': 'AE', 'œ': 'oe', 'Œ': 'OE', 'ɑ': 'a', 'ɡ': 'g', 'ʏ': 'Y', 'ʙ': 'B', 'ᴅ': 'D', 'ᴇ': 'E', 'ᴋ': 'K', 'ᴍ': 'M', 'ᴏ': 'O', 'ᴘ': 'P', 'ᴛ': 'T', 'ᴜ': 'U', 'ᴠ': 'V', 'ᴡ': 'W', 'ᴢ': 'Z', 'ꜱ': 'S', 'ʀ': 'R', 'ɴ': 'N', 'ʜ': 'H', 'ɪ': 'I', 'ʟ': 'L', 'ᴄ': 'C',
  '$': 'S', '€': 'E', '¢': 'C', '₿': 'B', 'Ξ': 'E', '|': 'I', '!': 'I',
};
const INVISIBLE = /[\p{C}\p{Z}\s\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u3164\uffa0\ufe00-\ufe0f]/gu;

/**
 * TR39-style skeleton, uppercased, keeping only A-Z and 0-9 (with 0->O, 1->I so "US0C"/"W1BTC"
 * fold too). `keepSpaces` keeps single spaces (for whole-word name rules).
 */
export function skeleton(s, { keepSpaces = false } = {}) {
  let out = '';
  for (const ch of String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '')) out += CONFUSABLE[ch] ?? ch;
  out = out.normalize('NFKC').toUpperCase().replace(/0/g, 'O').replace(/1/g, 'I').replace(/L/g, 'I');
  if (keepSpaces) return out.replace(/[^A-Z0-9]+/g, ' ').trim();
  return out.replace(INVISIBLE, '').replace(/[^A-Z0-9]/g, '');
}

/** Symbols must be printable ASCII (letters, digits, and . - _ only, whitespace ignored). */
export const ASCII_SYMBOL = /^[A-Za-z0-9._-]+$/;

export const RESERVED_SYMBOLS = new Set([
  'USDC', 'USDCE', 'USDC.E', 'USDT', 'USDT0', 'DAI', 'FRAX', 'TUSD', 'BUSD', 'USDE', 'PYUSD', 'LUSD', 'GHO', 'EURC', 'EURS', 'MIMATIC', 'MAI',
  'WETH', 'ETH', 'STETH', 'WSTETH', 'WBTC', 'BTC', 'TBTC', 'CBBTC',
  'WPOL', 'POL', 'MATIC', 'WMATIC', 'STMATIC', 'MATICX',
  'BZB', 'BLAZAR', 'BLAZARBITS',
  'LINK', 'AAVE', 'UNI', 'QUICK', 'DQUICK', 'CRV', 'BAL', 'SUSHI', 'GRT', 'SAND', 'MANA', 'GHST',
]);
// B-2 suffix/prefix rule (compared on skeletons). Money-like tickers of 4+ characters also reserve
// ANY 1-2 character suffix and any 1 character prefix (USDC2, USDCx, xUSDC, WPOL2, USDTE). Every
// other reserved ticker (and 3-letter ones like ETH/POL/BZB) reserves digit / X / E suffixes only
// (ETH2, BZBX, POL2, BALX), so ordinary words (BALL, POLY, ETHOS, UNIT) stay usable.
const CORE = ['USDC', 'USDT', 'FRAX', 'TUSD', 'BUSD', 'USDE', 'PYUSD', 'LUSD', 'EURC', 'EURS', 'WETH', 'WBTC', 'WPOL', 'MATIC', 'WMATIC', 'BLAZAR'];
const SK = (x) => skeleton(x);
const RESERVED_SK = new Set([...RESERVED_SYMBOLS].map(SK));
const BY_SK = new Map([...RESERVED_SYMBOLS].map((x) => [SK(x), x]));
const CORE_SK = new Set(CORE.map(SK));
// Whole-word name fragments, matched against the spaced skeleton of the name.
const RESERVED_NAME = /\b(USD\s*COIN|USDC|USDT|TETHER|WRAPPED\s+(ETHER|ETH|BTC|BITCOIN|MATIC|POI)|POIYGON\s+ECOSYSTEM\s+TOKEN|MATIC\s+TOKEN|DAI\s+STABIECOIN|BIAZAR\s*BITS|BIAZARBITS|BIAZAR\s*BYTE|POIYPUMP\s+OFFICIAI)\b/;

/** Why `symbol` is not allowed (or null). */
export function symbolProblem(symbol) {
  const raw = String(symbol ?? '').replace(/\s+/g, '');
  if (!raw) return 'symbol is required';
  if (!ASCII_SYMBOL.test(raw)) return 'symbols must be plain ASCII letters and digits (look-alike characters are not allowed)';
  const up = raw.toUpperCase().replace(/[._-]/g, '');
  const sk = SK(up); // ASCII only here, so sk and up have the same length
  const shown = raw.toUpperCase();
  if (RESERVED_SK.has(sk)) return `${shown} is a reserved ticker (looks like ${BY_SK.get(sk)})`;
  for (const [r, orig] of BY_SK) {
    if (sk.length <= r.length || sk.length > r.length + 2) continue;
    if (sk.startsWith(r) && (CORE_SK.has(r) || /^[0-9XE]+$/.test(up.slice(r.length)))) return `${shown} looks like ${orig} with a suffix`;
    if (CORE_SK.has(r) && sk.length === r.length + 1 && sk.endsWith(r)) return `${shown} looks like ${orig} with a prefix`;
  }
  return null;
}

/** Why `name` is not allowed (or null). */
export function nameProblem(name) {
  const flat = SK(name);
  if (RESERVED_SK.has(flat)) return `that name is a reserved ticker (looks like ${BY_SK.get(flat)})`;
  if (RESERVED_NAME.test(' ' + skeleton(name, { keepSpaces: true }) + ' ') || RESERVED_NAME.test(flat)) return 'that name impersonates a major asset';
  return null;
}

/** Reason the name/symbol pair is refused, or null. */
export function reservedReason(name, symbol) {
  return symbolProblem(symbol) || nameProblem(name);
}

/** True when the symbol or name impersonates a reserved asset (or the symbol is not plain ASCII). */
export function isReserved(name, symbol) {
  return reservedReason(name, symbol) !== null;
}

function clean(text, max, noSpace) {
  let out = String(text ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "");
  out = noSpace ? out.replace(/\s+/g, "") : out.replace(/\s+/g, " ").trim();
  return [...out].slice(0, max).join("");
}

/**
 * Merge a tokenlists.org list into `tokens` in place. Only chain 137 entries with a valid address
 * are taken; addresses already present (pinned Blazar assets, Uniswap list) are never overridden.
 * Logos must be https. Entries with a reserved, non-ASCII or reserved-plus-suffix symbol (USDC2,
 * USDCx), a name impersonating a major asset, or a symbol or name whose confusable skeleton matches
 * a token already in the picker, are dropped (impersonation, review B-2). With `unverified` (default true) every added token is flagged
 * so the picker can label it. Returns the newly added tokens.
 */
export function mergeTokenList(tokens, list, source, chainId = 137, { unverified = true } = {}) {
  if (!list || !Array.isArray(list.tokens)) return [];
  const seen = new Set(tokens.map((token) => String(token.address).toLowerCase()));
  // Dedupe on confusable skeletons, so "FR0G" or a Cyrillic "ВZB" collide with "FROG" / "BZB".
  const symbols = new Set(tokens.map((token) => skeleton(token.symbol)));
  const names = new Set(tokens.map((token) => skeleton(token.name)).filter(Boolean));
  const added = [];
  for (const entry of list.tokens.slice(0, 2000)) {
    if (!entry || Number(entry.chainId) !== chainId || !ADDRESS.test(String(entry.address))) continue;
    const key = entry.address.toLowerCase();
    if (seen.has(key)) continue;
    const decimals = Number(entry.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) continue;
    const symbol = clean(entry.symbol, 20, true);
    if (!symbol) continue;
    const name = clean(entry.name, 60, false) || symbol;
    if (symbolProblem(symbol) || nameProblem(name)) continue; // reserved, look-alike or suffixed
    const symKey = skeleton(symbol);
    const nameKey = skeleton(name);
    if (symbols.has(symKey) || (nameKey && names.has(nameKey))) continue; // reuses a symbol or name already in the picker
    const token = { symbol, name, address: entry.address, decimals, source };
    if (unverified || entry.extensions?.verified === false) token.unverified = true;
    const quoteAsset = entry.extensions?.quoteAsset;
    if (quoteAsset === "POL" || quoteAsset === "BZB") token.quoteAsset = quoteAsset;
    // B-4: graduated BZB tokens sit in a small TOKEN/BZB pool (seeded with ~10k BZB).
    if (quoteAsset === "BZB" || (Array.isArray(entry.tags) && entry.tags.includes("thin_pool"))) token.thinPool = true;
    if (typeof entry.logoURI === "string" && /^https:\/\//.test(entry.logoURI)) token.logo = entry.logoURI;
    const pair = entry.extensions?.pair;
    if (typeof pair === "string" && ADDRESS.test(pair)) token.pair = pair;
    seen.add(key);
    symbols.add(symKey);
    if (nameKey) names.add(nameKey);
    tokens.push(token);
    added.push(token);
  }
  return added;
}
