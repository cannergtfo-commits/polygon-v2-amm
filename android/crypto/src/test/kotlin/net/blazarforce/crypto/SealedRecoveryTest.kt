package net.blazarforce.crypto

import java.io.FileNotFoundException
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SealedRecoveryTest {
    @Test
    fun backupIsRestoredWhenTheBaseIsMissing() {
        val dir = Files.createTempDirectory("sealed").toFile()
        val base = dir.resolve("seed.box")
        val backup = dir.resolve("seed.box.bak")
        val good = "BZV1-good".toByteArray()
        backup.writeBytes(good)
        val read = SealedRecovery.openRead(base, backup)
        assertContentEquals(good, read)
        assertContentEquals(good, base.readBytes())
        assertFalse(backup.exists())
    }

    @Test
    fun partialBaseIsReplacedByTheBackup() {
        val dir = Files.createTempDirectory("sealed-partial").toFile()
        val base = dir.resolve("seed.box")
        val backup = dir.resolve("seed.box.bak")
        val good = "committed-ciphertext".toByteArray()
        base.writeBytes("partial".toByteArray())
        backup.writeBytes(good)
        val read = SealedRecovery.openRead(base, backup)
        assertContentEquals(good, read)
        assertContentEquals(good, base.readBytes())
        assertFalse(backup.exists())
    }

    @Test
    fun committedBaseIsLeftUntouched() {
        val dir = Files.createTempDirectory("sealed-base").toFile()
        val base = dir.resolve("seed.box")
        val backup = dir.resolve("seed.box.bak")
        val good = "only-base".toByteArray()
        base.writeBytes(good)
        val read = SealedRecovery.openRead(base, backup)
        assertContentEquals(good, read)
        assertTrue(base.exists())
        assertFalse(backup.exists())
    }

    @Test
    fun nothingToReadFailsWithoutCreatingAFile() {
        val dir = Files.createTempDirectory("sealed-empty").toFile()
        val base = dir.resolve("seed.box")
        val backup = dir.resolve("seed.box.bak")
        assertFailsWith<FileNotFoundException> { SealedRecovery.openRead(base, backup) }
        assertFalse(base.exists())
    }
}
