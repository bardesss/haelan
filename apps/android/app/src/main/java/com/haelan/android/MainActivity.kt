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
import androidx.health.connect.client.contracts.ExerciseRouteRequestContract
import androidx.health.connect.client.records.ExerciseRoute
import androidx.health.connect.client.records.ExerciseRouteResult
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.lifecycle.Lifecycle
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

/**
 * Sync screen: permissions, one toggle per data type, and a sync button.
 * Read-only by design - it never writes to Health Connect, only reads a trailing window and
 * POSTs it to the haelan instance from sign-in.
 */
class MainActivity : ComponentActivity(), SyncRunState.Screen {

    companion object {
        /** Where the sync's own answers go, which is the only place a failure is written now. */
        private const val TAG = "haelan-sync"

        /** The workout whose route Health Connect is being asked for, across a recreation. */
        private const val STATE_PENDING_ROUTE = "pending_route_id"
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
     *
     * The card's own keys are here because everything the bar shows is read off the run's marks:
     * how many of them the run carries, how many have an answer, and whether one of them failed.
     */
    private class SyncGroup(val row: View, val bar: LinearProgressIndicator, val keys: List<String>)

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

    private lateinit var routesBlock: View
    private lateinit var routesStatus: TextView

    /**
     * The workout the route request below was launched for. The contract answers with the route
     * alone, not the id it was asked about, and the answer can arrive in a new instance of this
     * screen when the phone turned while Health Connect's dialog was up - so it is kept in the
     * saved state rather than in a closure.
     */
    private var pendingRouteId: String? = null

    /** A walk through the withheld routes is going; a second tap would start a second one. */
    private var releasing = false

    private val routeLauncher = registerForActivityResult(ExerciseRouteRequestContract()) { route ->
        val id = pendingRouteId
        pendingRouteId = null
        scope.launch { answerRoute(id, route) }
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
        pendingRouteId = savedInstanceState?.getString(STATE_PENDING_ROUTE)

        // The background sync lives as long as a sign-in does: keep the schedule on every start
        // (the first enqueue wins), and the sign-out needs no matching cancel because a worker
        // with no session no-ops until the next sign-in enqueues again.
        SyncSchedule.enqueue(this)

        setContentView(R.layout.activity_main)
        findViewById<android.view.View>(R.id.mainRoot).padForSystemBars()
        permCheck = findViewById(R.id.permCheck)
        permStatus = findViewById(R.id.permStatus)
        syncButton = findViewById(R.id.buttonSync)
        batteryStatus = findViewById(R.id.batteryStatus)

        val activityGroup = SyncGroup(
            findViewById(R.id.progressActivityRow), findViewById(R.id.progressActivity), SyncTypes.ACTIVITY_KEYS,
        )
        val bodyGroup = SyncGroup(
            findViewById(R.id.progressBodyRow), findViewById(R.id.progressBody), SyncTypes.BODY_KEYS,
        )
        val heartGroup = SyncGroup(
            findViewById(R.id.progressHeartRow), findViewById(R.id.progressHeart), SyncTypes.HEART_KEYS,
        )
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
        routesBlock = findViewById(R.id.routesBlock)
        routesStatus = findViewById(R.id.routesStatus)
        findViewById<MaterialButton>(R.id.buttonRoutes).setOnClickListener {
            if (releasing) return@setOnClickListener
            releasing = true
            scope.launch { releaseNext() }
        }
        syncButton.setOnClickListener { scope.launch { startSync() } }
        findViewById<MaterialButton>(R.id.buttonBattery).setOnClickListener { openBatterySettings() }

        buildRows(findViewById(R.id.rowsActivity), activityOptions)
        buildRows(findViewById(R.id.rowsBody), bodyOptions)
        buildRows(findViewById(R.id.rowsHeart), heartOptions)
        refreshSyncStatus()
        refreshBatteryCard()
        // Last, and deliberately: what this paints first may be a run this activity did not start,
        // which is what a screen created by a rotation has to show instead of an idle button.
        SyncRun.attach(this)
    }

    override fun onResume() {
        super.onResume()
        // A run outlives this screen, so it can meet a 401 while this screen is stopped, and an
        // activity started from the background is not shown. The notice waits for the resume.
        if (sessionEnded) {
            goLogin(expired = true)
            return
        }
        refreshSyncStatus()
        refreshBatteryCard()
        refreshRoutes()
        scope.launch { syncIfStale() }
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

    /**
     * Why a type failed, for the types that did, kept from the last paint.
     *
     * The status line has two writers, this screen's own tick and the run's paint, and before this
     * they fought: paint set the reason, refreshSyncStatus overwrote the words from the prefs a
     * moment later and left the colour behind, so a row ended up red and still saying "never
     * synced". One writer now, and this is what it needs that the prefs cannot tell it.
     */
    private var failureReasons: Map<String, String> = emptyMap()

    private fun refreshSyncStatus() {
        if (rowStatus.isEmpty()) return
        val nowMs = System.currentTimeMillis()
        for ((key, view) in rowStatus) {
            // A failure outranks the prefs sentence. The prefs know when a type last succeeded,
            // which stays true and stays useless while the reason it is failing now goes unsaid.
            val reason = failureReasons[key]
            view.text = reason ?: statusText(key, nowMs)
            view.setTextColor(getColor(if (reason != null) R.color.negative else R.color.text_secondary))
        }
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

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        pendingRouteId?.let { outState.putString(STATE_PENDING_ROUTE, it) }
    }

    // ---- Withheld routes: released one workout at a time, from the one screen that can ----

    private fun engineSession() = SyncEngine.Session(server, personId, cookie)

    /** The count comes from RouteLedger, which every run updates; nothing here keeps its own. */
    private fun refreshRoutes() {
        if (!::routesBlock.isInitialized) return
        val count = RouteLedger.load(prefs(), RouteLedger.ownerOf(engineSession())).withheld.size
        routesBlock.visibility = if (count > 0) View.VISIBLE else View.GONE
        routesStatus.text = resources.getQuantityString(R.plurals.routes_withheld, count, count)
    }

    /**
     * Walks the withheld list until it meets a route only the household can release, asks for
     * that one, and stops there until the answer comes back to [answerRoute].
     *
     * Each id is read again first, in the foreground, because the answer may have changed since
     * the sync that filed it: after one "Always allow" every other route in the list reads as
     * `Data` here and goes without a dialog, and a workout deleted from Health Connect since is
     * dropped rather than asked about. That read is also what keeps a stale id from blocking the
     * walk: Health Connect's route screen finishes cancelled for a session it cannot find, which
     * would look exactly like the household saying no.
     */
    private suspend fun releaseNext() {
        releasing = true
        val client = healthClient()
        if (client == null) {
            finishRelease()
            return
        }
        val owner = RouteLedger.ownerOf(engineSession())
        val ready = mutableListOf<Pair<ExerciseSessionRecord, ExerciseRoute>>()
        for (id in RouteLedger.load(prefs(), owner).withheld.sorted()) {
            val record = when (val read = readSession(client, id)) {
                SessionRead.Gone -> {
                    RouteLedger.forget(prefs(), owner, id)
                    continue
                }
                // Not gone, only unreadable right now: left in the list for the next walk rather
                // than forgotten, and not allowed to stop this one.
                SessionRead.Failed -> continue
                is SessionRead.Found -> read.record
            }
            when (val result = record.exerciseRouteResult) {
                is ExerciseRouteResult.Data -> {
                    if (result.exerciseRoute.route.isNotEmpty()) {
                        ready += record to result.exerciseRoute
                    } else {
                        RouteLedger.record(prefs(), owner, mapOf(id to RouteLedger.Seen.NONE))
                    }
                }
                is ExerciseRouteResult.ConsentRequired -> {
                    // What is already in hand goes first, so a dialog the household walks away
                    // from does not also cost the routes that needed none.
                    if (!sendReleased(ready)) {
                        finishRelease()
                        return
                    }
                    pendingRouteId = id
                    routeLauncher.launch(id)
                    return
                }
                // The route is gone at the source: nothing is left to release.
                else -> RouteLedger.record(prefs(), owner, mapOf(id to RouteLedger.Seen.NONE))
            }
        }
        sendReleased(ready)
        finishRelease()
    }

    /**
     * Health Connect's answer for [id]. Null is every way of not releasing it - "Don't allow",
     * the back button, a dialog that never drew - and all of them stop the walk: asking about the
     * next workout straight after the household declined this one would be the app arguing.
     */
    private suspend fun answerRoute(id: String?, route: ExerciseRoute?) {
        releasing = true
        if (id == null || route == null) {
            if (route == null) Toast.makeText(this, R.string.routes_stopped, Toast.LENGTH_SHORT).show()
            finishRelease()
            return
        }
        val client = healthClient()
        if (client == null) {
            finishRelease()
            return
        }
        when (val read = readSession(client, id)) {
            SessionRead.Gone -> RouteLedger.forget(prefs(), RouteLedger.ownerOf(engineSession()), id)
            SessionRead.Failed -> {
                finishRelease()
                return
            }
            is SessionRead.Found -> if (!sendReleased(listOf(read.record to route))) {
                finishRelease()
                return
            }
        }
        releaseNext()
    }

    private fun finishRelease() {
        releasing = false
        refreshRoutes()
    }

    private sealed interface SessionRead {
        data class Found(val record: ExerciseSessionRecord) : SessionRead
        data object Gone : SessionRead
        data object Failed : SessionRead
    }

    /**
     * One session by its id, telling "the workout is gone" apart from "it could not be read now":
     * only the first may cost an id the household may still want released.
     *
     * Gone has one spelling per client. On Android 14 and later connect-client reads by id and,
     * finding nothing, throws `RemoteException("No records")` itself
     * (HealthConnectClientUpsideDownImpl.readRecord, connect-client 1.1.0) - the same class a
     * provider that died mid-call throws, so the message is what tells them apart. The platform's
     * own ERROR_INVALID_ARGUMENT arrives as an IllegalArgumentException (ExceptionConverter), which
     * is an id Health Connect refuses outright. Everything else - a revoked permission, a
     * restarting provider - is Failed.
     */
    private suspend fun readSession(
        client: androidx.health.connect.client.HealthConnectClient,
        id: String,
    ): SessionRead = withContext(Dispatchers.IO) {
        try {
            SessionRead.Found(client.readRecord(ExerciseSessionRecord::class, id).record)
        } catch (e: IllegalArgumentException) {
            SessionRead.Gone
        } catch (e: android.os.RemoteException) {
            if (e.message == "No records") SessionRead.Gone else SessionRead.Failed
        } catch (e: Exception) {
            Log.w(TAG, "route session $id not read: ${e.message ?: e.javaClass.simpleName}")
            SessionRead.Failed
        }
    }

    /** Posts released routes; false when they did not land, having said why. */
    private suspend fun sendReleased(released: List<Pair<ExerciseSessionRecord, ExerciseRoute>>): Boolean {
        if (released.isEmpty()) return true
        val outcome = SyncEngine.uploadReleased(engineSession(), packageName, prefs(), released) { path, payload ->
            withContext(Dispatchers.IO) { InstanceClient.post(server, path, payload, cookie) { } }
        }
        if (outcome is InstanceClient.Outcome.Failed) {
            val error = outcome.error
            if (error is InstanceClient.InstanceHttpException && error.status == 401) {
                // The same end a run's 401 gets: the cookie is forgotten and login says why.
                SessionStore.clearSession(prefs())
                goLogin(expired = true)
                return false
            }
            Toast.makeText(this, getString(R.string.sync_failed, SyncRun.reasonFor(this, error)), Toast.LENGTH_LONG)
                .show()
            return false
        }
        return true
    }

    /**
     * The screen goes; the run does not. The scope cancelled here is this screen's own work, the
     * permission read and the sign-out; the sync is not in it, because a rotation that cancelled
     * an upload would leave the instance's cursor ahead of what never landed.
     */
    override fun onDestroy() {
        SyncRun.detach(this)
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

    // ---- The sync on screen: the run belongs to SyncRun, and this screen draws it ----

    /**
     * Set when a run met a 401 while this screen could not act on it. Nothing resets it: the
     * screen that reads it is on its way to login.
     */
    private var sessionEnded = false

    /**
     * The tap. The toggles say what travels, the run belongs to [SyncRun] - which no rotation
     * cancels - and this only refuses the taps that cannot start one.
     */
    /**
     * How long after the last successful type a reopened screen starts a run of its own.
     *
     * The background schedule is every two hours, which answers "later today" and does not answer
     * "I just finished a run and want to see it". Opening the app is the clearest signal there is
     * that somebody wants their data now, and it costs nothing when there is nothing new: the
     * cursor says where to start, so a delta read finds nothing and posts nothing.
     *
     * Throttled, because onResume fires on every return to this screen: a permission dialog
     * closing, a task switch, a notification pulled down. Without a gap the app would start a run
     * each time somebody glanced at it.
     */
    private val onOpenGapMs = 15L * 60L * 1000L

    /**
     * A run when the screen comes back and nothing has synced for a while. Silent either way:
     * this is not a tap, so a screen that decides against it says nothing, and one that decides
     * for it draws the run it already knows how to draw.
     */
    private suspend fun syncIfStale() {
        // No check for a run already going: SyncRun.start refuses a second one itself, because
        // SyncRunState.begin owns that rule. Repeating it here would be a second place to get it
        // wrong.
        val sending = (activityOptions + bodyOptions + heartOptions).filter { isOn(it.key) }
        if (sending.isEmpty()) return
        // The newest across the types that travel, not the oldest: one type that has never had
        // anything in Health Connect would otherwise hold the whole screen at zero for ever and
        // start a run on every resume.
        val newest = sending.maxOfOrNull { prefs().getLong(SyncStatus.lastKey(it.key), 0L) } ?: 0L
        if (System.currentTimeMillis() - newest < onOpenGapMs) return
        startSync()
    }

    private suspend fun startSync() {
        val sending = (activityOptions + bodyOptions + heartOptions).filter { isOn(it.key) }
        if (sending.isEmpty()) {
            Toast.makeText(this, R.string.sync_none, Toast.LENGTH_SHORT).show()
            return
        }
        val client = healthClient() ?: return
        SyncRun.start(this, client, SyncEngine.Session(server, personId, cookie), sending.map { it.key }.toSet())
    }

    /**
     * The run, as this screen draws it: the button, the three bars and the box at the end of each
     * row. Called whenever the run changes and once when this activity attaches, so a screen
     * created by a rotation shows the run that is still going instead of an idle button.
     */
    override fun paint(status: SyncRunState.Status) {
        // Handed to the one writer of the status line rather than written here, so a tick landing
        // a moment later cannot overwrite the words and leave the colour.
        failureReasons = status.reasons
        refreshSyncStatus()
        syncButton.isEnabled = !status.running
        syncButton.setText(if (status.running) R.string.sync_working else R.string.sync_action)
        for ((key, box) in rowStates) {
            when (status.marks[key]) {
                SyncRunState.Mark.RUNNING -> box.running()
                SyncRunState.Mark.SENT -> box.synced()
                SyncRunState.Mark.FAILED -> box.failed()
                // A type with nothing behind it and a type the run never reached show the same box:
                // what keeps "nothing there" and "never ran" apart is the sentence below, and that
                // sentence is read from the prefs rather than drawn from the mark.
                SyncRunState.Mark.EMPTY, SyncRunState.Mark.IDLE, null -> box.hide()
            }
        }
        for (group in groups.values.toSet()) {
            val carrying = group.keys.filter { it in status.sending }
            if (carrying.isEmpty()) {
                group.row.visibility = View.GONE
                continue
            }
            group.row.visibility = View.VISIBLE
            group.bar.max = carrying.size
            group.bar.setProgressCompat(carrying.count { status.marks[it]?.answered == true }, true)
            val failed = carrying.any { status.marks[it] == SyncRunState.Mark.FAILED }
            group.bar.setIndicatorColor(getColor(if (failed) R.color.warning else R.color.accent))
        }
        refreshSyncStatus()
        // A finished run may have met new withheld routes, or delivered some the list still named.
        if (!status.running) refreshRoutes()
    }

    /**
     * The session is over. The cookie is already forgotten by the run that met the 401, so this
     * only says so, and only while this screen is up to say it: a run that outlives the screen can
     * meet the 401 while it is stopped, and that case waits in [onResume].
     */
    override fun sessionExpired() {
        sessionEnded = true
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) goLogin(expired = true)
    }

    /** The run threw, which is not one type's failure: the screen says so once, and that is all. */
    override fun runFailed(error: Throwable) {
        Toast.makeText(this, getString(R.string.sync_failed, SyncRun.reasonFor(this, error)), Toast.LENGTH_LONG)
            .show()
    }
}
