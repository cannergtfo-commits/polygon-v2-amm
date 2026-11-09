/** Remote token lists merged into the swap picker. Pure helpers; desk.js does the fetch. */

/** PolyPump launchpad: every token that graduated (bonded) to QuickSwap V2 and was not removed. */
export const POLYPUMP_LIST_URL = "https://launch.blazarforce.net/tokenlist.json";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Symbols a permissionless launch must never be shown under (major assets and Blazar's own). The
 * launchpad already refuses and de-lists these; this is a second, client-side check.
 */
export const RESERVED_SYMBOLS = new Set([
  "USDC", "USDCE", "USDC.E", "USDT", "USDT0", "DAI", "FRAX", "TUSD", "BUSD", "USDE", "PYUSD", "LUSD", "GHO", "EURC", "EURS", "MIMATIC", "MAI",
  "WETH", "ETH", "STETH", "WSTETH", "WBTC", "BTC", "TBTC", "CBBTC",
  "WPOL", "POL", "MATIC", "WMATIC", "STMATIC", "MATICX",
  "BZB", "BLAZAR", "BLAZARBITS",
  "LINK", "AAVE", "UNI", "QUICK", "DQUICK", "CRV", "BAL", "SUSHI", "GRT", "SAND", "MANA", "GHST",
]);

function clean(text, max, noSpace) {
  let out = String(text ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "");
  out = noSpace ? out.replace(/\s+/g, "") : out.replace(/\s+/g, " ").trim();
  return [...out].slice(0, max).join("");
}

/**
 * Merge a tokenlists.org list into `tokens` in place. Only chain 137 entries with a valid address
 * are taken; addresses already present (pinned Blazar assets, Uniswap list) are never overridden.
 * Logos must be https. Entries reusing a reserved symbol, or the symbol of a token already in the
 * picker, are dropped (impersonation). With `unverified` (default true) every added token is flagged
 * so the picker can label it. Returns the newly added tokens.
 */
export function mergeTokenList(tokens, list, source, chainId = 137, { unverified = true } = {}) {
  if (!list || !Array.isArray(list.tokens)) return [];
  const seen = new Set(tokens.map((token) => String(token.address).toLowerCase()));
  const symbols = new Set(tokens.map((token) => String(token.symbol).toUpperCase()));
  const added = [];
  for (const entry of list.tokens.slice(0, 2000)) {
    if (!entry || Number(entry.chainId) !== chainId || !ADDRESS.test(String(entry.address))) continue;
    const key = entry.address.toLowerCase();
    if (seen.has(key)) continue;
    const decimals = Number(entry.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) continue;
    const symbol = clean(entry.symbol, 20, true);
    if (!symbol) continue;
    const upper = symbol.toUpperCase();
    if (RESERVED_SYMBOLS.has(upper) || RESERVED_SYMBOLS.has(upper.replace(/\./g, "")) || symbols.has(upper)) continue;
    const token = { symbol, name: clean(entry.name, 60, false) || symbol, address: entry.address, decimals, source };
    if (unverified || entry.extensions?.verified === false) token.unverified = true;
    const quoteAsset = entry.extensions?.quoteAsset;
    if (quoteAsset === "POL" || quoteAsset === "BZB") token.quoteAsset = quoteAsset;
    if (typeof entry.logoURI === "string" && /^https:\/\//.test(entry.logoURI)) token.logo = entry.logoURI;
    const pair = entry.extensions?.pair;
    if (typeof pair === "string" && ADDRESS.test(pair)) token.pair = pair;
    seen.add(key);
    symbols.add(upper);
    tokens.push(token);
    added.push(token);
  }
  return added;
}
