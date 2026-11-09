package net.blazarforce.crypto

import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * PIN-derived AES-256-GCM. The Android Keystore wraps the resulting box a second time.
 * A wrong PIN fails the GCM tag. The PIN is wiped before the function returns.
 */
object PinCipher {
    const val ITERATIONS = 210_000
    private const val KEY_BITS = 256
    private const val GCM_TAG_BITS = 128

    data class Box(val salt: ByteArray, val iv: ByteArray, val ciphertext: ByteArray) {
        fun serialize(): ByteArray {
            fun put(src: ByteArray): ByteArray {
                val len = byteArrayOf((src.size shr 8).toByte(), src.size.toByte())
                return len + src
            }
            return put(salt) + put(iv) + put(ciphertext)
        }

        companion object {
            fun parse(bytes: ByteArray): Box {
                var cursor = 0
                fun take(): ByteArray {
                    require(cursor + 2 <= bytes.size)
                    val len = ((bytes[cursor].toInt() and 0xff) shl 8) or (bytes[cursor + 1].toInt() and 0xff)
                    cursor += 2
                    require(cursor + len <= bytes.size)
                    val out = bytes.copyOfRange(cursor, cursor + len)
                    cursor += len
                    return out
                }
                return Box(take(), take(), take())
            }
        }
    }

    fun encrypt(plain: ByteArray, pin: CharArray): Box {
        val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val key = derive(pin, salt)
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(GCM_TAG_BITS, iv))
            Box(salt, iv, cipher.doFinal(plain))
        } finally {
            key.fill(0)
            pin.fill('\u0000')
        }
    }

    fun decrypt(box: Box, pin: CharArray): ByteArray {
        val key = derive(pin, box.salt)
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(GCM_TAG_BITS, box.iv))
            cipher.doFinal(box.ciphertext)
        } finally {
            key.fill(0)
            pin.fill('\u0000')
        }
    }

    private fun derive(pin: CharArray, salt: ByteArray): ByteArray {
        val spec = PBEKeySpec(pin, salt, ITERATIONS, KEY_BITS)
        return try {
            SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
        } finally {
            spec.clearPassword()
        }
    }
}
