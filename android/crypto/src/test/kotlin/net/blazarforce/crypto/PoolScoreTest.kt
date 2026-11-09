package net.blazarforce.crypto

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PoolScoreTest {
    private val day = 86_400.0

    @Test
    fun liquidityOutweighsAMuchOlderThinPool() {
        val ranked = PoolScore.rank(
            listOf(
                PoolScore.Facts("deep", 1_000_000.0, 1 * day),
                PoolScore.Facts("thin", 10_000.0, 1000 * day),
            ),
        )
        assertEquals("deep", ranked.first().address)
        val expected = 0.7 + 0.3 * (1.0 / 1000.0)
        assertTrue(kotlin.math.abs(ranked.first().score - expected) < 1e-9)
    }

    @Test
    fun closeLiquidityLetsTheLongerHistoryWin() {
        val ranked = PoolScore.rank(
            listOf(
                PoolScore.Facts("newer", 100.0, 10 * day),
                PoolScore.Facts("older", 95.0, 1000 * day),
            ),
        )
        assertEquals("older", ranked.first().address)
    }

    @Test
    fun equalLiquidityPrefersTheOlderPool() {
        val ranked = PoolScore.rank(
            listOf(
                PoolScore.Facts("a", 50.0, 10.0),
                PoolScore.Facts("b", 50.0, 20.0),
            ),
        )
        assertEquals("b", ranked.first().address)
        assertTrue(ranked[0].score > ranked[1].score)
    }

    @Test
    fun tiedScorePrefersMoreLiquidity() {
        val ranked = PoolScore.rank(
            listOf(
                PoolScore.Facts("deeper", 70.0, 0.0),
                PoolScore.Facts("older", 40.0, 100.0),
            ),
        )
        assertEquals(ranked[0].score, ranked[1].score)
        assertEquals("deeper", ranked.first().address)
    }
}
