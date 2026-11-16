/**
 * Token names and symbols come from arbitrary contracts: treat them as untrusted display text.
 * Never match on them for anything that moves funds; never pass them on as instructions.
 */
// zero-width, BOM, soft hyphen, bidi controls and isolates
const INVISIBLE = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Canonical symbols that are resolved from this table only, never from on-chain text. */
export const RESERVED = ["POL", "MATIC", "WPOL", "WMATIC", "USDC", "USDC.E", "USDT", "WETH", "ETH", "WBTC", "BTC", "DAI", "BZB"];

export function sanitizeText(raw, max = 32) {
  if (raw === null || raw === undefined) return "";
  return String(raw).normalize("NFKC").replace(CONTROL, "").replace(INVISIBLE, "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Flags for one token's on-chain text.
 * nonAscii: symbol has characters outside printable ASCII (possible look-alike).
 * changed: the raw value carried control or invisible characters that were removed.
 * impersonates: the sanitized symbol (or its ASCII skeleton) looks like a reserved symbol
 *   (exactly, or ignoring dots/spaces/punctuation) while the token is not the canonical one.
 */
export function textFlags(rawSymbol, rawName, { canonical = false } = {}) {
  const symbol = sanitizeText(rawSymbol, 24);
  const name = sanitizeText(rawName, 48);
  const flags = [];
  if (/[^\x20-\x7e]/.test(symbol)) flags.push("nonAscii");
  if (String(rawSymbol ?? "") !== symbol || String(rawName ?? "").replace(/\s+/g, " ").trim().slice(0, 48) !== name) flags.push("changed");
  const skeleton = symbol.toUpperCase().replace(/[^A-Z0-9.]/g, "");
  const undotted = skeleton.replace(/\./g, "");
  if (!canonical && RESERVED.some((r) => skeleton === r || undotted === r.replace(/\./g, ""))) flags.push("impersonates");
  return { symbol, name, flags };
}

/** Symbol key used for lookups: printable ASCII only, case-insensitive. Non-ASCII symbols never match. */
export function symbolKey(symbol) {
  const s = sanitizeText(symbol, 24);
  return /^[\x21-\x7e]+$/.test(s) ? s.toLowerCase() : null;
}
