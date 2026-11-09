package net.blazarforce.wallet

import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.SystemClock
import android.view.WindowManager
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.foundation.clickable
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import kotlinx.coroutines.delay
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.Image
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import android.view.View
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import net.blazarforce.crypto.PinCipher
import net.blazarforce.crypto.TxPreview
import net.blazarforce.crypto.PinThrottle
import net.blazarforce.crypto.SessionDeadline
import net.blazarforce.crypto.WalletCrypto
import android.graphics.BitmapFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.math.BigInteger

private val Cyan = Color(0xFF3EE0FF)
private val Ink = Color(0xFF030712)
private val Muted = Color(0xFF8AA3B8)
private val http = OkHttpClient()
private const val RPC = "https://polygon-bor-rpc.publicnode.com"
private val allowlist = setOf(
    "0x8e9663F4b15F3B291B1354e20d1B019d8864830F",
    "0x5C0cCC397A5B222B06815C3c23959dd83F42aA86",
    "0x6F47aa396215ab22647dDB3E86b4663DFe11dB14",
)

private sealed interface Screen {
    data object Welcome : Screen
    data object Blocked : Screen
    data class Reveal(val words: List<String>) : Screen
    data class Check(val words: List<String>, val picks: List<Int>, val answers: List<String>) : Screen
    data class Pin(val mnemonic: String) : Screen
    data object Unlock : Screen
    data object Home : Screen
    data object Send : Screen
    data object Receive : Screen
    data object Swap : Screen
    data object Stake : Screen
    data object Rewards : Screen
    data object Approvals : Screen
    data object History : Screen
    data class Review(val summary: net.blazarforce.crypto.TxSummary) : Screen
    data class Token(val address: String) : Screen
}

