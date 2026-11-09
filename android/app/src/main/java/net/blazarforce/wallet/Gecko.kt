package net.blazarforce.wallet

import net.blazarforce.crypto.PoolScore
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.ArrayDeque

data class GeckoPool(
    val address: String,
    val name: String,
    val dex: String,
    val liquidityUsd: Double,
    val change24h: Double?,
    val createdAt: String?,
    val base: Boolean,
    val score: Double,
)

data class GeckoToken(
    val address: String,
    val name: String,
    val symbol: String,
    val priceUsd: Double?,
    val change24h: Double?,
    val volume24hUsd: Double?,
    val liquidityUsd: Double?,
    val fdvUsd: Double?,
    val marketCapUsd: Double?,
    val holders: Int?,
    val pools: List<GeckoPool>,
)

data class TrendToken(
    val address: String,
    val symbol: String,
    val priceUsd: Double?,
    val change24h: Double?,
    val liquidityUsd: Double?,
    val createdAt: String?,
    val pool: String,
    val image: String? = null,
)

data class Candle(val time: Long, val open: Double, val high: Double, val low: Double, val close: Double)

object Gecko {
    private val http = OkHttpClient()
    private val cache = HashMap<String, Pair<Long, String>>()
    private val hits = ArrayDeque<Long>()
    private const val freshMs = 45_000L

    fun token(address: String): GeckoToken {
        val token = address.lowercase()
        val tokenJson = get("/networks/polygon_pos/tokens/$token")
        val poolsJson = get("/networks/polygon_pos/tokens/$token/pools?page=1")
        val infoJson = try { get("/networks/polygon_pos/tokens/$token/info") } catch (_: Exception) { null }
        val attrs = JSONObject(tokenJson).getJSONObject("data").getJSONObject("attributes")
        val rows = JSONObject(poolsJson).getJSONArray("data")
        val now = System.currentTimeMillis()
        val facts = (0 until rows.length()).map { index ->
            val item = rows.getJSONObject(index)
            val pool = item.getJSONObject("attributes")
            val created = pool.optString("pool_created_at", "")
            val age = if (created.isBlank()) 0.0 else ((now - java.time.Instant.parse(created).toEpochMilli()) / 1000.0).coerceAtLeast(0.0)
            Triple(item, pool.optString("address"), age)
        }
        val ranked = PoolScore.rank(facts.map { PoolScore.Facts(it.second, it.first.getJSONObject("attributes").num("reserve_in_usd") ?: 0.0, it.third) })
        val byAddress = facts.associateBy { it.second.lowercase() }
        val pools = ranked.map { scored ->
            val item = byAddress.getValue(scored.address.lowercase()).first
            val pool = item.getJSONObject("attributes")
            val baseId = item.getJSONObject("relationships").getJSONObject("base_token").getJSONObject("data").optString("id")
            GeckoPool(
                address = scored.address,
                name = pool.optString("name"),
                dex = item.getJSONObject("relationships").getJSONObject("dex").getJSONObject("data").optString("id"),
                liquidityUsd = scored.liquidityUsd,
                change24h = pool.optJSONObject("price_change_percentage")?.num("h24"),
                createdAt = pool.optString("pool_created_at").ifBlank { null },
                base = baseId.lowercase().endsWith(token),
                score = scored.score,
            )
        }
        val holders = infoJson?.let {
            JSONObject(it).getJSONObject("data").getJSONObject("attributes").optJSONObject("holders")?.optInt("count")
        }
        val best = pools.firstOrNull()
        return GeckoToken(
            address = token,
            name = attrs.optString("name"),
            symbol = attrs.optString("symbol"),
            priceUsd = attrs.num("price_usd"),
            change24h = best?.change24h,
            volume24hUsd = attrs.optJSONObject("volume_usd")?.num("h24"),
            liquidityUsd = attrs.num("total_reserve_in_usd"),
            fdvUsd = attrs.num("fdv_usd"),
            marketCapUsd = attrs.num("market_cap_usd"),
            holders = holders,
            pools = pools,
        )
    }

