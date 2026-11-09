package net.blazarforce.crypto

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SessionDeadlineTest {
    @Test
    fun unlockAfterALongIdleGetsAFreshMinute() {
        val stale = 1_000L
        val unlockedAt = stale + 120_000L
        val armed = SessionDeadline.arm(unlockedAt)
        val deadline = SessionDeadline.deadline(mnemonicExposed = true, armedAt = armed, boxUntil = 0L, boxExposed = false)
        assertEquals(unlockedAt + SessionDeadline.WINDOW_MS, deadline)
        assertFalse(SessionDeadline.expired(deadline, unlockedAt))
        assertFalse(SessionDeadline.expired(deadline, unlockedAt + 59_000L))
        assertTrue(SessionDeadline.expired(deadline, unlockedAt + 60_000L))
    }

    @Test
    fun anOldBaselineWouldAlreadyBeExpired() {
        val started = 5_000L
        val unlockedAt = started + 61_000L
        val inherited = SessionDeadline.deadline(mnemonicExposed = true, armedAt = started, boxUntil = 0L, boxExposed = false)
        assertTrue(SessionDeadline.expired(inherited, unlockedAt))
    }

    @Test
    fun unwrappedBoxUsesItsOwnDeadline() {
        val until = 50_000L
        val deadline = SessionDeadline.deadline(mnemonicExposed = false, armedAt = 0L, boxUntil = until, boxExposed = true)
        assertEquals(until, deadline)
        assertFalse(SessionDeadline.expired(deadline, until - 1))
        assertTrue(SessionDeadline.expired(deadline, until))
    }

    @Test
    fun nothingExposedHasNoDeadline() {
        assertNull(SessionDeadline.deadline(mnemonicExposed = false, armedAt = 10L, boxUntil = 10L, boxExposed = false))
    }

    @Test
    fun aDraftPhraseUsesTheSameMinute() {
        val kinds = listOf("reveal", "check", "import", "pin-before-save")
        val armed = SessionDeadline.arm(10_000L)
        for (kind in kinds) {
            val deadline = SessionDeadline.deadline(
                mnemonicExposed = false,
                armedAt = armed,
                boxUntil = 0L,
                boxExposed = false,
                draftExposed = true,
            )
            assertEquals(armed + SessionDeadline.WINDOW_MS, deadline, kind)
            assertEquals(SessionDeadline.Phase.OPEN, SessionDeadline.draftPhase(armed, armed + 44_000L), kind)
            assertEquals(SessionDeadline.Phase.WARN, SessionDeadline.draftPhase(armed, armed + 45_000L), kind)
            assertEquals(SessionDeadline.Phase.CLEAR, SessionDeadline.draftPhase(armed, armed + 60_000L), kind)
            assertFalse(SessionDeadline.allowSecretAction(SessionDeadline.draftPhase(armed, armed + 60_000L)), kind)
            assertTrue(SessionDeadline.allowSecretAction(SessionDeadline.draftPhase(armed, armed + 59_000L)), kind)
        }
    }

    @Test
    fun repeatedUnlocksDoNotKeepThePreviousArm() {
        val first = SessionDeadline.arm(1_000L)
        val second = SessionDeadline.arm(90_000L)
        val deadline = SessionDeadline.deadline(mnemonicExposed = true, armedAt = second, boxUntil = first, boxExposed = true)
        assertEquals(second + SessionDeadline.WINDOW_MS, deadline)
        assertFalse(SessionDeadline.expired(deadline, 90_000L))
    }
}
