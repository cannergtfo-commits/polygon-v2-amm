package net.blazarforce.crypto

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class VaultPolicyTest {
    @Test
    fun nonAuthAliasIsRefusedEvenWhenAFileExists() {
        assertEquals(VaultAdmission.REFUSED, VaultPolicy.classifyExisting(keyPresent = true, userAuthenticationRequired = false))
    }

    @Test
    fun missingKeyIsRefused() {
        assertEquals(VaultAdmission.REFUSED, VaultPolicy.classifyExisting(keyPresent = false, userAuthenticationRequired = true))
    }

    @Test
    fun authBoundAliasIsReady() {
        assertEquals(VaultAdmission.READY, VaultPolicy.classifyExisting(keyPresent = true, userAuthenticationRequired = true))
    }

    @Test
    fun refusedAdmissionCannotStartCrypto() {
        val failure = assertFailsWith<IllegalStateException> {
            VaultPolicy.requireCrypto(VaultAdmission.REFUSED)
        }
        assertEquals("The existing vault key was refused and left in place.", failure.message)
    }

    @Test
    fun readyAdmissionPassesTheGate() {
        VaultPolicy.requireCrypto(VaultAdmission.READY)
    }
}
