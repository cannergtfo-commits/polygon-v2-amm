package net.blazarforce.wallet

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import net.blazarforce.crypto.PinCipher
import net.blazarforce.crypto.VaultAdmission
import net.blazarforce.crypto.VaultPolicy
import android.util.AtomicFile
import java.io.File
import java.io.FileNotFoundException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Outer envelope for the PIN box.
 *
 * An auth-bound Android Keystore key is requested first (StrongBox, then TEE).
 * That request is not proof the device actually used StrongBox or a TEE.
 * When the key is auth-bound, encrypt and decrypt must run through a Cipher
 * that BiometricPrompt has authorized with a CryptoObject. A prompt that does
 * not receive that Cipher does not unwrap the file.
 *
 * Every load classifies an existing alias from KeyInfo. A seed-file header is
 * not authority. A refused alias stays on disk, and every cipher, read, and
 * write fails before touching that key. Reads go through AtomicFile so a
 * leftover .bak from a killed replacement is restored before classification.
 */
class KeystoreVault(context: Context) {
    private val app = context.applicationContext
    private val sealed = File(app.filesDir, "seed.box")
    private val atomic = AtomicFile(sealed)
    private val lock = Any()
    val refusal: String?
    private val admission: VaultAdmission
    private val level: Level?

    init {
        var loaded: Level? = null
        var reason: String? = null
        var next = VaultAdmission.REFUSED
        try {
            loaded = loadOrCreate()
            next = VaultAdmission.READY
        } catch (err: Exception) {
            reason = err.message ?: "The existing vault key was refused and left in place."
            next = VaultAdmission.REFUSED
            loaded = null
        }
        level = loaded
        admission = next
        refusal = reason
    }

    enum class Level(val code: Int) {
        AUTH_BOUND_STRONGBOX_REQUESTED(1),
        AUTH_BOUND_TEE_REQUESTED(2),
        KEYSTORE_WITHOUT_USER_AUTH(3),
        ;

        val userAuthBound: Boolean
            get() = this != KEYSTORE_WITHOUT_USER_AUTH

        companion object {
            fun from(code: Int) = entries.first { it.code == code }
        }
    }

    fun isReady(): Boolean = admission == VaultAdmission.READY

    fun hasWallet(): Boolean = readSealed() != null

    fun level(): Level = level ?: error(refusal ?: "The existing vault key was refused and left in place.")

    fun legacyFilePresent(): Boolean {
        val raw = readSealed() ?: return false
        return !isBzv1(raw)
    }

    fun requiresUserAuth(): Boolean = isReady() && level().userAuthBound && !legacyFilePresent()

    fun encryptCipher(): Cipher {
        requireReady()
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        return cipher
    }

    fun decryptCipher(): Cipher {
        requireReady()
        val raw = readSealed() ?: error("No vault file.")
        require(isBzv1(raw)) { "This vault file is not the current format. It was left in place." }
        val iv = raw.copyOfRange(5, 17)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        return cipher
    }

    fun finishEncrypt(cipher: Cipher, box: PinCipher.Box) {
        requireReady()
        val body = cipher.doFinal(box.serialize())
        val iv = cipher.iv
        val payload = byteArrayOf(0x42, 0x5a, 0x56, 0x31, level().code.toByte()) + iv + body
        synchronized(lock) {
            val existing = readSealed()
            if (existing != null && !isBzv1(existing)) error("The existing vault file is not the current format. It was left in place.")
            val out = atomic.startWrite()
            try {
                out.write(payload)
                out.fd.sync()
                atomic.finishWrite(out)
            } catch (err: Exception) {
                atomic.failWrite(out)
                throw err
            }
        }
    }

    fun finishDecrypt(cipher: Cipher): PinCipher.Box {
        requireReady()
        val raw = readSealed() ?: error("No vault file.")
        val body = raw.copyOfRange(17, raw.size)
        return PinCipher.Box.parse(cipher.doFinal(body))
    }

    fun writeWithoutUserAuth(box: PinCipher.Box) {
        requireReady()
        error("A new wallet requires a user-auth keystore key. PIN-only storage is refused.")
    }

    fun readWithoutUserAuth(): PinCipher.Box {
        requireReady()
        if (legacyFilePresent()) error("This wallet file is not auth-bound. It was left in place and is not opened.")
        error("This keystore key requires user authentication.")
    }

    private fun requireReady() {
        VaultPolicy.requireCrypto(admission)
    }

    private fun readSealed(): ByteArray? = synchronized(lock) {
        try {
            val bytes = atomic.readFully()
            if (bytes.isEmpty()) null else bytes
        } catch (_: FileNotFoundException) {
            null
        }
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        error("missing vault key")
    }

    private fun loadOrCreate(): Level {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        if (store.containsAlias(ALIAS)) {
            // Classification only. This branch never deletes the alias or the seed file.
            val existing = store.getKey(ALIAS, null) as? SecretKey
            val info = existing?.let { secret ->
                javax.crypto.SecretKeyFactory.getInstance(secret.algorithm, ANDROID_KEYSTORE)
                    .getKeySpec(secret, android.security.keystore.KeyInfo::class.java) as android.security.keystore.KeyInfo
            }
            if (VaultPolicy.classifyExisting(info != null, info?.isUserAuthenticationRequired == true) != VaultAdmission.READY || info == null) {
                error("The existing vault key does not require user authentication. It was not deleted, and a new wallet is refused.")
            }
            val strongBox = Build.VERSION.SDK_INT >= 31 &&
                info.securityLevel == android.security.keystore.KeyProperties.SECURITY_LEVEL_STRONGBOX
            return if (strongBox) Level.AUTH_BOUND_STRONGBOX_REQUESTED else Level.AUTH_BOUND_TEE_REQUESTED
        }
        return createKey()
    }

    private fun createKey(): Level {
        val attempts = listOf(
            Triple(Level.AUTH_BOUND_STRONGBOX_REQUESTED, true, true),
            Triple(Level.AUTH_BOUND_TEE_REQUESTED, false, true),
        )
        for ((next, strongBox, userAuth) in attempts) {
            try {
                generate(next, strongBox, userAuth)
                val created = key()
                val info = javax.crypto.SecretKeyFactory.getInstance(created.algorithm, ANDROID_KEYSTORE)
                val spec = info.getKeySpec(created, android.security.keystore.KeyInfo::class.java) as android.security.keystore.KeyInfo
                if (!spec.isUserAuthenticationRequired) error("keystore key is not user-auth bound")
                return next
            } catch (_: Exception) {
                KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }.deleteEntry(ALIAS)
            }
        }
        error("This device cannot create a user-auth keystore key. A new wallet is refused.")
    }

    private fun generate(level: Level, strongBox: Boolean, userAuth: Boolean) {
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        val builder = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
        if (strongBox && Build.VERSION.SDK_INT >= 28) builder.setIsStrongBoxBacked(true)
        if (userAuth) {
            builder.setUserAuthenticationRequired(true)
            if (Build.VERSION.SDK_INT >= 30) {
                builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
            } else {
                builder.setUserAuthenticationValidityDurationSeconds(-1)
            }
        }
        generator.init(builder.build())
        generator.generateKey()
        check(level.userAuthBound == userAuth)
    }

    private fun isBzv1(raw: ByteArray) = raw.size >= 5 && raw[0] == 0x42.toByte() && raw[1] == 0x5a.toByte() && raw[2] == 0x56.toByte() && raw[3] == 0x31.toByte()

    companion object {
        private const val ALIAS = "blazar.vault.v2"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
