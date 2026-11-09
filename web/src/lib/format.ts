export function shortAddr(address: string) {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function parseAmount(value: string, decimals: number): bigint | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) return null;
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  try {
    return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
  } catch {
    return null;
  }
}

export function formatAmount(value: bigint, decimals: number, max = 6) {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  let fracStr = frac.toString().padStart(decimals, "0").slice(0, max).replace(/0+$/, "");
  const text = fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
  return negative ? `-${text}` : text;
}

export function formatUsd(value: number) {
  if (!Number.isFinite(value)) return "—";
  if (value > 0 && value < 0.01) return `$${value.toPrecision(2)}`;
  return value.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

export function bpsLabel(bps: number) {
  const pct = bps / 100;
  const text = pct.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${text}%`;
}

export function usdFromE8(value: bigint) {
  return Number(value) / 1e8;
}