@Composable
fun BlazarWalletApp(activity: FragmentActivity) {
    val vault = remember { KeystoreVault(activity) }
    var screen by remember {
        mutableStateOf<Screen>(when {
            !vault.isReady() -> Screen.Blocked
            vault.hasWallet() -> Screen.Unlock
            else -> Screen.Welcome
        })
    }
    var mnemonic by remember { mutableStateOf<String?>(null) }
    var account by remember { mutableIntStateOf(0) }
    var balance by remember { mutableStateOf("—") }
    var note by remember { mutableStateOf("") }
    var lastActive by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    val history = remember { mutableListOf<String>() }
    var trends by remember { mutableStateOf<List<TrendToken>>(emptyList()) }
    var trendError by remember { mutableStateOf<String?>(null) }
    var detail by remember { mutableStateOf<GeckoToken?>(null) }
    var detailFrame by remember { mutableStateOf("1h") }
    var detailCandles by remember { mutableStateOf<List<Candle>>(emptyList()) }
    var detailError by remember { mutableStateOf<String?>(null) }
    val pinPrefs = remember { activity.getSharedPreferences("blazar_lock", android.content.Context.MODE_PRIVATE) }
    val pinGate = remember { PinThrottle.Gate() }
    var pinStamp by remember {
        mutableStateOf(PinThrottle.Stamp(pinPrefs.getInt("fails", 0), pinPrefs.getLong("monoSaved", 0L), pinPrefs.getLong("monoUntil", 0L)))
    }
    var outerBox by remember { mutableStateOf<net.blazarforce.crypto.PinCipher.Box?>(null) }
    var pendingSeal by remember { mutableStateOf<net.blazarforce.crypto.PinCipher.Box?>(null) }
    var session by remember { mutableIntStateOf(0) }
    var secretUntil by remember { mutableLongStateOf(0L) }
    var draftArmed by remember { mutableLongStateOf(0L) }
    var prompt by remember { mutableStateOf<BiometricPrompt?>(null) }
    var payLabel by remember { mutableStateOf("POL") }
    var payAddress by remember { mutableStateOf("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270") }
    var buyPick by remember { mutableStateOf<TrendToken?>(null) }
    var chartPool by remember { mutableStateOf<GeckoPool?>(null) }
    var candleMiss by remember { mutableStateOf(false) }

    fun promptInfo(): BiometricPrompt.PromptInfo {
        val builder = BiometricPrompt.PromptInfo.Builder().setTitle("Blazar keystore").setSubtitle(vault.level().name)
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            builder.setAllowedAuthenticators(
                BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL,
            )
        } else {
            builder.setDeviceCredentialAllowed(true)
        }
        return builder.build()
    }

    fun authorizeVault(encrypt: Boolean, onSealed: () -> Unit) {
        if (!vault.isReady()) {
            note = vault.refusal ?: "The existing vault key was refused and left in place."
            return
        }
        val generation = session
        secretUntil = SystemClock.elapsedRealtime() + SessionDeadline.WINDOW_MS
        try {
            val cipher = if (encrypt) vault.encryptCipher() else vault.decryptCipher()
            val next = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    val now = SystemClock.elapsedRealtime()
                    if (generation != session || SessionDeadline.expired(secretUntil, now)) {
                        note = "That prompt is stale. Authenticate again."
                        return
                    }
                    val unlocked = result.cryptoObject?.cipher
                    if (unlocked == null) {
                        note = "The prompt returned no cipher, so the vault was not unwrapped."
                        return
                    }
                    try {
                        if (encrypt) {
                            val box = pendingSeal ?: return
                            vault.finishEncrypt(unlocked, box)
                            pendingSeal = null
                            onSealed()
                        } else {
                            outerBox = vault.finishDecrypt(unlocked)
                            secretUntil = SystemClock.elapsedRealtime() + SessionDeadline.WINDOW_MS
                            note = "Keystore unwrap succeeded. Enter the PIN within 60 seconds. Hardware backing was not verified."
                        }
                    } catch (err: Exception) {
                        note = err.message ?: "Keystore operation failed."
                    }
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    note = errString.toString()
                }
            })
            prompt = next
            next.authenticate(promptInfo(), BiometricPrompt.CryptoObject(cipher))
        } catch (err: Exception) {
            note = err.message ?: "Could not start keystore authentication."
        }
    }

    fun receiveTrend(trend: TrendToken) {
        if (trend.address.equals(payAddress, true)) {
            payAddress = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"
            payLabel = "USDC"
        }
        buyPick = trend
        screen = Screen.Swap
    }

    fun lock() {
        prompt?.cancelAuthentication()
        prompt = null
        outerBox = null
        pendingSeal = null
        secretUntil = 0L
        mnemonic = null
        session += 1
        screen = when {
            !vault.isReady() -> Screen.Blocked
            vault.hasWallet() -> Screen.Unlock
            else -> Screen.Welcome
        }
    }

    fun revealMnemonic(phrase: String) {
        lastActive = SessionDeadline.arm(SystemClock.elapsedRealtime())
        secretUntil = 0L
        draftArmed = 0L
        mnemonic = phrase
    }

    fun draftOnScreen(): Boolean = mnemonic == null && (screen is Screen.Reveal || screen is Screen.Check || screen is Screen.Pin)

    fun armDraft(now: Long = SystemClock.elapsedRealtime()) {
        draftArmed = SessionDeadline.arm(now)
    }

    fun discardUnsavedDraft() {
        note = SessionDeadline.DRAFT_CLEARED
        draftArmed = 0L
        screen = when {
            !vault.isReady() -> Screen.Blocked
            vault.hasWallet() -> Screen.Unlock
            else -> Screen.Welcome
        }
    }

    fun secretDeadline(now: Long): Long? = SessionDeadline.deadline(
        mnemonicExposed = mnemonic != null,
        armedAt = if (mnemonic != null) lastActive else draftArmed,
        boxUntil = secretUntil,
        boxExposed = outerBox != null || pendingSeal != null,
        draftExposed = draftOnScreen(),
    )

    fun draftStillValid(): Boolean {
        if (!draftOnScreen()) return true
        val now = SystemClock.elapsedRealtime()
        if (!SessionDeadline.allowSecretAction(SessionDeadline.draftPhase(draftArmed, now))) {
            discardUnsavedDraft()
            return false
        }
        return true
    }

    fun touch() {
        val now = SystemClock.elapsedRealtime()
        val deadline = secretDeadline(now)
        if (SessionDeadline.expired(deadline, now)) {
            if (draftOnScreen()) discardUnsavedDraft() else lock()
            return
        }
        if (mnemonic != null) lastActive = SessionDeadline.arm(now)
        if (draftOnScreen()) armDraft(now)
    }

    DisposableEffect(Unit) {
        onDispose { mnemonic = null }
    }
    val hostView = LocalView.current
    DisposableEffect(screen) {
        val secret = screen is Screen.Reveal || screen is Screen.Check || screen is Screen.Pin || screen is Screen.Unlock
        if (secret) activity.window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val pinEntry = screen is Screen.Pin || screen is Screen.Unlock
        if (pinEntry) hostView.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        else hostView.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_AUTO
        onDispose { }
    }
    DisposableEffect(activity) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) lock()
        }
        activity.lifecycle.addObserver(observer)
        onDispose { activity.lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(lastActive, mnemonic, secretUntil, outerBox, pendingSeal, draftArmed, screen) {
        val now = SystemClock.elapsedRealtime()
        val drafting = draftOnScreen()
        val deadline = secretDeadline(now) ?: return@LaunchedEffect
        if (drafting) {
            val warnAt = draftArmed + SessionDeadline.WINDOW_MS - SessionDeadline.WARN_BEFORE_MS
            if (now < warnAt) delay(warnAt - now)
            if (draftOnScreen() && SessionDeadline.draftPhase(draftArmed, SystemClock.elapsedRealtime()) == SessionDeadline.Phase.WARN) {
                note = SessionDeadline.DRAFT_WARNING
            }
        }
        val remain = deadline - SystemClock.elapsedRealtime()
        if (remain > 0) delay(remain)
        if (!SessionDeadline.expired(secretDeadline(SystemClock.elapsedRealtime()), SystemClock.elapsedRealtime())) return@LaunchedEffect
        if (draftOnScreen()) discardUnsavedDraft() else lock()
    }
    LaunchedEffect(screen) {
        if (screen == Screen.Home) {
            trendError = null
            val loaded = withContext(Dispatchers.IO) { runCatching { Gecko.trending() } }
            loaded.onSuccess { trends = it }.onFailure { trendError = it.message }
        }
        val tokenScreen = screen as? Screen.Token
        if (tokenScreen != null) {
            detailError = null
            detail = null
            val loaded = withContext(Dispatchers.IO) { runCatching { Gecko.token(tokenScreen.address) } }
            loaded.onSuccess { detail = it }.onFailure { detailError = it.message }
        }
    }
    LaunchedEffect(detail?.address, detailFrame) {
        val pools = detail?.pools?.take(4) ?: return@LaunchedEffect
        candleMiss = false
        chartPool = null
        detailCandles = emptyList()
        for (pool in pools) {
            val rows = withContext(Dispatchers.IO) { runCatching { Gecko.candles(pool.address, detailFrame, pool.base) }.getOrDefault(emptyList()) }
            if (rows.isNotEmpty()) {
                chartPool = pool
                detailCandles = rows
                return@LaunchedEffect
            }
        }
        candleMiss = pools.isNotEmpty()
    }

    MaterialTheme(colorScheme = darkColorScheme(primary = Cyan, background = Ink, surface = Color(0xFF07101F), onPrimary = Ink)) {
        Column(
            Modifier
                .fillMaxSize()
                .background(Ink)
                .pointerInput(Unit) {
                    awaitPointerEventScope {
                        while (true) {
                            awaitPointerEvent(PointerEventPass.Initial)
                            touch()
                        }
                    }
                }
                .verticalScroll(rememberScrollState())
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("BLAZAR WALLET", color = Cyan, style = MaterialTheme.typography.labelLarge)
            if (vault.refusal != null) Text(vault.refusal!!, color = Color(0xFFFFB4A8))
            Text(screenTitle(screen), color = Color.White, style = MaterialTheme.typography.headlineMedium)
            if (note.isNotEmpty()) Text(note, color = Muted)
            when (val current = screen) {
                Screen.Blocked -> {
                    Text(vault.refusal ?: "The existing vault key was refused and left in place.", color = Color(0xFFFFB4A8))
                    Text("Create, import, and unlock stay off. The keystore alias and any seed file were not deleted.", color = Muted)
                }
                Screen.Welcome -> {
                    Text("A self-custody Polygon wallet. The seed is created on this phone and never leaves it.", color = Muted)
                    Primary("Create a new wallet") {
                        if (!vault.isReady()) {
                            note = vault.refusal ?: "The existing vault key was refused and left in place."
                            return@Primary
                        }
                        touch()
                        val words = WalletCrypto.words(WalletCrypto.randomMnemonic())
                        armDraft()
                        screen = Screen.Reveal(words)
                    }
                    Primary("Import a seed") {
                        if (!vault.isReady()) {
                            note = vault.refusal ?: "The existing vault key was refused and left in place."
                            return@Primary
                        }
                        armDraft()
                        screen = Screen.Pin("")
                    }
                }
                is Screen.Reveal -> {
                    Text(current.words.joinToString(" "), color = Color.White)
                    Text("Write these 12 words down. The next screen asks for three of them.", color = Muted)
                    Primary("I wrote them down") {
                        if (!draftStillValid()) return@Primary
                        armDraft()
                        val picks = listOf(1, 5, 9)
                        screen = Screen.Check(current.words, picks, List(3) { "" })
                    }
                }
                is Screen.Check -> {
                    current.picks.forEachIndexed { index, wordIndex ->
                        OutlinedTextField(
                            value = current.answers[index],
                            onValueChange = { value ->
                                val next = current.answers.toMutableList()
                                next[index] = value.trim()
                                screen = current.copy(answers = next)
                            },
                            label = { Text("Word ${wordIndex + 1}") },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    Primary("Verify backup") {
                        if (!draftStillValid()) return@Primary
                        val ok = current.picks.indices.all { current.answers[it].equals(current.words[current.picks[it]], true) }
                        if (!ok) note = "Those words do not match. Check the backup."
                        else {
                            note = ""
                            armDraft()
                            screen = Screen.Pin(current.words.joinToString(" "))
                        }
                    }
                }
                is Screen.Pin -> {
                    var pin by remember { mutableStateOf("") }
                    var phrase by remember(current.mnemonic) { mutableStateOf(current.mnemonic) }
                    if (current.mnemonic.isEmpty()) {
                        OutlinedTextField(phrase, { phrase = it }, label = { Text("12 or 24 word seed") }, modifier = Modifier.fillMaxWidth())
                    }
                    OutlinedTextField(
                        value = pin,
                        onValueChange = { pin = it.filter { ch -> ch.isDigit() }.take(6) },
                        label = { Text("6-digit PIN") },
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, autoCorrectEnabled = false),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Primary("Encrypt and store") {
                        if (!draftStillValid()) return@Primary
                        if (!vault.isReady()) {
                            note = vault.refusal ?: "The existing vault key was refused and left in place."
                            return@Primary
                        }
                        if (pin.length != 6) {
                            note = "Use a 6-digit PIN."
                            return@Primary
                        }
                        if (!WalletCrypto.isValid(phrase)) {
                            note = "That seed does not checksum."
                            return@Primary
                        }
                        val box = PinCipher.encrypt(phrase.encodeToByteArray(), pin.toCharArray())
                        fun openHome() {
                            revealMnemonic(phrase)
                            account = 0
                            note = if (vault.requiresUserAuth()) "Stored. Keystore user-auth was requested. StrongBox was not verified." else "Stored under the PIN. No user-auth keystore key was created, so biometrics are not a vault gate."
                            screen = Screen.Home
                            balance = loadBalance(WalletCrypto.deriveAddress(phrase, 0))
                        }
                        if (vault.requiresUserAuth()) {
                            pendingSeal = box
                            authorizeVault(true, ::openHome)
                        } else {
                            note = vault.refusal ?: "This alias is not auth-bound. The existing secret was left in place."
                        }
                    }
                }
                Screen.Unlock -> {
                    var pin by remember { mutableStateOf("") }
                    OutlinedTextField(
                        value = pin,
                        onValueChange = { pin = it.filter { ch -> ch.isDigit() }.take(6) },
                        label = { Text("PIN") },
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, autoCorrectEnabled = false),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Primary("Unlock") {
                        if (!vault.isReady()) {
                            note = vault.refusal ?: "The existing vault key was refused and left in place."
                            return@Primary
                        }
                        pinGate.exclusive {
                            val nowElapsed = SystemClock.elapsedRealtime()
                            val wall = System.currentTimeMillis()
                            val current = PinThrottle.rebase(pinStamp, nowElapsed)
                            pinStamp = current
                            pinPrefs.edit().putInt("fails", current.fails).putLong("monoSaved", current.savedElapsed).putLong("monoUntil", current.untilElapsed).commit()
                            if (PinThrottle.locked(current, nowElapsed, wall)) {
                                note = "Too many PIN attempts. Wait before trying again."
                                return@exclusive
                            }
                            if (vault.requiresUserAuth() && outerBox == null) {
                                note = "Unwrap the keystore with biometrics or the device credential before the PIN."
                                return@exclusive
                            }
                            try {
                                val box = outerBox ?: vault.readWithoutUserAuth()
                                val plain = PinCipher.decrypt(box, pin.toCharArray())
                                revealMnemonic(plain.toString(Charsets.UTF_8))
                                plain.fill(0)
                                outerBox = null
                                pinStamp = PinThrottle.clear(nowElapsed)
                                pinPrefs.edit().putInt("fails", 0).putLong("monoSaved", nowElapsed).putLong("monoUntil", 0L).commit()
                                note = ""
                                screen = Screen.Home
                                balance = loadBalance(WalletCrypto.deriveAddress(mnemonic!!, account))
                            } catch (_: Exception) {
                                val next = PinThrottle.fail(current, nowElapsed, wall)
                                pinStamp = next
                                pinPrefs.edit().putInt("fails", next.fails).putLong("monoSaved", next.savedElapsed).putLong("monoUntil", next.untilElapsed).commit()
                                note = if (PinThrottle.locked(next, nowElapsed, wall)) "Too many PIN attempts. Wait 30 seconds." else "Wrong PIN."
                            }
                        }
                    }
                    Text(
                        if (vault.requiresUserAuth()) "Keystore user authentication was requested (${vault.level().name}). This build does not verify StrongBox or a TEE."
                        else "No user-auth keystore key. The PIN is the only secret gate.",
                        color = Muted,
                    )
                    if (vault.isReady() && vault.requiresUserAuth()) {
                        Primary("Unwrap keystore") { authorizeVault(false) {} }
                    }
                }
                Screen.Home -> {
                    val phrase = mnemonic ?: return@Column
                    val address = WalletCrypto.deriveAddress(phrase, account)
                    Text(address, color = Cyan)
                    Text("POL balance $balance", color = Color.White)
                    Text("Account ${account + 1} · Polygon · auto-lock 60s", color = Muted)
                    Text("Trending on Polygon", color = Cyan)
                    if (trendError != null) Text(trendError!!, color = Color(0xFFFF5D7A))
                    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        trends.forEach { trend ->
                            Column(Modifier.width(132.dp).clickable { receiveTrend(trend) }) {
                                TrendFace(trend.image, trend.symbol)
                                Text(trend.symbol, color = Color.White, maxLines = 1)
                                Text(trend.change24h?.let { "%+.1f%%".format(it) } ?: "—", color = Muted, maxLines = 1)
                            }
                        }
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(
                            onClick = { screen = Screen.Receive },
                            modifier = Modifier.weight(1f),
                            colors = ButtonDefaults.buttonColors(containerColor = Cyan, contentColor = Ink),
                            shape = RoundedCornerShape(24.dp),
                        ) { Text("Receive") }
                        Button(
                            onClick = { screen = Screen.Send },
                            modifier = Modifier.weight(1f),
                            colors = ButtonDefaults.buttonColors(containerColor = Cyan, contentColor = Ink),
                            shape = RoundedCornerShape(24.dp),
                        ) { Text("Send") }
                    }
                    Primary("Swap") { screen = Screen.Swap }
                    Primary("Stake") { screen = Screen.Stake }
                    Primary("Rewards") { screen = Screen.Rewards }
                    Primary("Approvals") { screen = Screen.Approvals }
                    Primary("History") { screen = Screen.History }
                    Primary("Next account") {
                        account += 1
                        balance = loadBalance(WalletCrypto.deriveAddress(phrase, account))
                    }
                    Primary("Lock") { lock() }
                }
                Screen.Send -> {
                    var to by remember { mutableStateOf("") }
                    var amount by remember { mutableStateOf("0.01") }
                    OutlinedTextField(to, { to = it.trim() }, label = { Text("To") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(amount, { amount = it }, label = { Text("POL") }, modifier = Modifier.fillMaxWidth())
                    Primary("Review") {
                        val wei = try { polToWei(amount) } catch (_: Exception) { BigInteger.ZERO }
                        val summary = TxPreview.preview(to, "0x", wei, allowlist)
                        screen = Screen.Review(summary)
                    }
                    Primary("Back") { screen = Screen.Home }
                }
                Screen.Receive -> {
                    val phrase = mnemonic
                    if (phrase != null) {
                        val address = WalletCrypto.deriveAddress(phrase, account)
                        Text(address, color = Color.White)
                        Image(bitmap = qr(address).asImageBitmap(), contentDescription = "Receive QR", modifier = Modifier.height(220.dp))
                    }
                    Primary("Back") { screen = Screen.Home }
                }
                Screen.Swap -> {
                    var lookup by remember { mutableStateOf("0x462D8d82C2B2D2DDabf7f8a93928De09d47A5807") }
                    Text("Pay $payLabel", color = Cyan)
                    Text(payAddress, color = Color.White)
                    Text("Receive ${buyPick?.symbol ?: "—"}", color = Cyan)
                    Text(buyPick?.address ?: "Choose a trending token. Nothing is approved or broadcast.", color = Color.White)
                    Text("An external route pays 0.05% once. Later hops do not pay it again. BlazarSwap-only routes pay the pool fee alone. The router is not deployed, so this build will not broadcast a swap.", color = Muted)
                    OutlinedTextField(lookup, { lookup = it.trim() }, label = { Text("Token to chart") }, modifier = Modifier.fillMaxWidth())
                    Primary("Token info") { screen = Screen.Token(lookup) }
                    Primary("Preview a BZB approval") {
                        val summary = TxPreview.preview(allowlist.first(), "0x095ea7b3" + "ab".repeat(32) + "01".repeat(32), BigInteger.ZERO, allowlist)
                        screen = Screen.Review(summary)
                    }
                    Primary("Back") { screen = Screen.Home }
                }
                Screen.Stake -> {
                    Text("Stake BZB, earn BZB. No lock and no fee. The staking contract is not deployed on this build.", color = Muted)
                    Primary("Back") { screen = Screen.Home }
                }
                Screen.Rewards -> {
                    Text("Top 50 are listed. Top 25 are paid from a 1000 BZB daily cap. The poster is separate from the owner. Claiming waits until that contract is deployed.", color = Muted)
                    Primary("Back") { screen = Screen.Home }
                }
                Screen.Approvals -> {
                    Text("Revoke sets an allowance back to zero. Review the transaction before it is signed.", color = Muted)
                    Primary("Review a revoke") {
                        val summary = TxPreview.preview(allowlist.first(), "0x095ea7b3" + "cd".repeat(32) + "00".repeat(32), BigInteger.ZERO, allowlist)
                        screen = Screen.Review(summary)
                    }
                    Primary("Back") { screen = Screen.Home }
                }
                Screen.History -> {
                    if (history.isEmpty()) Text("No transactions signed on this phone yet.", color = Muted)
                    history.forEach { Text(it, color = Color.White) }
                    Primary("Back") { screen = Screen.Home }
                }
                is Screen.Token -> {
                    if (detailError != null) Text(detailError!!, color = Color(0xFFFF5D7A))
                    val token = detail
                    if (token == null && detailError == null) Text("Loading GeckoTerminal…", color = Muted)
                    if (token != null) {
                        Text("${token.symbol}  ${usd(token.priceUsd)}", color = Color.White)
                        Text("24h ${token.change24h?.let { "%+.2f%%".format(it) } ?: "—"} · vol ${usd(token.volume24hUsd)}", color = Muted)
                        Text("Liq ${usd(token.liquidityUsd)} · FDV ${usd(token.fdvUsd)} · mcap ${usd(token.marketCapUsd)}", color = Muted)
                        Text("Pools ${token.pools.size} · holders ${token.holders?.toString() ?: "—"}", color = Muted)
                        Text("GeckoTerminal", color = Cyan, modifier = Modifier.clickable {
                            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.geckoterminal.com/polygon_pos/tokens/${token.address}")))
                        })
                        Text("Polygonscan", color = Cyan, modifier = Modifier.clickable {
                            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://polygonscan.com/token/${token.address}")))
                        })
                        val selected = chartPool
                        Text(
                            if (selected == null) "Chart pool is chosen from liquidity and age." else "Chart pool ${selected.name} · ${selected.dex}. Quotes still use every venue.",
                            color = Muted,
                        )
                        val young = selected?.createdAt?.let { java.time.Instant.parse(it).toEpochMilli() > System.currentTimeMillis() - 14L * 86_400_000 } == true
                        val thin = (selected?.liquidityUsd ?: 0.0) < 10_000
                        if (young || thin) Text("Risk: ${if (young) "pool is under 14 days old. " else ""}${if (thin) "liquidity is under $10k." else ""}", color = Color(0xFFF0C36A))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            listOf("15m", "1h", "4h", "1d").forEach { item ->
                                Text(item, color = if (detailFrame == item) Cyan else Muted, modifier = Modifier.clickable { detailFrame = item })
                            }
                        }
                        if (candleMiss && detailCandles.isEmpty()) Text("No candles were published for the scored pools.", color = Muted)
                        CandleChart(detailCandles)
                        Primary("Use as token to receive") {
                            receiveTrend(TrendToken(token.address, token.symbol, token.priceUsd, token.change24h, token.liquidityUsd, selected?.createdAt, selected?.address ?: "", null))
                        }
                    }
                    Primary("Back") { screen = Screen.Home }
                }
                is Screen.Review -> {
                    Text(current.summary.kind, color = Cyan)
                    current.summary.lines.forEach { Text("${it.first}: ${it.second}", color = Color.White) }
                    current.summary.warnings.forEach { Text(it, color = Color(0xFFFF5D7A)) }
                    Text("Signing stays on this phone. Nothing here is sent to a log.", color = Muted)
                    Primary("Back") { screen = Screen.Home }
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun Primary(label: String, onClick: () -> Unit) {
    Button(onClick = onClick, colors = ButtonDefaults.buttonColors(containerColor = Cyan, contentColor = Ink), shape = RoundedCornerShape(24.dp), modifier = Modifier.fillMaxWidth()) {
        Text(label)
    }
}

private fun screenTitle(screen: Screen) = when (screen) {
    Screen.Blocked -> "Vault refused"
    Screen.Welcome -> "Hold your own keys"
    is Screen.Reveal -> "Backup"
    is Screen.Check -> "Confirm the backup"
    is Screen.Pin -> "Set a PIN"
    Screen.Unlock -> "Locked"
    Screen.Home -> "Polygon"
    Screen.Send -> "Send"
    Screen.Receive -> "Receive"
    Screen.Swap -> "Swap"
    Screen.Stake -> "Stake"
    Screen.Rewards -> "Rewards"
    Screen.Approvals -> "Approvals"
    Screen.History -> "History"
    is Screen.Review -> "Review"
    is Screen.Token -> "Token"
}

@Composable
private fun TrendFace(image: String?, symbol: String) {
    val safe = Gecko.safeImage(image)
    var bitmap by remember(safe) { mutableStateOf<androidx.compose.ui.graphics.ImageBitmap?>(null) }
    LaunchedEffect(safe) {
        bitmap = if (safe == null) null else withContext(Dispatchers.IO) {
            runCatching {
                val request = Request.Builder().url(safe).build()
                http.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) return@use null
                    val type = response.header("content-type").orEmpty()
                    if (!type.startsWith("image/")) return@use null
                    val body = response.body ?: return@use null
                    if (body.contentLength() > 1_000_000) return@use null
                    val source = body.source()
                    val out = ByteArray(1_000_000)
                    var used = 0
                    val chunk = ByteArray(8192)
                    while (used < out.size) {
                        val n = source.read(chunk)
                        if (n < 0) break
                        if (used + n > out.size) return@use null
                        chunk.copyInto(out, used, 0, n)
                        used += n
                    }
                    if (used == 0) return@use null
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeByteArray(out, 0, used, bounds)
                    if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || bounds.outWidth > 1024 || bounds.outHeight > 1024) return@use null
                    BitmapFactory.decodeByteArray(out, 0, used)?.asImageBitmap()
                }
            }.getOrNull()
        }
    }
    if (bitmap != null) {
        Image(bitmap!!, contentDescription = null, modifier = Modifier.size(36.dp).clip(CircleShape), contentScale = ContentScale.Crop)
    } else {
        Box(Modifier.size(36.dp).clip(CircleShape).background(Color(0xFF123044)), contentAlignment = Alignment.Center) {
            Text(symbol.filter { it.isLetterOrDigit() }.take(2).uppercase().ifEmpty { "?" }, color = Cyan)
        }
    }
}

private fun usd(value: Double?): String {
    if (value == null || value.isNaN() || value.isInfinite()) return "—"
    return when {
        value >= 1_000_000_000 -> "$%.2fB".format(value / 1_000_000_000)
        value >= 1_000_000 -> "$%.2fM".format(value / 1_000_000)
        value >= 10_000 -> "$%.1fK".format(value / 1_000)
        value >= 1 -> "$%.2f".format(value)
        else -> {
            val digits = "%.6f".format(value).trimEnd('0').trimEnd('.')
            if (digits == "0" || digits == "-0") "$0.00" else "$$digits"
        }
    }
}

private fun polToWei(amount: String): BigInteger {
    val parts = amount.trim().split(".")
    val whole = parts[0].ifEmpty { "0" }
    val frac = (parts.getOrNull(1) ?: "").padEnd(18, '0').take(18)
    return BigInteger(whole + frac)
}

private fun loadBalance(address: String): String = try {
    val body = """{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["$address","latest"]}"""
    val request = Request.Builder().url(RPC).post(body.toRequestBody("application/json".toMediaType())).build()
    val raw = http.newCall(request).execute().body?.string().orEmpty()
    val hex = Regex(""""result"\s*:\s*"(0x[0-9a-fA-F]+)"""").find(raw)?.groupValues?.get(1) ?: return "unavailable"
    val wei = BigInteger(hex.removePrefix("0x"), 16)
    val pol = wei.toBigDecimal().movePointLeft(18)
    pol.setScale(4, java.math.RoundingMode.DOWN).toPlainString()
} catch (_: Exception) {
    "unavailable"
}

private fun qr(text: String): Bitmap {
    val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 512, 512)
    val bitmap = Bitmap.createBitmap(512, 512, Bitmap.Config.ARGB_8888)
    for (x in 0 until 512) {
        for (y in 0 until 512) {
            bitmap.setPixel(x, y, if (matrix.get(x, y)) 0xFF3EE0FF.toInt() else 0xFF030712.toInt())
        }
    }
    return bitmap
}
