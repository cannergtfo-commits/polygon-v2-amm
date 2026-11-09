package net.blazarforce.crypto

/**
 * Same rule as web/src/lib/pool-score.ts.
 *
 * score = 0.70 * norm(liquidityUsd) + 0.30 * norm(ageSeconds)
 * norm(x) = x / max(x) in the set, or 0 when that max is 0.
 * Ties prefer more liquidity, then a longer history.
 * Age stands in for candle history so pool selection does not spend
 * a GeckoTerminal request per pool.
 */
object PoolScore {
    const val LIQUIDITY_WEIGHT = 0.70
    const val HISTORY_WEIGHT = 0.30

    data class Facts(val address: String, val liquidityUsd: Double, val ageSeconds: Double)
    data class Scored(
        val address: String,
        val liquidityUsd: Double,
        val ageSeconds: Double,
        val score: Double,
    )

    fun rank(pools: List<Facts>): List<Scored> {
        val rows = pools.map {
            Facts(
                it.address,
                if (it.liquidityUsd.isFinite()) it.liquidityUsd.coerceAtLeast(0.0) else 0.0,
                if (it.ageSeconds.isFinite()) it.ageSeconds.coerceAtLeast(0.0) else 0.0,
            )
        }
        val maxLiquidity = rows.maxOfOrNull { it.liquidityUsd } ?: 0.0
        val maxAge = rows.maxOfOrNull { it.ageSeconds } ?: 0.0
        return rows.map { row ->
            val liquidityNorm = if (maxLiquidity > 0) row.liquidityUsd / maxLiquidity else 0.0
            val historyNorm = if (maxAge > 0) row.ageSeconds / maxAge else 0.0
            Scored(row.address, row.liquidityUsd, row.ageSeconds, LIQUIDITY_WEIGHT * liquidityNorm + HISTORY_WEIGHT * historyNorm)
        }.sortedWith(compareByDescending<Scored> { it.score }.thenByDescending { it.liquidityUsd }.thenByDescending { it.ageSeconds })
    }
}
