package net.blazarforce.crypto

import org.web3j.crypto.Bip32ECKeyPair
import org.web3j.crypto.Credentials
import org.web3j.crypto.Keys
import org.web3j.crypto.MnemonicUtils
import java.security.SecureRandom

object WalletCrypto {
    fun randomMnemonic(): String {
        val entropy = ByteArray(16)
        SecureRandom().nextBytes(entropy)
        return mnemonicFromEntropy(entropy)
    }

    fun mnemonicFromEntropy(entropy: ByteArray): String {
        require(entropy.size == 16 || entropy.size == 32) { "entropy" }
        return MnemonicUtils.generateMnemonic(entropy)
    }

    fun isValid(mnemonic: String): Boolean = try {
        MnemonicUtils.validateMnemonic(mnemonic.trim().replace(Regex("\\s+"), " "))
    } catch (_: Exception) {
        false
    }

    fun words(mnemonic: String): List<String> = mnemonic.trim().split(Regex("\\s+"))

    fun deriveAddress(mnemonic: String, index: Int): String {
        require(index >= 0)
        return Keys.toChecksumAddress(credentials(mnemonic, index).address)
    }

    fun privateKey(mnemonic: String, index: Int): ByteArray {
        val key = credentials(mnemonic, index).ecKeyPair.privateKey
        val raw = key.toByteArray()
        val out = ByteArray(32)
        val src = if (raw.size > 32 && raw[0] == 0.toByte()) raw.copyOfRange(raw.size - 32, raw.size) else raw
        System.arraycopy(src, 0, out, 32 - src.size, src.size)
        return out
    }

    private fun credentials(mnemonic: String, index: Int): Credentials {
        val phrase = mnemonic.trim().replace(Regex("\\s+"), " ")
        require(isValid(phrase)) { "mnemonic" }
        val seed = MnemonicUtils.generateSeed(phrase, "")
        val master = Bip32ECKeyPair.generateKeyPair(seed)
        val path = intArrayOf(
            44 or Bip32ECKeyPair.HARDENED_BIT,
            60 or Bip32ECKeyPair.HARDENED_BIT,
            0 or Bip32ECKeyPair.HARDENED_BIT,
            0,
            index,
        )
        return Credentials.create(Bip32ECKeyPair.deriveKeyPair(master, path))
    }
}
