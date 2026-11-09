/**
 * Pick the pool that should back a token chart.
 *
 * history is pool age in seconds (pool_created_at). Candle counts are not
 * fetched for every pool: that would spend the ~30 requests/minute budget
 * before a chart is drawn. Age is the history signal.
 *
 *   norm(x) = x / max(x) across the set, or 0 when the max is 0
 *   score   = 0.70 * norm(liquidityUsd) + 0.30 * norm(ageSeconds)
 *
 * The highest score wins. Ties break toward more liquidity, then older pools.
 */
export const LIQUIDITY_WEIGHT = 0.7;
export const HISTORY_WEIGHT = 0.3;

export type PoolFacts = {
  address: string;
  liquidityUsd: number;
  ageSeconds: number;
};

export type ScoredPool = PoolFacts & {
  liquidityNorm: number;
  historyNorm: number;
  score: number;
};

export function scorePools(pools: PoolFacts[]): ScoredPool[] {
  const rows = pools.map((pool) => ({
    address: pool.address,
    liquidityUsd: Number.isFinite(pool.liquidityUsd) ? Math.max(0, pool.liquidityUsd) : 0,
    ageSeconds: Number.isFinite(pool.ageSeconds) ? Math.max(0, pool.ageSeconds) : 0,
  }));
  const maxLiquidity = rows.reduce((max, row) => Math.max(max, row.liquidityUsd), 0);
  const maxAge = rows.reduce((max, row) => Math.max(max, row.ageSeconds), 0);
  return rows
    .map((row) => {
      const liquidityNorm = maxLiquidity > 0 ? row.liquidityUsd / maxLiquidity : 0;
      const historyNorm = maxAge > 0 ? row.ageSeconds / maxAge : 0;
      return {
        ...row,
        liquidityNorm,
        historyNorm,
        score: LIQUIDITY_WEIGHT * liquidityNorm + HISTORY_WEIGHT * historyNorm,
      };
    })
    .sort((a, b) => b.score - a.score || b.liquidityUsd - a.liquidityUsd || b.ageSeconds - a.ageSeconds);
}
