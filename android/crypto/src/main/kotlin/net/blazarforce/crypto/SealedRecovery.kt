package net.blazarforce.crypto

import java.io.File
import java.io.FileNotFoundException

/**
 * Restore rule used by Android 9 AtomicFile.openRead: if a backup remains,
 * the base is a partial write and the backup is the last committed file.
 * The app calls AtomicFile.readFully, which performs this restore. This
 * function is the same rule for a JVM regression test. It does not lock.
 */
object SealedRecovery {
    fun openRead(base: File, backup: File): ByteArray {
        if (backup.exists()) {
            if (base.exists() && !base.delete()) error("could not drop the partial vault file")
            if (!backup.renameTo(base)) error("could not restore the vault backup")
        }
        if (!base.exists()) throw FileNotFoundException(base.path)
        return base.readBytes()
    }
}
