export type SideToken = { address: string; symbol: string };

const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const ZERO = "0x0000000000000000000000000000000000000000";

export function sameAsset(a: string, b: string, wpol: string) {
  const norm = (value: string) => {
    const key = value.toLowerCase();
    if (key === NATIVE || key === ZERO) return wpol.toLowerCase();
    return key;
  };
  return norm(a) === norm(b);
}

/** Put `next` on the buy side. Keep the pay token unless that would make both sides the same asset. */
export function selectBuyToken<T extends SideToken>(pay: T, currentBuy: T, next: T, fallbacks: T[], wpol: string): { pay: T; buy: T } | null {
  if (!sameAsset(pay.address, next.address, wpol)) return { pay, buy: next };
  if (!sameAsset(currentBuy.address, next.address, wpol)) return { pay: currentBuy, buy: next };
  const other = fallbacks.find((item) => !sameAsset(item.address, next.address, wpol));
  if (!other) return null;
  return { pay: other, buy: next };
}

export function slippageBpsOf(text: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(text.trim())) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0.01 || value > 5) return null;
  return Math.round(value * 100);
}

export function quoteRequestKey(parts: { chainId?: number; account?: string; sell: string; buy: string; amount: string; slippageBps: number }) {
  return [parts.chainId ?? 0, (parts.account ?? "").toLowerCase(), parts.sell.toLowerCase(), parts.buy.toLowerCase(), parts.amount, parts.slippageBps].join("|");
}

export function quoteIsStale(quotedAt: number, now: number, maxAgeMs = 45_000) {
  return quotedAt <= 0 || now - quotedAt > maxAgeMs;
}
