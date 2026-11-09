package net.blazarforce.crypto

import java.util.concurrent.atomic.AtomicReference
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PinThrottleTest {
    @Test
    fun forwardWallClockDoesNotExpireThePause() {
        val stamp = PinThrottle.fail(PinThrottle.Stamp(4, 0L, 0L), monotonicNow = 5_000L, wallClockNow = 1L)
        assertTrue(PinThrottle.locked(stamp, monotonicNow = 5_000L, wallClockNow = Long.MAX_VALUE))
        assertEquals(35_000L, stamp.untilElapsed)
    }

    @Test
    fun backwardWallClockDoesNotExpireThePause() {
        val stamp = PinThrottle.Stamp(5, 5_000L, 35_000L)
        assertTrue(PinThrottle.locked(stamp, monotonicNow = 6_000L, wallClockNow = Long.MIN_VALUE))
    }

    @Test
    fun monotonicExpiryDoesOpenThePause() {
        val stamp = PinThrottle.Stamp(5, 5_000L, 35_000L)
        assertFalse(PinThrottle.locked(stamp, monotonicNow = 35_000L, wallClockNow = 0L))
    }

    @Test
    fun rebootRestartsAFullPenaltyWhenFailuresAlreadyCounted() {
        val stamp = PinThrottle.Stamp(5, 10_000L, 40_000L)
        val rebased = PinThrottle.rebase(stamp, monotonicNow = 100L)
        assertEquals(30_100L, rebased.untilElapsed)
        assertTrue(PinThrottle.locked(stamp, monotonicNow = 100L, wallClockNow = 9_000_000_000_000L))
    }

    @Test
    fun fourFailuresDoNotLock() {
        var stamp = PinThrottle.Stamp(0, 0L, 0L)
        repeat(4) { stamp = PinThrottle.fail(stamp, monotonicNow = 50L, wallClockNow = -50L) }
        assertFalse(PinThrottle.locked(stamp, monotonicNow = 50L, wallClockNow = 50L))
    }

    @Test
    fun exclusiveAttemptsDoNotDropFailures() {
        val gate = PinThrottle.Gate()
        val stamp = AtomicReference(PinThrottle.Stamp(0, 0L, 0L))
        val threads = (1..20).map {
            Thread {
                gate.exclusive {
                    stamp.set(PinThrottle.fail(stamp.get(), monotonicNow = 1_000L, wallClockNow = Long.MAX_VALUE))
                }
            }
        }
        threads.forEach { it.start() }
        threads.forEach { it.join() }
        assertEquals(20, stamp.get().fails)
        assertTrue(PinThrottle.locked(stamp.get(), monotonicNow = 1_000L, wallClockNow = 0L))
    }
}
