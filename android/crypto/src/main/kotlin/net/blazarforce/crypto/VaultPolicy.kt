package net.blazarforce.crypto

/**
 * Admission for an alias that already exists. KeyInfo is the only authority.
 * A refused alias is not deleted and is not usable for a new wallet.
 */
enum class VaultAdmission {
    READY,
    REFUSED,
}

object VaultPolicy {
    fun classifyExisting(keyPresent: Boolean, userAuthenticationRequired: Boolean): VaultAdmission {
        if (!keyPresent || !userAuthenticationRequired) return VaultAdmission.REFUSED
        return VaultAdmission.READY
    }

    fun requireCrypto(admission: VaultAdmission) {
        if (admission != VaultAdmission.READY) {
            error("The existing vault key was refused and left in place.")
        }
    }
}