    fun trending(): List<TrendToken> {
        val rows = JSONObject(get("/networks/polygon_pos/trending_pools?page=1")).getJSONArray("data")
        val seen = HashSet<String>()
        val out = ArrayList<TrendToken>()
        for (index in 0 until rows.length()) {
            val item = rows.getJSONObject(index)
            val attrs = item.getJSONObject("attributes")
            val baseId = item.getJSONObject("relationships").getJSONObject("base_token").getJSONObject("data").optString("id")
            val address = baseId.removePrefix("polygon_pos_")
            if (address.isBlank() || !seen.add(address.lowercase())) continue
            val name = attrs.optString("name")
            out += TrendToken(
                address = address,
                symbol = name.substringBefore("/").trim(),
                priceUsd = attrs.num("base_token_price_usd"),
                change24h = attrs.optJSONObject("price_change_percentage")?.num("h24"),
                liquidityUsd = attrs.num("reserve_in_usd"),
                createdAt = attrs.optString("pool_created_at").ifBlank { null },
                pool = attrs.optString("address"),
            )
            if (out.size == 8) break
        }
        return attachImages(out)
    }

    private fun attachImages(tokens: List<TrendToken>): List<TrendToken> {
        if (tokens.isEmpty()) return tokens
        return try {
            val rows = JSONObject(get("/networks/polygon_pos/tokens/multi/${tokens.joinToString(",") { it.address }}")).getJSONArray("data")
            val images = HashMap<String, String>()
            for (index in 0 until rows.length()) {
                val attrs = rows.getJSONObject(index).getJSONObject("attributes")
                val image = safeImage(attrs.optString("image_url")) ?: continue
                val address = attrs.optString("address")
                if (address.isNotBlank()) images[address.lowercase()] = image
            }
            tokens.map { it.copy(image = images[it.address.lowercase()]) }
        } catch (_: Exception) {
            tokens
        }
    }

    fun safeImage(url: String?): String? {
        if (url.isNullOrBlank() || url.length > 500 || !url.startsWith("https://") || url.contains("@")) return null
        return url
    }

    fun candles(pool: String, frame: String, base: Boolean): List<Candle> {
        val (path, aggregate) = when (frame) {
            "15m" -> "minute" to 15
            "4h" -> "hour" to 4
            "1d" -> "day" to 1
            else -> "hour" to 1
        }
        val side = if (base) "base" else "quote"
        val list = JSONObject(get("/networks/polygon_pos/pools/$pool/ohlcv/$path?aggregate=$aggregate&limit=120&currency=usd&token=$side"))
            .getJSONObject("data").getJSONObject("attributes").getJSONArray("ohlcv_list")
        val byTime = linkedMapOf<Long, Candle>()
        for (index in 0 until list.length()) {
            val row = list.getJSONArray(index)
            val time = row.getLong(0)
            byTime[time] = Candle(time, row.getDouble(1), row.getDouble(2), row.getDouble(3), row.getDouble(4))
        }
        return byTime.values.sortedBy { it.time }
    }

    private fun JSONObject.num(name: String): Double? {
        if (!has(name) || isNull(name)) return null
        val parsed = when (val raw = opt(name)) {
            is Number -> raw.toDouble()
            is String -> raw.toDoubleOrNull()
            else -> null
        }
        return parsed?.takeIf { it.isFinite() }
    }

    private fun get(path: String): String {
        val hit = cache[path]
        val now = System.currentTimeMillis()
        if (hit != null && now - hit.first < freshMs) return hit.second
        synchronized(hits) {
            while (hits.isNotEmpty() && now - hits.first() > 60_000) hits.removeFirst()
            if (hits.size >= 28) {
                if (hit != null) return hit.second
                throw IllegalStateException("GeckoTerminal rate limit")
            }
            hits.addLast(now)
        }
        val request = Request.Builder()
            .url("https://api.geckoterminal.com/api/v2$path")
            .header("accept", "application/json")
            .header("user-agent", "BlazarWallet/0.1")
            .build()
        http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (response.code == 429) {
                if (hit != null) return hit.second
                throw IllegalStateException("GeckoTerminal is rate limiting")
            }
            if (!response.isSuccessful) throw IllegalStateException("GeckoTerminal ${response.code}")
            cache[path] = now to text
            return text
        }
    }
}
