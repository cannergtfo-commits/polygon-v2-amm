package net.blazarforce.crypto

import java.math.BigInteger
import javax.crypto.AEADBadTagException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class WalletCryptoTest {
    @Test
    fun abandonMnemonicMatchesTheKnownAddress() {
        val phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
        assertEquals("0x9858EfFD232B4033E47d90003D41EC34EcaEda94", WalletCrypto.deriveAddress(phrase, 0))
    }

    @Test
    fun secondAccountIsDifferent() {
        val phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
        val first = WalletCrypto.deriveAddress(phrase, 0)
        val second = WalletCrypto.deriveAddress(phrase, 1)
        assertTrue(first != second)
        assertTrue(second.startsWith("0x") && second.length == 42)
    }

    @Test
    fun randomMnemonicImportsBackToTheSameAddress() {
        val phrase = WalletCrypto.randomMnemonic()
        assertEquals(12, WalletCrypto.words(phrase).size)
        assertTrue(WalletCrypto.isValid(phrase))
        val address = WalletCrypto.deriveAddress(phrase, 0)
        assertEquals(address, WalletCrypto.deriveAddress(phrase, 0))
    }

    @Test
    fun rejectsABrokenMnemonic() {
        assertTrue(!WalletCrypto.isValid("abandon abandon abandon"))
    }

    @Test
    fun pinRoundTripAndWrongPinFails() {
        val secret = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about".encodeToByteArray()
        val box = PinCipher.encrypt(secret, "135790".toCharArray())
        val opened = PinCipher.decrypt(PinCipher.Box.parse(box.serialize()), "135790".toCharArray())
        assertEquals(secret.decodeToString(), opened.decodeToString())
        assertFailsWith<AEADBadTagException> {
            PinCipher.decrypt(box, "000000".toCharArray())
        }
    }

    @Test
    fun unlimitedApprovalAndZeroAddressAreFlagged() {
        val approve = "0x095ea7b3" + "11".repeat(32) + "ff".repeat(32)
        val summary = TxPreview.preview("0x0000000000000000000000000000000000000000", approve, BigInteger.ZERO, emptySet())
        assertTrue(summary.warnings.any { it.contains("block list") })
        assertTrue(summary.warnings.any { it.contains("unlimited") })
    }
}
