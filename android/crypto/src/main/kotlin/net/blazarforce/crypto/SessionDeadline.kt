package net.blazarforce.crypto

/**
 * One monotonic idle window. A successful create or unlock must arm a fresh
 * baseline. An old baseline must not be reused for a newly exposed secret.
 */
object SessionDeadline {
    const val WINDOW_MS = 60_000L
    const val WARN_BEFORE_MS = 15_000L
    const val DRAFT_WARNING = "This unsaved seed will be cleared in 15 seconds. It has not been stored."
    const val DRAFT_CLEARED = "The unsaved seed was cleared after 60 seconds. It was not stored. Start again if you still want a wallet."

    enum class Phase { OPEN, WARN, CLEAR }

    fun arm(now: Long): Long {
        require(now >= 0L) { "monotonic time" }
        return now
    }

    fun deadline(
        mnemonicExposed: Boolean,
        armedAt: Long,
        boxUntil: Long,
        boxExposed: Boolean,
        draftExposed: Boolean = false,
    ): Long? = when {
        mnemonicExposed -> armedAt + WINDOW_MS
        boxExposed -> boxUntil
        draftExposed -> armedAt + WINDOW_MS
        else -> null
    }

    fun expired(deadline: Long?, now: Long): Boolean = deadline != null && now >= deadline

    fun draftPhase(armedAt: Long, now: Long): Phase {
        val elapsed = now - armedAt
        return when {
            elapsed >= WINDOW_MS -> Phase.CLEAR
            elapsed >= WINDOW_MS - WARN_BEFORE_MS -> Phase.WARN
            else -> Phase.OPEN
        }
    }

    /** A secret action may proceed only while the draft clock has not cleared it. */
    fun allowSecretAction(phase: Phase): Boolean = phase != Phase.CLEAR
}
