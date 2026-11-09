package net.blazarforce.crypto

import java.math.BigInteger

data class TxSummary(
    val kind: String,
    val lines: List<Pair<String, String>>,
    val warnings: List<String>,
)

object TxPreview {
    private val zero = "0x" + "0".repeat(40)
    val scam = setOf(
        zero,
        "0x000000000000000000000000000000000000dead",
    )

    fun preview(to: String, data: String, valueWei: BigInteger, allowlist: Set<String>): TxSummary {
        val target = to.lowercase()
        val payload = data.removePrefix("0x").lowercase()
        val warnings = mutableListOf<String>()
        if (target == zero || scam.contains(target)) warnings += "This address is on the local block list."
        if (!target.startsWith("0x") || target.length != 42) warnings += "That is not an address."
        val known = allowlist.map { it.lowercase() }.toSet()
        val selector = payload.take(8)
        val kind = when (selector) {
            "" -> "Native transfer"
            "a9059cbb" -> "Token transfer"
            "095ea7b3" -> "Approval"
            else -> "Contract call"
        }
        if (selector == "095ea7b3" && payload.length >= 8 + 64 + 64) {
            val amount = payload.substring(8 + 64, 8 + 128)
            if (amount.all { it == 'f' }) warnings += "This approval is unlimited. Prefer an exact amount."
        }
        if (kind == "Contract call" && target !in known && selector.isNotEmpty()) {
            warnings += "The contract is not in the Blazar allowlist. Read it before you sign."
        }
        if (valueWei > BigInteger.ZERO && kind != "Native transfer") {
            warnings += "This call also sends POL."
        }
        val lines = mutableListOf("To" to to, "Kind" to kind, "Value wei" to valueWei.toString())
        if (selector.isNotEmpty()) lines += "Selector" to "0x$selector"
        return TxSummary(kind, lines, warnings)
    }
}
