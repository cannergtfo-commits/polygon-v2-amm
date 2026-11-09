const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const ZERO = "0x0000000000000000000000000000000000000000";

/** One id for native POL, the zero address, and WPOL. Display fields stay untouched. */
export function canonicalAsset(address, wpol) {
  const key = String(address ?? "").toLowerCase();
  if (key === NATIVE || key === ZERO) return String(wpol).toLowerCase();
  return key;
}

/**
 * Subtract the overlapping score of a same-wallet reverse within the window.
 * Matching uses canonical assets. Raw token fields are not rewritten.
 * This is not a Sybil or wash-trading proof.
 */
export function subtractRoundTrips(trades, windowSec, wpol) {
  const counted = trades.map((trade) => ({
    ...trade,
    assetIn: canonicalAsset(trade.tokenIn, wpol),
    assetOut: canonicalAsset(trade.tokenOut, wpol),
  }));
  for (let i = 0; i < counted.length; i++) {
    for (let j = i + 1; j < counted.length; j++) {
      const a = counted[i];
      const b = counted[j];
      if (a.trader !== b.trader) continue;
      if (Math.abs(a.time - b.time) > windowSec) continue;
      const flipped = a.assetIn === b.assetOut && a.assetOut === b.assetIn;
      if (!flipped) continue;
      const wash = Math.min(a.score, b.score);
      a.score -= wash;
      b.score -= wash;
    }
  }
  return counted;
}
