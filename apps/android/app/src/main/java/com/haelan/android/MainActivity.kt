package com.haelan.android

import android.content.Intent
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import com.google.android.material.button.MaterialButton
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.progressindicator.CircularProgressIndicator
import com.google.android.material.progressindicator.LinearProgressIndicator
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant

/**
 * Sync screen: permissions, one toggle per data type, and a sync button.
 * Read-only by design - it never writes to Health Connect, only reads a trailing window and
 * POSTs it to the haelan instance from sign-in.
 */
class MainActivity : ComponentActivity() {

    companion object {
        /** Where the sync's own answers go, which is the only place a failure is written now. */
        private const val TAG = "haelan-sync"
    }

    private data class SyncOption(val key: String, val titleRes: Int)

    // The keys come from SyncTypes, so a toggle cannot exist for a type with no source
    // behind it. What stays here is only the label each key wears.
    private val activityOptions = SyncTypes.ACTIVITY_KEYS.map { SyncOption(it, titleRes(it)) }
    private val bodyOptions = SyncTypes.BODY_KEYS.map { SyncOption(it, titleRes(it)) }
    private val heartOptions = SyncTypes.HEART_KEYS.map { SyncOption(it, titleRes(it)) }

    private fun titleRes(key: String): Int = when (key) {
        "steps" -> R.string.type_steps
        "distance" -> R.string.type_distance
        "elevation" -> R.string.type_elevation
        "active_energy" -> R.string.type_active_energy
        "basal" -> R.string.type_basal
        "exercise" -> R.string.type_exercise
        "sleep" -> R.string.type_sleep
        "weight" -> R.string.type_weight
        "height" -> R.string.type_height
        "body_fat" -> R.string.type_body_fat
        "body_temp" -> R.string.type_body_temp
        "glucose" -> R.string.type_glucose
        "hydration" -> R.string.type_hydration
        "heart_rate" -> R.string.type_heart_rate
        "resting" -> R.string.type_resting
        "hrv" -> R.string.type_hrv
        "spo2" -> R.string.type_spo2
        "breathing" -> R.string.type_breathing
        "vo2" -> R.string.type_vo2
        // Louder than a blank label: a key declared without one is a mistake, not a state.
        else -> throw IllegalArgumentException("no label for sync type $key")
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var permCheck: ImageView
    private lateinit var permStatus: TextView
    private lateinit var syncButton: MaterialButton
    private lateinit var batteryStatus: TextView

    /**
     * One bar inside each card, filled as the types of that card go: the three groups are the
     * three cards the screen already has, so the bar says which part of the sync is still running
     * without a line of text for every type.
     */
    private class SyncGroup(val row: View, val bar: LinearProgressIndicator) {
        var done = 0
        var total = 0
        var failed = false
    }

    private lateinit var groups: Map<String, SyncGroup>

    /** The state box each row carries, by the same key its toggle uses. */
    private val rowStates = mutableMapOf<String, RowState>()

    /** The sentence under each toggle that names its last finished run. */
    private val rowStatus = mutableMapOf<String, TextView>()

    /**
     * The box at the end of a row: spinning while its type is going, then the mark it left. The
     * slot keeps its size in all three states, so a running sync does not make the rows jump.
     */
    private class RowState(val spinner: View, val done: View, val error: View) {
        fun hide() {
            spinner.visibility = View.GONE
            done.visibility = View.GONE
            error.visibility = View.GONE
        }

        fun running() {
            hide()
            spinner.visibility = View.VISIBLE
        }

        fun synced() {
            hide()
            done.visibility = View.VISIBLE
        }

        fun failed() {
            hide()
            error.visibility = View.VISIBLE
        }
    }

    private lateinit var server: String
    private lateinit var personId: String
    private lateinit var cookie: String

    // One set for the whole app (SyncEngine.readPermissions): the screen that asks and the
    // worker that relies on the answer read the same strings.
    private val healthPermissions: Set<String> = SyncEngine.readPermissions()

    private val permissionLauncher = registerForActivityResult(
        PermissionController.createRequestPermissionResultContract(),
    ) { granted ->
        // A tap that changes nothing still answers: without this the button looks dead when
        // there is nothing left to ask, which is exactly when it gets tapped.
        showPermissions(healthPermissions - granted, afterRequest = true)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val stored = SessionStore.prefs(this)
        val session = SessionStore.Session(
            intent.getStringExtra(LoginActivity.EXTRA_SERVER) ?: "",
            intent.getStringExtra(LoginActivity.EXTRA_PERSON_ID) ?: "",
            intent.getStringExtra(LoginActivity.EXTRA_COOKIE) ?: "",
            intent.getStringExtra(LoginActivity.EXTRA_USERNAME) ?: "",
        ).takeIf {
            it.server.isNotEmpty() && it.personId.isNotEmpty()
                && it.cookie.isNotEmpty() && it.username.isNotEmpty()
        } ?: SessionStore.loadSession(stored)
        if (session == null) {
            goLogin(expired = false)
            return
        }
        server = session.server
        personId = session.personId
        cookie = session.cookie

        // The background sync lives as long as a sign-in does: keep the schedule on every start
        // (the first enqueue wins), and the sign-out needs no matching cancel because a worker
        // with no session no-ops until the next sign-in enqueues again.
        SyncSchedule.enqueue(this)

        setContentView(R.layout.activity_main)
        permCheck = findViewById(R.id.permCheck)
        permStatus = findViewById(R.id.permStatus)
        syncButton = findViewById(R.id.buttonSync)
        batteryStatus = findViewById(R.id.batteryStatus)

        val activityGroup = SyncGroup(findViewById(R.id.progressActivityRow), findViewById(R.id.progressActivity))
        val bodyGroup = SyncGroup(findViewById(R.id.progressBodyRow), findViewById(R.id.progressBody))
        val heartGroup = SyncGroup(findViewById(R.id.progressHeartRow), findViewById(R.id.progressHeart))
        groups = buildMap {
            for (key in SyncTypes.ACTIVITY_KEYS) put(key, activityGroup)
            for (key in SyncTypes.BODY_KEYS) put(key, bodyGroup)
            for (key in SyncTypes.HEART_KEYS) put(key, heartGroup)
        }

        findViewById<TextView>(R.id.accountLabel).text = getString(R.string.main_account, session.username)
        findViewById<MaterialButton>(R.id.buttonSignOut).setOnClickListener { signOut() }
        findViewById<MaterialButton>(R.id.buttonPermissions).setOnClickListener {
            scope.launch { checkProviderThen { permissionLauncher.launch(healthPermissions) } }
        }
        syncButton.setOnClickListener {
            scope.launch { checkProviderThen { syncNow() } }
        }
        findViewById<MaterialButton>(R.id.buttonBattery).setOnClickListener { openBatterySettings() }

        buildRows(findViewById(R.id.rowsActivity), activityOptions)
        buildRows(findViewById(R.id.rowsBody), bodyOptions)
        buildRows(findViewById(R.id.rowsHeart), heartOptions)
        refreshSyncStatus()
        refreshBatteryCard()
    }

    override fun onResume() {
        super.onResume()
        refreshSyncStatus()
        refreshBatteryCard()
        scope.launch {
            val client = healthClient(silent = true) ?: return@launch
            val granted = withContext(Dispatchers.IO) {
                client.permissionController.getGrantedPermissions()
            }
            showPermissions(healthPermissions - granted)
        }
    }

    /**
     * The system list where Hælan can be set to unrestricted. No permission needed to open
     * it: the choice stays with the person, and this screen only names it.
     */
    private fun openBatterySettings() {
        try {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        } catch (e: Exception) {
            Log.w(TAG, "battery settings not opened: ${e.message}")
        }
    }

    /**
     * Whether the system is currently allowed to pause this app. Read, never remembered:
     * the exemption can be granted or revoked between two resumes.
     */
    private fun isBatteryExempt(): Boolean {
        val power = getSystemService(POWER_SERVICE) as? PowerManager ?: return false
        return power.isIgnoringBatteryOptimizations(packageName)
    }

    private fun refreshBatteryCard() {
        if (!::batteryStatus.isInitialized) return
        batteryStatus.text = if (isBatteryExempt()) {
            getString(R.string.battery_exempt)
        } else {
            getString(R.string.battery_body)
        }
    }

    /**
     * One sentence per toggle about its last finished run. Never means no run ever finished
     * for it, empty means the last run finished and found nothing, and the day count is what
     * makes a silent gap visible after Doze stops the background run.
     */
    private fun statusText(key: String, nowMs: Long): String {
        val last = prefs().getLong(SyncStatus.lastKey(key), 0L)
        if (last <= 0L) return getString(R.string.status_never)
        val empty = prefs().getBoolean(SyncStatus.emptyKey(key), false)
        val days = SyncStatus.daysSince(last, nowMs)
        val base = if (empty) {
            if (days < 1L) getString(R.string.status_empty_today)
            else resources.getQuantityString(R.plurals.status_empty_days, days.toInt(), days.toInt())
        } else {
            if (days < 1L) getString(R.string.status_sent_today)
            else resources.getQuantityString(R.plurals.status_sent_days, days.toInt(), days.toInt())
        }
        return getString(R.string.status_at, base, SyncStatus.formatAt(last))
    }

    private fun refreshSyncStatus() {
        if (rowStatus.isEmpty()) return
        val nowMs = System.currentTimeMillis()
        for ((key, view) in rowStatus) {
            view.text = statusText(key, nowMs)
        }
    }

    private fun recordSent(key: String, nowMs: Long) {
        prefs().edit()
            .putLong(SyncStatus.lastKey(key), nowMs)
            .putBoolean(SyncStatus.emptyKey(key), false)
            .apply()
        rowStatus[key]?.text = statusText(key, nowMs)
    }

    private fun recordEmpty(key: String, nowMs: Long) {
        prefs().edit()
            .putLong(SyncStatus.lastKey(key), nowMs)
            .putBoolean(SyncStatus.emptyKey(key), true)
            .apply()
        rowStatus[key]?.text = statusText(key, nowMs)
    }

    /**
     * The tick and the sentence both answer one question: is there anything left to ask for.
     * [afterRequest] only changes the wording, because a request that granted everything and a
     * screen that was already complete read differently to somebody who just tapped.
     */
    private fun showPermissions(missing: Set<String>, afterRequest: Boolean = false) {
        if (!::permStatus.isInitialized) return
        val granted = missing.isEmpty()
        permCheck.visibility = if (granted) View.VISIBLE else View.GONE
        permStatus.text = when {
            !granted -> getString(R.string.perm_missing, missing.size.toString())
            afterRequest -> getString(R.string.perm_already)
            else -> getString(R.string.perm_granted)
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun prefs() = SessionStore.prefs(this)

    private fun isOn(key: String): Boolean = prefs().getBoolean("sync_$key", true)

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun buildRows(container: LinearLayout, options: List<SyncOption>) {
        for (option in options) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(12), dp(10), dp(12), dp(10))
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                )
            }
            val texts = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            val title = TextView(this).apply {
                text = getString(option.titleRes)
                setTextColor(getColor(R.color.text_primary))
                textSize = 15f
            }
            val subtitle = TextView(this).apply {
                setText(R.string.src_health_connect)
                setTextColor(getColor(R.color.text_muted))
                textSize = 12f
            }
            val status = TextView(this).apply {
                setText(R.string.status_never)
                setTextColor(getColor(R.color.text_secondary))
                textSize = 12f
            }
            texts.addView(title)
            texts.addView(subtitle)
            texts.addView(status)
            rowStatus[option.key] = status
            val toggle = MaterialSwitch(this).apply {
                isChecked = isOn(option.key)
                contentDescription = getString(option.titleRes)
                setOnCheckedChangeListener { _, checked ->
                    prefs().edit().putBoolean("sync_${option.key}", checked).apply()
                }
            }
            row.setOnClickListener { toggle.toggle() }
            row.addView(texts)
            // The state box: a slot of its own so the row does not change width as a type goes
            // from waiting to spinning to marked. A log line would have to name the type; the
            // row is where somebody looks for the type that did not go.
            val spinner = CircularProgressIndicator(this).apply {
                isIndeterminate = true
                trackThickness = dp(2)
                setIndicatorColor(getColor(R.color.accent))
                visibility = View.GONE
                layoutParams = FrameLayout.LayoutParams(dp(18), dp(18), Gravity.CENTER)
            }
            val done = ImageView(this).apply {
                setImageResource(R.drawable.ic_check_ok)
                contentDescription = getString(R.string.type_sent)
                visibility = View.GONE
                layoutParams = FrameLayout.LayoutParams(dp(16), dp(16), Gravity.CENTER)
            }
            val error = ImageView(this).apply {
                setImageResource(R.drawable.ic_error)
                contentDescription = getString(R.string.type_failed)
                visibility = View.GONE
                layoutParams = FrameLayout.LayoutParams(dp(16), dp(16), Gravity.CENTER)
            }
            val state = FrameLayout(this).apply {
                layoutParams = LinearLayout.LayoutParams(dp(20), dp(20)).apply {
                    marginEnd = dp(10)
                }
                addView(spinner)
                addView(done)
                addView(error)
            }
            rowStates[option.key] = RowState(spinner, done, error)
            row.addView(state)
            row.addView(toggle)
            container.addView(row)
        }
    }

    private fun goLogin(expired: Boolean) {
        startActivity(Intent(this, LoginActivity::class.java).apply {
            putExtra(LoginActivity.EXTRA_EXPIRED, expired)
        })
        finish()
    }

    private fun signOut() {
        scope.launch {
            withContext(Dispatchers.IO) {
                // Best effort by construction: the client returns the failure rather than
                // throwing it, and the session cookie is dropped either way below. An instance
                // that is unreachable must not be able to keep somebody signed in.
                InstanceClient.post(server, "/api/auth/logout", "{}", cookie) { }
            }
            SessionStore.clearSession(SessionStore.prefs(this@MainActivity))
            goLogin(expired = false)
        }
    }

    private suspend fun healthClient(silent: Boolean = false): HealthConnectClient? {
        val availability = HealthConnectClient.getSdkStatus(this)
        if (availability != HealthConnectClient.SDK_AVAILABLE) {
            if (!silent) Toast.makeText(this, R.string.perm_unavailable, Toast.LENGTH_LONG).show()
            return null
        }
        return HealthConnectClient.getOrCreate(this)
    }

    private suspend fun checkProviderThen(block: suspend () -> Unit) {
        if (healthClient() == null) return
        block()
    }

    // ---- Sync: read Health Connect, map to the v4 shape, POST ----

    /**
     * A body the instance refused, as an outcome rather than a throw. The status decides what the
     * screen does with it, and 401 is the one that concerns every type rather than this one.
     */
    private class Refused(val status: Int, val answer: String) : Exception("$status: $answer")

    /**
     * A session that is over, carried out of the one place that knows: [syncType] parks it on this
     * field, because its own contract is to turn a failure into a mark on a row, and this is the
     * failure that belongs to the whole sync.
     */
    private var sessionExpired = false

    private fun goLoginExpired() {
        // The stored cookie is dead: the instance forgot it (a reset wipes sessions) or it
        // was replaced elsewhere. Landing on the login screen with it still stored replays
        // it straight back here through auto-login, which reads as the sync button doing
        // nothing but bouncing between the two screens. Forget it first, the way sign-out
        // does; the address and username stay prefilled for the next sign-in.
        SessionStore.clearSession(SessionStore.prefs(this))
        sessionExpired = true
        goLogin(expired = true)
    }

    /**
     * The sentence for a failure, in the language the phone is set to. What the instance
     * actually answered goes to logcat, where a developer looks and a person does not.
     */
    private fun reasonFor(error: Throwable): String {
        Log.w(TAG, error.message ?: error.javaClass.simpleName)
        return when (error) {
            is Refused -> getString(InstanceError.forStatus(error.status), error.status)
            else -> getString(InstanceError.forThrowable(error))
        }
    }

    private suspend fun syncNow() {
        val allOptions = activityOptions + bodyOptions + heartOptions
        val sending = allOptions.filter { isOn(it.key) }
        if (sending.isEmpty()) {
            Toast.makeText(this, R.string.sync_none, Toast.LENGTH_SHORT).show()
            return
        }
        val client = healthClient() ?: return
        syncButton.isEnabled = false
        syncButton.setText(R.string.sync_working)
        startProgress(sending)
        try {
            val session = SyncEngine.Session(server, personId, cookie)
            val runEnd = Instant.now()
            val runEndMs = runEnd.toEpochMilli()
            // The box spins for as long as its type is going: the read and the upload both
            // suspend, so this is what somebody watching the screen sees between the two marks.
            val report = object : SyncEngine.Reporter {
                override fun typeStarted(key: String) {
                    rowStates[key]?.running()
                }
                override fun typeOk(key: String) {
                    rowStates[key]?.synced()
                    recordSent(key, runEndMs)
                    // Counted whether it went or not: the bar says how much of this group has
                    // been tried, and a type that failed is not still waiting.
                    advance(key)
                }
                override fun typeEmpty(key: String) {
                    // A finished read with nothing behind it: no tick, because nothing was
                    // sent, and its own sentence, because never ran and nothing there are
                    // the two answers kept apart.
                    rowStates[key]?.hide()
                    recordEmpty(key, runEndMs)
                    advance(key)
                }
                override fun typeFailed(key: String, error: Throwable) {
                    // A type that fails no longer stops the others: its row takes the error
                    // icon, its group's bar turns amber, and the reason goes to logcat.
                    Log.w(TAG, "${SyncTypes.forKey(key).dataTypeId} not sent: ${reasonFor(error)}")
                    rowStates[key]?.failed()
                    markGroupFailed(key)
                    advance(key)
                }
                // The one answer that concerns every type rather than this one: the whole
                // session is over, and the engine already stopped the types after it, so the
                // screen that kept going would only open login twice.
                override fun sessionExpired() = goLoginExpired()
            }
            // What the instance already holds, so each type reads its delta. A fetch
            // that fails is not a sync failure: every type then keeps the full window.
            val cursorsOutcome = withContext(Dispatchers.IO) {
                InstanceClient.get(session.server, SyncCursors.pathFor(session.personId), session.cookie) {
                    SyncCursors.parseCursorEnds(it.body)
                }
            }
            if (cursorsOutcome is InstanceClient.Outcome.Failed) {
                val error = cursorsOutcome.error
                if (error is InstanceClient.InstanceHttpException && error.status == 401) {
                    goLoginExpired()
                    return
                }
                Log.w(TAG, "cursors not read, full window instead: ${reasonFor(error)}")
            }
            val cursorEnds = (cursorsOutcome as? InstanceClient.Outcome.Ok)?.value ?: emptyMap()
            SyncEngine.syncAll(
                client = client,
                session = session,
                packageName = packageName,
                prefs = prefs(),
                end = runEnd,
                post = { path, payload ->
                    // The whole exchange stays off the main thread: even reading the status line
                    // counts as network I/O down here and throws on the UI thread.
                    withContext(Dispatchers.IO) {
                        InstanceClient.post(session.server, path, payload, session.cookie) { }
                    }
                },
                report = report,
                cursorEnds = cursorEnds,
            )
        } catch (e: Exception) {
            Toast.makeText(this, getString(R.string.sync_failed, reasonFor(e)), Toast.LENGTH_LONG).show()
        } finally {
            syncButton.isEnabled = true
            syncButton.setText(R.string.sync_action)
        }
        // The login screen is opened by goLoginExpired, in the one place that recognized the 401.
        // This only clears the flag, and anything else that ever sets it has to open the screen
        // itself: doing it here too meant a session that expired opened LoginActivity twice.
        sessionExpired = false
    }

    /**
     * A sync moves one type at a time, and each bar says how far its own group has got: a bar
     * that only moved when the whole sync ended would say nothing while it still matters.
     */
    private fun startProgress(sending: List<SyncOption>) {
        for (state in rowStates.values) state.hide()
        for (group in groups.values.toSet()) {
            group.row.visibility = View.VISIBLE
            group.done = 0
            group.total = sending.count { groups[it.key] === group }
            group.failed = false
            group.bar.setIndicatorColor(getColor(R.color.accent))
            group.bar.max = maxOf(group.total, 1)
            group.bar.setProgressCompat(0, false)
        }
    }

    private fun advance(key: String) {
        val group = groups[key] ?: return
        group.done += 1
        group.bar.setProgressCompat(group.done, true)
    }

    /** The bar of the group a failed type belongs to turns amber; the row carries its own mark. */
    private fun markGroupFailed(key: String) {
        val group = groups[key] ?: return
        if (group.failed) return
        group.failed = true
        group.bar.setIndicatorColor(getColor(R.color.warning))
    }
}
