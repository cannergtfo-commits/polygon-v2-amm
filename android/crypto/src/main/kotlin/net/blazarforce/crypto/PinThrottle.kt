package net.blazarforce.crypto

/**
 * PIN pause. Only [monotonicNow] (elapsedRealtime) can expire it.
 * [wallClockNow] is accepted and ignored so a forward or backward wall-clock
 * change cannot shorten the pause.
 *
 * If the monotonic clock moves backwards, the device rebooted or the clock
 * source reset. A pause that was in force is started again for the full
 * penalty, because this process cannot prove the old pause had finished.
 * The stamp has to be persisted by the caller. Clearing app data removes it.
 * Attempts that touch the vault must go through one [Gate].
 */
object PinThrottle {
    const val PENALTY_MS = 30_000L
    const val FAILS_BEFORE_PENALTY = 5

    data class Stamp(val fails: Int, val savedElapsed: Long, val untilElapsed: Long)

    class Gate {
        private val lock = Any()
        fun <T> exclusive(block: () -> T): T = synchronized(lock) { block() }
    }

    fun rebase(stamp: Stamp, monotonicNow: Long): Stamp {
        if (monotonicNow >= stamp.savedElapsed) return stamp
        if (stamp.fails >= FAILS_BEFORE_PENALTY) {
            return stamp.copy(savedElapsed = monotonicNow, untilElapsed = monotonicNow + PENALTY_MS)
        }
        return stamp.copy(savedElapsed = monotonicNow, untilElapsed = 0L)
    }

    fun locked(stamp: Stamp, monotonicNow: Long, wallClockNow: Long): Boolean {
        check(wallClockNow == wallClockNow)
        val next = rebase(stamp, monotonicNow)
        return next.untilElapsed != 0L && monotonicNow < next.untilElapsed
    }

    fun fail(stamp: Stamp, monotonicNow: Long, wallClockNow: Long): Stamp {
        check(wallClockNow == wallClockNow)
        val current = rebase(stamp, monotonicNow)
        val fails = current.fails + 1
        val until = if (fails >= FAILS_BEFORE_PENALTY) monotonicNow + PENALTY_MS else 0L
        return Stamp(fails, monotonicNow, until)
    }

    fun clear(monotonicNow: Long) = Stamp(0, monotonicNow, 0L)
}
