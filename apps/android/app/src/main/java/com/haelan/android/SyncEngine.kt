package com.haelan.android

import android.content.SharedPreferences
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.changes.DeletionChange
import androidx.health.connect.client.changes.UpsertionChange
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.BasalMetabolicRateRecord
import androidx.health.connect.client.records.BloodGlucoseRecord
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.BodyTemperatureRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ElevationGainedRecord
import androidx.health.connect.client.records.ExerciseRoute
import androidx.health.connect.client.records.ExerciseRouteResult
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.HeightRecord
import androidx.health.connect.client.records.HydrationRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RespiratoryRateRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.Vo2MaxRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.ChangesTokenRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import kotlin.reflect.KClass

/**
 * The sync itself: read Health Connect, map to the v4 shape, POST. Shared by the screen's
 * button and the background worker, because the two copies that used to live in
 * `MainActivity` and `LoginActivity` had already drifted once and a third copy would
 * drift again.
 *
 * Everything here is headless: progress reaches the caller through [Reporter], and the HTTP
 * exchange through [post]. The screen reports rows and toasts; the worker logs and counts.
 */
object SyncEngine {

    /**
     * Types whose uploads are cut on minute boundaries: the ones the instance downsamples to a
     * minute per request (downsampleToMinute in the catalogue; a vitest guard keeps the two equal).
     */
    internal val MINUTE_ALIGNED_TYPES: Set<String> = setOf("heart-rate")

    /** Where the sync's own answers go, which is the only place a failure is written now. */
    const val TAG = "haelan-sync"

    // The instance refuses a body over its own limit, and a point is not a unit of size: a
    // thousand heart rate samples and a thousand weigh-ins differ by three orders of
    // magnitude. Half a mebibyte of JSON per request stays well inside it either way.
    private const val MAX_CHUNK_BYTES = 512 * 1024

    /**
     * How much time one request may cover, which the byte budget above cannot express.
     *
     * The byte budget bounds a chunk's size and nothing about its reach: a source that writes
     * little never fills 512 KiB, so it posts once, and that one request can carry its whole
     * window, and a refusal then costs the whole window in one go. A refused chunk now leaves the
     * type's change token unsaved, so the next run sends it again; bounding a chunk's reach still
     * bounds how much one refusal holds back until then.
     *
     * Twelve hours is half of SyncCursors.OVERLAP_MS, chosen when a refused type was re-read from
     * its cursor minus that overlap: the worst a refusal could leave unposted was one chunk, and
     * half the overlap covered it with the other half to spare.
     *
     * The dense case is unchanged: a day of heart rate passes 512 KiB first and is cut by bytes
     * as it always was. This only starts biting on the sparse types, which are the ones that
     * never split today.
     */
    internal const val MAX_CHUNK_SPAN_MS = 12L * 60L * 60L * 1000L

    /**
     * How many points one request may carry, which neither ceiling above can express.
     *
     * The route refuses a request carrying more than 10000 points (ingest.ts, MAX_POINTS),
     * counted as points rather than weighed: a heart rate sample is some twenty bytes of JSON,
     * so a dense hour fits 24000 of them inside the 512 KiB budget above and inside the twelve
     * hour span beside it, and travels as one request the instance answers with a 400. Seen on
     * a real phone, 2026-09-18: 24045 heart rate points in one chunk, whole type unposted.
     *
     * Spelled here rather than read from the server because the app has no Node toolchain at
     * build time; kept ten below the route's own so the two can drift by a rounding without a
     * 400. A chunk cut here is still one chunk of the same hour, posted by the same loop in
     * the same order - the split changes how many requests an hour travels in, never which
     * readings travel.
     */
    internal const val MAX_CHUNK_POINTS = 9_990

    /**
     * How many times one request is attempted before the type is told the chunk did not go.
     *
     * The retry is what stops a refusal from abandoning the rest of the type: the loop returns on
     * the first permanent failure, so everything after it goes unposted too. It is safe without a
     * request id because a post is idempotent by construction - the instance upserts samples on
     * their natural key and files a page that maps to no rows as no write at all - so a second
     * attempt cannot double what the first one stored.
     */
    internal const val POST_ATTEMPTS = 4

    /** How long the first wait between two attempts is, doubling up to [MAX_RETRY_DELAY_MS]. */
    private const val INITIAL_RETRY_DELAY_MS = 500L

    /**
     * The ceiling on one wait. Four attempts at these delays spend at most seven and a half seconds
     * on a chunk that keeps failing - which a background sync can afford, and which is the price of
     * not losing what the chunk carried.
     */
    private const val MAX_RETRY_DELAY_MS = 4_000L

    data class Session(val server: String, val personId: String, val cookie: String)

    /**
     * What the sync says while it goes. One call per type that is switched on, in toggle order:
     * [typeStarted], then exactly one of [typeOk], [typeEmpty] or [typeFailed]. [typeEmpty] is
     * a finished read that found nothing to send, which is not a failure but must not read as
     * a send either, because a toggle with nothing in Health Connect and a toggle that never
     * ran are two different answers. [sessionExpired] ends the
     * whole sync instead of a type: the cookie is dead and every later type would answer 401.
     */
    interface Reporter {
        fun typeStarted(key: String)
        fun typeOk(key: String)
        fun typeEmpty(key: String)
        fun typeFailed(key: String, error: Throwable)
        fun sessionExpired()
    }

    fun isOn(prefs: SharedPreferences, key: String): Boolean =
        prefs.getBoolean("sync_$key", true)

    /**
     * A workout's GPS route, written out rather than derived from a record class.
     *
     * A route is not a record type of its own, so there is no `getReadPermission(X::class)` that
     * yields it, and connect-client 1.1.0 exposes no constant for it either. The PLATFORM does:
     * `android.health.connect.HealthPermissions.READ_EXERCISE_ROUTES` is a public constant on
     * android-36 with exactly this value, and a permission string is requestable whether or not
     * androidx happens to name it.
     *
     * DECLARED, never REQUESTED. The platform documents it as a permission an app cannot ask for:
     * "This permission can only be granted manually by a user in Health Connect settings or in the
     * route request activity [...] Attempts to request the permission by applications will be
     * ignored." (https://developer.android.com/reference/android/health/connect/HealthPermissions#READ_EXERCISE_ROUTES)
     * The Health Connect controller enforces it by dropping the string from every request
     * (RequestPermissionViewModel: `filterNot { it.toString() == HealthPermissions.READ_EXERCISE_ROUTES }`).
     *
     * Putting it in [readPermissions] is what made the permission button look dead. With every
     * other permission granted, the controller filtered this one out, found nothing left to ask,
     * and returned at once without drawing anything; the answer never contained it, so the screen
     * went on counting it as missing - "Still missing: 1" before the tap and after it, for ever.
     *
     * The declaration is still load-bearing: Health Connect's route request activity finishes
     * cancelled for a caller that does not declare it, and that activity's "Always allow" is the
     * one place this permission is granted from. See [declaredOnlyPermissions] and RouteLedger.
     *
     * An earlier reading of this concluded the permission could not be declared at all and left it
     * out, which shipped a route feature that could never receive a route.
     */
    const val READ_EXERCISE_ROUTES = "android.permission.health.READ_EXERCISE_ROUTES"

    /**
     * The permissions the manifest declares and [readPermissions] must not send: granted by the
     * household somewhere other than the request screen, so asking for them does nothing and
     * counting them as missing makes the screen promise a grant its button cannot deliver.
     */
    fun declaredOnlyPermissions(): Set<String> = setOf(
        // Granted from Health Connect's route request activity. See the constant.
        READ_EXERCISE_ROUTES,
    )

    /**
     * Every Health Connect permission this app requests, background included. One set, read by
     * the screen that asks and the worker that relies on the answer: a permission the set forgets
     * is a type the worker's reads are refused for, with no row on any screen saying so.
     *
     * Only what the request screen can actually grant belongs here, because this set is also the
     * screen's measure of "missing": one entry the controller refuses to ask for is enough to keep
     * the count above zero and the button looking broken. [declaredOnlyPermissions] holds the rest.
     */
    fun readPermissions(): Set<String> = setOf(
        HealthPermission.getReadPermission(StepsRecord::class),
        HealthPermission.getReadPermission(HeartRateRecord::class),
        HealthPermission.getReadPermission(WeightRecord::class),
        HealthPermission.getReadPermission(SleepSessionRecord::class),
        HealthPermission.getReadPermission(ExerciseSessionRecord::class),
        HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class),
        HealthPermission.getReadPermission(BasalMetabolicRateRecord::class),
        HealthPermission.getReadPermission(DistanceRecord::class),
        HealthPermission.getReadPermission(HeightRecord::class),
        HealthPermission.getReadPermission(BodyFatRecord::class),
        HealthPermission.getReadPermission(HeartRateVariabilityRmssdRecord::class),
        HealthPermission.getReadPermission(OxygenSaturationRecord::class),
        HealthPermission.getReadPermission(RespiratoryRateRecord::class),
        HealthPermission.getReadPermission(RestingHeartRateRecord::class),
        HealthPermission.getReadPermission(BodyTemperatureRecord::class),
        HealthPermission.getReadPermission(BloodGlucoseRecord::class),
        HealthPermission.getReadPermission(HydrationRecord::class),
        HealthPermission.getReadPermission(Vo2MaxRecord::class),
        HealthPermission.getReadPermission(ElevationGainedRecord::class),
        // Background sync: asked with the rest so the worker's reads are answered.
        HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND,
    )

    /**
     * Every switched-on type, in the screen's toggle order. A type that fails does not take the
     * rest of the sync with it: a body the instance refuses for one type says nothing about the
     * next. The session expiry is the one answer that concerns every type.
     */
    suspend fun syncAll(
        client: HealthConnectClient,
        session: Session,
        packageName: String,
        prefs: SharedPreferences,
        end: Instant,
        post: suspend (path: String, payload: String) -> InstanceClient.Outcome<Unit>,
        report: Reporter,
        // dataTypeId to the instance's last window end, already the minimum across that
        // type's own sources (SyncCursors.cursorEndsFor): a source that lags pulls the whole
        // type's read back to it. Empty on a first sync; a failed cursors fetch never reaches
        // here, the caller stops the run instead of reading every type in full.
        cursorEnds: Map<String, Long>,
        // dataTypeId to the moment the instance first took a record of that type under the
        // writing app's package (SyncCursors.Answer.cutovers). A type without one has nothing
        // filed the old way, so every record of it names its writer.
        cutovers: Map<String, Long>,
    ) {
        // Read, not remembered: the permission can be granted or revoked between two syncs, and
        // the window that is honest is the one the provider will actually answer right now.
        // It is the fallback every type keeps without a cursor, and the floor no delta may pass.
        val fallbackStart = readWindow(client, end)
        val owner = RouteLedger.ownerOf(session)
        for (key in SyncTypes.KEYS) {
            if (!isOn(prefs, key)) continue
            report.typeStarted(key)
            // The key is a toggle, the cursor and the token are filed under what the instance
            // files, so the lookup goes through the same knot.
            val dataTypeId = SyncTypes.forKey(key).dataTypeId
            // A throw becomes an outcome here so there is one path below rather than two.
            val outcome = runType {
                syncType(client, session, packageName, prefs, key, owner, cursorEnds[dataTypeId], fallbackStart, end, cutovers[dataTypeId], post)
            }
            when (outcome) {
                // The one answer that is not this type's business: the whole session is over.
                is InstanceClient.Outcome.Failed -> {
                    val error = outcome.error
                    if (error is InstanceClient.InstanceHttpException && error.status == 401) {
                        report.sessionExpired()
                        return
                    }
                    report.typeFailed(key, error)
                }
                // True sent something, false read cleanly and found nothing: the screen files
                // the two under different sentences, so a stale toggle cannot hide as sent.
                is InstanceClient.Outcome.Ok -> if (outcome.value) report.typeOk(key) else report.typeEmpty(key)
            }
        }
    }

    private suspend fun readWindow(client: HealthConnectClient, end: Instant): Instant =
        withContext(Dispatchers.IO) {
            val historyGranted = client.permissionController.getGrantedPermissions()
                .contains(HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY)
            SyncWindow.forHistoryGranted(historyGranted, end)
        }

    /**
     * Whatever the block threw - a Health Connect read, a socket - is this type's own failure.
     * A cancellation is not: a stopped worker must stop, not be counted as one failed type.
     */
    internal suspend fun runType(
        block: suspend () -> InstanceClient.Outcome<Boolean>,
    ): InstanceClient.Outcome<Boolean> = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        InstanceClient.Outcome.Failed(e)
    }

    /**
     * One type, from its Health Connect change feed when the token can be trusted and from a
     * window read otherwise (ChangeFeed.modeFor). The token is saved only once everything the
     * type read has landed: a failed type saves nothing, so the next run drains the same changes
     * again, which is safe because ingest upserts and a type posts its deletions after its upserts.
     * The token is saved beside the cursor this run started from, so a later run can tell the
     * instance went back behind it (ChangeFeed.modeFor).
     */
    private suspend fun syncType(
        client: HealthConnectClient,
        session: Session,
        packageName: String,
        prefs: SharedPreferences,
        key: String,
        owner: String,
        cursorEndMs: Long?,
        fallbackStart: Instant,
        end: Instant,
        cutoverMs: Long?,
        post: suspend (path: String, payload: String) -> InstanceClient.Outcome<Unit>,
    ): InstanceClient.Outcome<Boolean> {
        val dataTypeId = SyncTypes.forKey(key).dataTypeId
        var mode = ChangeFeed.modeFor(ChangeFeed.load(prefs, owner, dataTypeId), cursorEndMs, fallbackStart, end)
        if (mode is ChangeFeed.Mode.Drain) {
            val changes = ChangesSource(client, mode.token)
            val outcome = if (key == "resting") {
                val window = WindowSource(client, SyncCursors.bootstrapStartFor(cursorEndMs, fallbackStart, end), end)
                drainResting(session, packageName, prefs, changes, window, cutoverMs, post)
            } else {
                syncOne(session, packageName, prefs, key, changes, cutoverMs, post)
            }
            if (!changes.expired) {
                if (outcome is InstanceClient.Outcome.Ok) changes.nextToken?.let { ChangeFeed.save(prefs, owner, dataTypeId, it, cursorEndMs) }
                return outcome
            }
            // Pages read before the expiry may already have been sent. That is harmless: nothing
            // is saved, the type reads the permission's whole window next, and ingest upserts.
            if (outcome is InstanceClient.Outcome.Failed) return outcome
            ChangeFeed.clear(prefs, owner, dataTypeId)
            mode = ChangeFeed.fallbackAfterExpiry(fallbackStart)
        }
        val start = (mode as ChangeFeed.Mode.Bootstrap).start
        // Taken before the read, so a change made while the window is being read is in the
        // next drain rather than in neither.
        val fresh = withContext(Dispatchers.IO) {
            client.getChangesToken(ChangesTokenRequest(setOf(recordTypeOf(key))))
        }
        // Read up to a moment after the token, not to the run's end: the run's end was fixed
        // before the cursors call and every earlier type, and a record written since with a time
        // after it would otherwise fall before the token and outside the window both.
        val readEnd = maxOf(end, Instant.now())
        val outcome = syncOne(session, packageName, prefs, key, WindowSource(client, start, readEnd), cutoverMs, post)
        if (outcome is InstanceClient.Outcome.Ok) ChangeFeed.save(prefs, owner, dataTypeId, fresh, cursorEndMs)
        return outcome
    }

    /**
     * Resting heart rate from its change feed. A day's point is built from that day's latest
     * reading, so the changed records alone cannot rebuild it: a deleted latest reading leaves
     * an earlier one standing that the feed never mentions. So the feed only supplies the
     * deletions, which go first and take the day's row with them, and the days are then rebuilt
     * from a read of [window], which starts where a bootstrap would (SyncCursors.bootstrapStartFor):
     * thirty days back, the span a token can cover, or from the instance's older cursor, never
     * before what the permission answers.
     */
    private suspend fun drainResting(
        session: Session,
        packageName: String,
        prefs: SharedPreferences,
        changes: ChangesSource,
        window: BatchSource,
        cutoverMs: Long?,
        post: suspend (path: String, payload: String) -> InstanceClient.Outcome<Unit>,
    ): InstanceClient.Outcome<Boolean> {
        val deletions = collect(changes.batches(RestingHeartRateRecord::class)).deletions
        if (changes.expired) return InstanceClient.Outcome.Ok(false)
        val dataTypeId = SyncTypes.forKey("resting").dataTypeId
        val deleted = postDeletions(session, dataTypeId, deletions, post)
        if (deleted is InstanceClient.Outcome.Failed) return deleted
        val upserted = syncOne(session, packageName, prefs, "resting", window, cutoverMs, post)
        return if (upserted is InstanceClient.Outcome.Ok) InstanceClient.Outcome.Ok(upserted.value || deletions.isNotEmpty()) else upserted
    }

    /** The record class each toggle reads, which is also the class its change token is taken for. */
    internal fun recordTypeOf(key: String): KClass<out Record> = when (key) {
        "steps" -> StepsRecord::class
        "distance" -> DistanceRecord::class
        "elevation" -> ElevationGainedRecord::class
        "active_energy" -> ActiveCaloriesBurnedRecord::class
        "basal" -> BasalMetabolicRateRecord::class
        "exercise" -> ExerciseSessionRecord::class
        "sleep" -> SleepSessionRecord::class
        "weight" -> WeightRecord::class
        "height" -> HeightRecord::class
        "body_fat" -> BodyFatRecord::class
        "body_temp" -> BodyTemperatureRecord::class
        "glucose" -> BloodGlucoseRecord::class
        "hydration" -> HydrationRecord::class
        "heart_rate" -> HeartRateRecord::class
        "resting" -> RestingHeartRateRecord::class
        "hrv" -> HeartRateVariabilityRmssdRecord::class
        "spo2" -> OxygenSaturationRecord::class
        "breathing" -> RespiratoryRateRecord::class
        "vo2" -> Vo2MaxRecord::class
        else -> throw IllegalArgumentException("no sync for $key")
    }

    private suspend fun syncOne(
        session: Session,
        packageName: String,
        prefs: SharedPreferences,
        key: String,
        source: BatchSource,
        cutoverMs: Long?,
        post: suspend (path: String, payload: String) -> InstanceClient.Outcome<Unit>,
    ): InstanceClient.Outcome<Boolean> {
        // The key is a toggle, the id is what the instance files: SyncTypes.forKey is what
        // ties them, and its test keeps the knot tied.
        val dataTypeId = SyncTypes.forKey(key).dataTypeId
        when (key) {
            "basal" -> {
                // The device's own daily figure, sent as it was read rather than summed or
                // averaged here: see BasalMetabolicRate for the unit and the empty interval.
                // Mapped off the caller's thread like every other type: one point per day is
                // small today, and the rule should not depend on that staying true.
                val read = collect(source.batches(BasalMetabolicRateRecord::class))
                val points = withContext(Dispatchers.Default) {
                    read.records
                        .groupBy { identityOf(it, cutoverMs) }
                        .flatMap { (identity, records) ->
                            val readings = records.map {
                                BasalMetabolicRate.Reading(it.time, it.zoneOffset, it.basalMetabolicRate, it.metadata.id)
                            }
                            BasalMetabolicRate.points(readings).map { Point(identity, basalPoint(it)) }
                        }
                }
                val outcome = uploadPoints(session, packageName, "basal-energy-burned", points, post)
                return thenDeletions(outcome, session, "basal-energy-burned", read.deletions, post)
            }
            "resting" -> {
                // One point per reading, never the day's mean: see DailyRestingHeartRate. The
                // records are split by identity first, because a day whose later reading came
                // off another device is that device's reading and not this app's merge.
                val read = collect(source.batches(RestingHeartRateRecord::class))
                val points = withContext(Dispatchers.Default) {
                    read.records
                        .groupBy { identityOf(it, cutoverMs) }
                        .flatMap { (identity, records) ->
                            val readings = records.map {
                                DailyRestingHeartRate.Reading(it.time, it.zoneOffset, it.beatsPerMinute, it.metadata.id)
                            }
                            DailyRestingHeartRate.daily(readings).map {
                                Point(identity, dailyRestingPoint(it.date, it.beatsPerMinute.toString(), it.id))
                            }
                        }
                }
                val outcome = uploadPoints(session, packageName, "daily-resting-heart-rate", points, post)
                return thenDeletions(outcome, session, "daily-resting-heart-rate", read.deletions, post)
            }
            "steps" -> return uploadType(session, packageName, dataTypeId, source.batches(StepsRecord::class), cutoverMs, post) { toStepPoints(it) }
            "distance" -> return uploadType(session, packageName, dataTypeId, source.batches(DistanceRecord::class), cutoverMs, post) { toDistancePoints(it) }
            "elevation" -> return uploadType(session, packageName, dataTypeId, source.batches(ElevationGainedRecord::class), cutoverMs, post) { toAltitudePoints(it) }
            "active_energy" -> return uploadType(session, packageName, dataTypeId, source.batches(ActiveCaloriesBurnedRecord::class), cutoverMs, post) { toCaloriesPoints(it) }
            "exercise" -> {
                // The route ledger rides this type: which workouts' routes were withheld, so the
                // screen can offer to release them, and which were already delivered, so a read
                // that cannot see them (every background read, see RouteLedger) does not post a
                // routeless copy over the one the instance holds.
                val owner = RouteLedger.ownerOf(session)
                val delivered = RouteLedger.load(prefs, owner).sent
                val seen = mutableMapOf<String, RouteLedger.Seen>()
                val refused = mutableSetOf<String>()
                val outcome = uploadType(session, packageName, dataTypeId, source.batches(ExerciseSessionRecord::class), cutoverMs, post) { records ->
                    toExercisePoints(records.filter { record ->
                        val what = RouteLedger.seenOf(record.exerciseRouteResult)
                        RouteLedger.shouldPost(record.metadata.id, what, delivered)
                            .also { if (it) seen[record.metadata.id] = what else refused += record.metadata.id }
                    })
                }
                // Filed only once every chunk landed: a session marked delivered that never
                // arrived would be refused by shouldPost on every background run after it, and
                // its route would wait for a foreground read to be sent at all. A refused edit is
                // filed then too, since the token it hides behind is only saved on success.
                if (outcome is InstanceClient.Outcome.Ok) {
                    RouteLedger.record(prefs, owner, seen, RouteLedger.refusalsToFile(refused, drained = source is ChangesSource))
                }
                return outcome
            }
            "sleep" -> return uploadType(session, packageName, dataTypeId, source.batches(SleepSessionRecord::class), cutoverMs, post) { toSleepPoints(it) }
            "weight" -> return uploadType(session, packageName, dataTypeId, source.batches(WeightRecord::class), cutoverMs, post) { toWeightPoints(it) }
            "height" -> return uploadType(session, packageName, dataTypeId, source.batches(HeightRecord::class), cutoverMs, post) { toHeightPoints(it) }
            "body_fat" -> return uploadType(session, packageName, dataTypeId, source.batches(BodyFatRecord::class), cutoverMs, post) { toBodyFatPoints(it) }
            "body_temp" -> return uploadType(session, packageName, dataTypeId, source.batches(BodyTemperatureRecord::class), cutoverMs, post) { toBodyTempPoints(it) }
            "glucose" -> return uploadType(session, packageName, dataTypeId, source.batches(BloodGlucoseRecord::class), cutoverMs, post) { toBloodGlucosePoints(it) }
            "hydration" -> return uploadType(session, packageName, dataTypeId, source.batches(HydrationRecord::class), cutoverMs, post) { toHydrationPoints(it) }
            "heart_rate" -> return uploadType(session, packageName, dataTypeId, source.batches(HeartRateRecord::class), cutoverMs, post) { toHeartRatePoints(it) }
            "hrv" -> return uploadType(session, packageName, dataTypeId, source.batches(HeartRateVariabilityRmssdRecord::class), cutoverMs, post) { toHrvPoints(it) }
            "spo2" -> return uploadType(session, packageName, dataTypeId, source.batches(OxygenSaturationRecord::class), cutoverMs, post) { toSpo2Points(it) }
            "breathing" -> {
                // No intraday respiratory rate exists in the catalogue, so the night's own
                // summary is the only shape a reading arrives in. The day's mean was ours.
                return uploadType(session, packageName, dataTypeId, source.batches(RespiratoryRateRecord::class), cutoverMs, post) { toSleepRespPoints(it) }
            }
            "vo2" -> return uploadType(session, packageName, dataTypeId, source.batches(Vo2MaxRecord::class), cutoverMs, post) { toVo2Points(it) }
            // Louder than a dropped type: a toggle the engine cannot run is a mistake, not a skip.
            else -> throw IllegalArgumentException("no sync for $key")
        }
    }

    /**
     * Where one chunk ends, as exclusive end indexes over per-point byte costs (separator
     * included) and per-point instants. Pure integers rather than JSONObjects, because JSONObject
     * is a stub in a JVM unit test and the cut policy still needs pinning: it is what keeps a
     * phone's heap bounded while a type streams, and what keeps one refusal from reaching past
     * what the next sync will re-read.
     *
     * Two ceilings, whichever bites first. Bytes bound the request; [maxSpanMs] bounds the time it
     * covers, because a source that writes little never fills the byte budget and would otherwise
     * post its entire window as one chunk. The span is measured from the chunk's own first point,
     * not from a page or a day: this decides what travels together and nothing about what a
     * reading means, since the instance files every row by its own instant and offset.
     *
     * [maxPoints] bounds the count, because the instance refuses a request over its own point
     * ceiling and neither of the other two counts: dense small points fit tens of thousands
     * inside both. Counted as points held, not bytes used, so a cut lands between two readings
     * of the same hour and the pieces travel as consecutive requests, in order, none skipped.
     *
     * A single point over either ceiling still travels, alone: a record the provider answered with
     * cannot be split, and dropping it here would lose a reading the instance never got to refuse.
     *
     * With [alignToMinute], a cut a ceiling forces moves back to the latest minute boundary inside
     * the chunk, so no minute straddles two requests. Heart rate needs it: the instance
     * downsamples each upload's minutes on their own and upserts on the natural key, so a minute
     * split across two requests is overwritten by the aggregate of its second half. A chunk
     * holding no boundary (one minute larger than a ceiling) is cut at the ceiling as before.
     *
     * The times are expected in ascending order: the minute alignment and the span ceiling both
     * compare neighbouring points.
     */
    internal fun chunkEnds(
        sizes: List<Int>,
        maxBytes: Int,
        timesMs: List<Long?> = emptyList(),
        maxSpanMs: Long = Long.MAX_VALUE,
        maxPoints: Int = Int.MAX_VALUE,
        alignToMinute: Boolean = false,
    ): List<Int> {
        // The largest j in (start, i] where point j opens a new minute, or null.
        fun minuteBoundary(start: Int, i: Int): Int? {
            for (j in i downTo start + 1) {
                val before = timesMs.getOrNull(j - 1)
                val after = timesMs.getOrNull(j)
                if (before != null && after != null && Math.floorDiv(before, 60_000L) != Math.floorDiv(after, 60_000L)) return j
            }
            return null
        }
        val ends = mutableListOf<Int>()
        var start = 0
        var size = 0
        for (i in sizes.indices) {
            // A chunk holding points [start, i) is full: close it before this point, which
            // then opens the next one. A point whose own instant is unknown measures no span,
            // so a type the mappers give no clock for is bounded by bytes exactly as before.
            // A loop because an aligned cut leaves point i with a shorter chunk that may still be
            // over a ceiling; every pass moves start forward, so it ends.
            while (i > start) {
                val from = timesMs.getOrNull(start)
                val at = timesMs.getOrNull(i)
                val overBytes = size + sizes[i] > maxBytes
                val overSpan = from != null && at != null && at - from > maxSpanMs
                val overCount = i - start >= maxPoints
                if (!(overBytes || overSpan || overCount)) break
                val cut = (if (alignToMinute) minuteBoundary(start, i) else null) ?: i
                ends += cut
                size = (cut until i).sumOf { sizes[it] }
                start = cut
            }
            size += sizes[i]
        }
        if (start < sizes.size) ends += sizes.size
        return ends
    }

    /**
     * Adds [incoming] to one identity's [buffer], puts the buffer in time order, and takes every
     * chunk it now holds, each cut to its own bytes, to [MAX_CHUNK_SPAN_MS] and to
     * [MAX_CHUNK_POINTS]. None while the buffer still fits in one and should keep growing.
     *
     * Every chunk this hands back is closed by reaching a ceiling and never by running out of
     * points, which is the whole point: what stays in the buffer is what a refusal can leave
     * unposted, and a chunk closed by its own limit bounds that to one chunk's worth of time.
     * What is left after a cut is a fragment, and it grows into the next full chunk as the batches
     * arrive rather than being posted as it is.
     *
     * The order comes first because [chunkEnds] compares neighbours, and a drained change feed
     * lists records in the order they changed; one record's samples can also reach past the next
     * record's start. Generic over the point so a JVM test can run it without org.json.
     */
    internal fun <P> readyChunks(
        buffer: MutableList<P>,
        incoming: List<P>,
        alignToMinute: Boolean,
        sizeOf: (P) -> Int,
        timeOf: (P) -> Long?,
    ): List<List<P>> {
        buffer += incoming
        val ordered = inTimeOrder(buffer, timeOf)
        buffer.clear()
        buffer += ordered
        val out = mutableListOf<List<P>>()
        while (true) {
            val ends = chunkEnds(buffer.map(sizeOf), MAX_CHUNK_BYTES, buffer.map(timeOf), MAX_CHUNK_SPAN_MS, MAX_CHUNK_POINTS, alignToMinute)
            val end = flushEnd(ends) ?: break
            out += buffer.subList(0, end).toList()
            buffer.subList(0, end).clear()
        }
        return out
    }

    /**
     * Where a flush cuts a buffer: the end of the chunk that leaves now, or null while the buffer
     * holds no complete chunk and should keep growing.
     *
     * [ends] is [chunkEnds]' own answer, and its last element is always the buffer's own end,
     * because the buffer's remainder is what chunkEnds closes last. Every end before it therefore
     * closed a chunk at a ceiling, and the first of them is the first chunk the buffer holds.
     *
     * One per call, which the caller's loop repeats until this answers null. A buffer holding
     * several of them is the ordinary case and not an exotic one: a page is records, and one
     * heart rate record carries thousands of samples, so a single page can push the buffer past
     * two ceilings at once. Every one of those ends is a separate request, because that is what
     * a ceiling means; a flush that returned them together would hand one post a chunk over all
     * three ceilings at once, which is a request the instance refuses for its count.
     */
    internal fun flushEnd(ends: List<Int>): Int? = if (ends.size < 2) null else ends[0]

    /** Whatever a buffer still holds once the read is over: the tail, in time order and cut to the same ceilings. */
    internal fun <P> chunksInTimeOrder(
        points: List<P>,
        alignToMinute: Boolean,
        sizeOf: (P) -> Int,
        timeOf: (P) -> Long?,
    ): List<List<P>> {
        val ordered = inTimeOrder(points, timeOf)
        var from = 0
        return chunkEnds(ordered.map(sizeOf), MAX_CHUNK_BYTES, ordered.map(timeOf), MAX_CHUNK_SPAN_MS, MAX_CHUNK_POINTS, alignToMinute).map { end ->
            ordered.subList(from, end).toList().also { from = end }
        }
    }

    /** What one point costs a request: its JSON plus the separator before the next one. */
    private fun jsonBytes(point: JSONObject): Int = point.toString().toByteArray(Charsets.UTF_8).size + 1

    /**
     * The instant a mapped point carries, which is the clock [chunkEnds] measures a chunk's reach
     * with. Null for a point whose time cannot be read, which measures no span: an unreadable point
     * is one the instance will drop anyway (parse.ts drops a point with no instant), and inventing
     * a time for it would move a chunk boundary over a reading that does not exist.
     *
     * The three shapes are the ones the mappers write: a sample instant under `sampleTime`, an
     * interval under `interval`, and a daily point's civil `date`. The precedence is the server's
     * own (mapSamples.reads sampleTime first, then the interval), so the two sides agree on which
     * clock a point is filed under.
     */
    internal fun instantMsOf(body: JSONObject): Long? {
        // `name` rides beside the payload as the record id, so the payload is the first other key.
        val key = body.keys().asSequence().firstOrNull { it != "name" } ?: return null
        val payload = body.optJSONObject(key) ?: return null
        payload.optJSONObject("sampleTime")?.let { sample ->
            return instantMsOf(sample.optString("physicalTime"), sample.opt("utcOffset"))
        }
        payload.optJSONObject("interval")?.let { interval ->
            return instantMsOf(interval.optString("startTime"), interval.opt("startUtcOffset"))
        }
        payload.optJSONObject("date")?.let { date ->
            val year = date.optInt("year")
            val month = date.optInt("month")
            val day = date.optInt("day")
            if (year == 0 || month == 0 || day == 0) return null
            return LocalDate.of(year, month, day).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
        }
        return null
    }

    /**
     * A written instant plus the offset beside it, as the local instant it names. The offset is the
     * half that makes this a chunk boundary rather than an arbitrary one: two points either side of
     * midnight UTC can be minutes apart locally, and pairing the instant with its own offset is what
     * `WireTime` promises the server will read.
     *
     * Both spellings of the offset are accepted because the API carries both: this app writes
     * seconds ("7200s"), and the field map records a bare number in the provider's own answers.
     * A value with no `s` is already minutes, which is the unit the server's parse.ts reads it in.
     */
    private fun instantMsOf(iso: String, offset: Any?): Long? {
        val utcMs = try {
            Instant.parse(iso).toEpochMilli()
        } catch (e: Exception) {
            return null
        }
        val offsetSeconds = when (offset) {
            is String -> offset.removeSuffix("s").toLongOrNull()?.takeIf { offset.endsWith("s") }
                ?: offset.toLongOrNull()?.times(60)
            is Number -> offset.toLong() * 60
            else -> null
        }
        return utcMs + (offsetSeconds ?: 0L) * 1000L
    }

    /**
     * Every point of one read, filed under the identity its own record carried. One page can hold
     * a watch's readings, the phone's and somebody's typed-in ones, and each of those is a source
     * the instance keeps apart, so the split happens here and not inside a request.
     *
     * Streams the source's batches (a provider page, or a change feed page) instead of
     * materializing the window: a real watch writes heart-rate every few seconds, and 30 days of
     * that is hundreds of thousands of samples.
     * Mapping them all to JSONObjects at once exhausted the 256 MB heap on a real phone
     * (OOM on the main thread, after an ANR). One batch is mapped, buffered per identity
     * and posted as soon as its buffer reaches a ceiling, then forgotten. Chunk
     * boundaries move compared to one-shot batching; the rows do not, because the instance
     * upserts on the natural key.
     *
     * A chunk is bounded by bytes, by [MAX_CHUNK_SPAN_MS] and by [MAX_CHUNK_POINTS]; the third is
     * what keeps a dense hour postable at all: tens of thousands of small points fit inside the
     * other two and the instance refuses the request for their count. A refusal ends the type
     * with its change token unsaved, so the next run reads the same records again.
     *
     * The batches' deletions are posted after the tail flush, never before: a deletion that went
     * ahead of a still buffered upsert of the same record would be undone by it.
     */
    private suspend fun <T : Record> uploadType(
        session: Session,
        packageName: String,
        dataTypeId: String,
        next: suspend () -> Batch<T>?,
        cutoverMs: Long?,
        post: suspend (path: String, payload: String) -> InstanceClient.Outcome<Unit>,
        map: (List<T>) -> List<JSONObject>,
    ): InstanceClient.Outcome<Boolean> {
        val alignToMinute = dataTypeId in MINUTE_ALIGNED_TYPES
        val buffers = mutableMapOf<SourceIdentity, MutableList<JSONObject>>()
        var deletions = emptyList<String>()
        var sentAny = false
        while (true) {
            val batch = next() ?: break
            // Folded page by page in feed order, so a deletion an upsert on a later page undid
            // is not posted after that upsert.
            deletions = ChangeFeed.deletionsAfter(deletions, batch.changes)
            // CPU- and memory-bound: off the caller's thread, which is the screen's when the
            // button started this. Each identity's buffer is cut as soon as it reaches a ceiling,
            // so what leaves here is always a full chunk and never a fragment; the rest stays
            // buffered for the next batch.
            val ready: List<Pair<SourceIdentity, List<JSONObject>>> = withContext(Dispatchers.Default) {
                val out = mutableListOf<Pair<SourceIdentity, List<JSONObject>>>()
                val page = batch.records.groupBy { identityOf(it, cutoverMs) }
                    .flatMap { (identity, records) -> map(records).map { Point(identity, it) } }
                if (page.isNotEmpty()) sentAny = true
                for ((identity, bodies) in page.groupBy({ it.source }, { it.body })) {
                    val buffer = buffers.getOrPut(identity) { mutableListOf() }
                    readyChunks(buffer, bodies, alignToMinute, { jsonBytes(it) }, { instantMsOf(it) })
                        .forEach { out += identity to it }
                }
                out
            }
            for ((identity, chunk) in ready) {
                val outcome = postChunk(session, packageName, dataTypeId, identity, chunk, post)
                // The first refusal stops this type: the chunks after it would carry the same
                // answer, and a caller that kept going would only be slower at saying so.
                if (outcome is InstanceClient.Outcome.Failed) return outcome
            }
        }
        val tail: List<Pair<SourceIdentity, List<JSONObject>>> = withContext(Dispatchers.Default) {
            buffers.flatMap { (identity, buffer) ->
                if (buffer.isEmpty()) emptyList() else chunksInTimeOrder(buffer, alignToMinute, { jsonBytes(it) }, { instantMsOf(it) }).map { identity to it }
            }
        }
        for ((identity, chunk) in tail) {
            val outcome = postChunk(session, packageName, dataTypeId, identity, chunk, post)
            if (outcome is InstanceClient.Outcome.Failed) return outcome
        }
        return thenDeletions(InstanceClient.Outcome.Ok(sentAny), session, dataTypeId, deletions, post)
    }

    /**
     * Where each point goes when a buffer is put in time order: indexes into [timesMs], ascending
     * by instant, ties kept in the order they came, and an unreadable instant last. Pure over the
     * instants so a JVM test can pin it; [chunkEnds] assumes its input is in this order.
     */
    internal fun ascendingOrder(timesMs: List<Long?>): List<Int> =
        timesMs.indices.sortedWith(compareBy(nullsLast()) { timesMs[it] })

    private fun <P> inTimeOrder(points: List<P>, timeOf: (P) -> Long?): List<P> =
        ascendingOrder(points.map(timeOf)).map { points[it] }

    /** How many record ids one deletions request carries: ten below the route's MAX_DELETIONS. */
    internal const val MAX_DELETIONS_PER_REQUEST = 990

    /** The deletions request bodies for [ids], in order, none for an empty list. */
    internal fun deletionPayloads(ids: List<String>): List<String> =
        ids.chunked(MAX_DELETIONS_PER_REQUEST).map { JSONObject().put("recordIds", JSONArray(it)).toString() }

    /** Posts a type's deletions once its upserts landed, and answers whether the type sent anything. */
    private suspend fun thenDeletions(
        upserted: InstanceClient.Outcome<Boolean>,
        session: Session,
        dataTypeId: String,
        deletions: List<String>,
        post: suspend (path: String, payload: String) -> InstanceClient.Outcome<Unit>,
    ): InstanceClient.Outcome<Boolean> {
        if (upserted !is InstanceClient.Outcome.Ok) return upserted
        val deleted = postDeletions(session, dataTypeId, deletions, post)
        if (deleted is InstanceClient.Outcome.Failed) return deleted
        return InstanceClient.Outcome.Ok(upserted.value || deletions.isNotEmpty())
    }

    /**
     * The record ids Health Connect reported deleted, through the same retry as a chunk; the first
     * refusal ends the type. The instance must ship the deletions route before a phone calls it:
     * an older instance answers 404, which fails the type like any other refusal and leaves its
     * token unsaved.
     */
    private suspend fun postDeletions(
        session: Session,
        dataTypeId: String,
        ids: List<String>,
        post: suspend (path: String, payload: String) -> InstanceClient.Outcome<Unit>,
    ): InstanceClient.Outcome<Unit> {
        for (payload in deletionPayloads(ids)) {
            val outcome = withContext(Dispatchers.IO) {
                postWithRetry(POST_ATTEMPTS, { delayMs -> delay(delayMs) }) {
                    post("/api/v1/p/${session.personId}/ingest/$dataTypeId/deletions", payload)
                }
            }
            if (outcome is InstanceClient.Outcome.Failed) return outcome
        }
        return InstanceClient.Outcome.Ok(Unit)
    }

    /**
     * One request: one identity's chunk under one dataSource, attempted [POST_ATTEMPTS] times while
     * the instance's answer is one that a second attempt could change.
     *
     * The post itself stays on IO, and so does the wait between attempts.
     */
    private suspend fun postChunk(
        session: Session,
        packageName: String,
        dataTypeId: String,
        identity: SourceIdentity,
        chunk: List<JSONObject>,
        post: suspend (path: String, payload: String) -> InstanceClient.Outcome<Unit>,
    ): InstanceClient.Outcome<Unit> {
        val payload = JSONObject()
            .put("dataPoints", JSONArray(chunk))
            .put("dataSource", dataSourceOf(identity, packageName))
            .toString()
        return withContext(Dispatchers.IO) {
            postWithRetry(POST_ATTEMPTS, { delayMs -> delay(delayMs) }) {
                post("/api/v1/p/${session.personId}/ingest/$dataTypeId", payload)
            }
        }
    }

    /**
     * Whether a refusal is worth asking again, which is the same rule the instance's own sync
     * applies to Google (`packages/core/src/errors.ts`): a 429 or a 5xx is weather, and every other
     * status is an answer that a repeat would receive unchanged.
     *
     * A status this app cannot see - a socket that timed out, a connection refused, a truncated
     * body - carries no claim about the request, so it is worth asking again too. That is the case
     * the budget is really for: the phone changing networks under a sync.
     *
     * 401 is deliberately not on this list even though it is a status: it means the session is
     * over, and retrying it would only hammer the instance with a cookie it has already rejected.
     * syncAll reads the same 401 to end the whole sync and open the login screen, which it can only
     * do if this returns it rather than sleeping on it.
     */
    internal fun isWorthRetrying(outcome: InstanceClient.Outcome<*>): Boolean = when (outcome) {
        is InstanceClient.Outcome.Ok -> false
        is InstanceClient.Outcome.Failed -> when (val error = outcome.error) {
            is InstanceClient.InstanceHttpException -> error.status == 429 || error.status >= 500
            else -> true
        }
    }

    /**
     * One request, attempted until it is answered or the attempts run out, with the wait doubling
     * after each failure so a refusing instance is not hammered in lockstep.
     *
     * The wait is a parameter rather than a call to `delay` so a JVM test can run the policy to its
     * end without spending its budget in real time. It is not an abstraction for its own sake: the
     * decision worth pinning is which failures are asked again and how many times, and neither of
     * those needs a clock.
     */
    internal suspend fun <T> postWithRetry(
        attempts: Int,
        sleep: suspend (Long) -> Unit,
        body: suspend () -> InstanceClient.Outcome<T>,
    ): InstanceClient.Outcome<T> {
        var delayMs = INITIAL_RETRY_DELAY_MS
        var last: InstanceClient.Outcome<T> = body()
        for (attempt in 2..attempts) {
            if (!isWorthRetrying(last)) return last
            sleep(delayMs)
            delayMs = (delayMs * 2).coerceAtMost(MAX_RETRY_DELAY_MS)
            last = body()
        }
        return last
    }

    /**
     * A mapped point and the identity its own record carried. A request names one source
     * (ingest.ts:59), so this is the last thing a sync groups by before it sends, and a point's
     * own dataSource is deliberately not part of the body: the instance ignores it.
     */
    private class Point(val source: SourceIdentity, val body: JSONObject)

    private suspend fun uploadPoints(
        session: Session,
        packageName: String,
        dataTypeId: String,
        points: List<Point>,
        post: suspend (path: String, payload: String) -> InstanceClient.Outcome<Unit>,
    ): InstanceClient.Outcome<Boolean> {
        // Tripwire, not bookkeeping: a request naming a type the table does not declare has
        // no source the app can point at, so it stops here instead of reaching the instance.
        SyncTypes.declared(dataTypeId)
        // An empty read finished cleanly and found nothing: false tells the caller to file it
        // as no data rather than as a send, so the two stop sharing one mark.
        if (points.isEmpty()) return InstanceClient.Outcome.Ok(false)
        // One request carries one dataSource, so a page mixing a watch's readings, the phone's
        // and somebody's typed-in ones is several requests rather than one. Before this split the
        // whole page travelled under a single identity, which is why a hand-typed weight was
        // filed as the scale's and could not be excluded.
        for ((identity, group) in points.groupBy { it.source }) {
            // The endpoint refuses more than 10000 points: chunks are capped by bytes, by span
            // and by count, and every piece of one hour is posted here in order, none skipped -
            // a cut changes how many requests the hour travels in, never which readings travel.
            for (chunk in chunksInTimeOrder(group.map { it.body }, dataTypeId in MINUTE_ALIGNED_TYPES, { jsonBytes(it) }, { instantMsOf(it) })) {
                val outcome = postChunk(session, packageName, dataTypeId, identity, chunk, post)
                // The first refusal stops this type: the chunks after it would carry the same
                // answer, and a caller that kept going would only be slower at saying so.
                if (outcome is InstanceClient.Outcome.Failed) return outcome
            }
        }
        return InstanceClient.Outcome.Ok(true)
    }

    /** Every batch [next] answers, as one: for the types whose points need the whole read at once. */
    private suspend fun <T : Record> collect(next: suspend () -> Batch<T>?): Collected<T> {
        val records = mutableListOf<T>()
        var deletions = emptyList<String>()
        while (true) {
            val batch = next() ?: break
            records += batch.records
            deletions = ChangeFeed.deletionsAfter(deletions, batch.changes)
        }
        return Collected(records, deletions)
    }

    /** A whole read: its records and the record ids still deleted at its end. */
    private class Collected<T : Record>(val records: List<T>, val deletions: List<String>)

    /**
     * Records to upsert, as one source hands them over, and the feed's changes in feed order,
     * which ChangeFeed.deletionsAfter folds into the record ids to delete.
     */
    internal class Batch<T : Record>(val records: List<T>, val changes: List<ChangeFeed.Change>)

    /** Where a type's records come from: a window read or a change feed. */
    internal interface BatchSource {
        /** The batches of [type], one per call, null once there are no more. */
        fun <T : Record> batches(type: KClass<T>): suspend () -> Batch<T>?
    }

    /** Every record in [start, end), a provider page per batch, never a deletion. */
    private class WindowSource(
        private val client: HealthConnectClient,
        private val start: Instant,
        private val end: Instant,
    ) : BatchSource {
        override fun <T : Record> batches(type: KClass<T>): suspend () -> Batch<T>? {
            var pageToken: String? = null
            var done = false
            return {
                if (done) {
                    null
                } else {
                    val response = withContext(Dispatchers.IO) {
                        client.readRecords(
                            ReadRecordsRequest(
                                recordType = type,
                                timeRangeFilter = TimeRangeFilter.between(start, end),
                                // Written out although it is connect-client's own default
                                // (ReadRecordsRequest, `ascendingOrder: Boolean = true`): the cut
                                // policy measures a chunk's reach from its first point to its last.
                                // uploadType orders each buffer too; pages already in order keep
                                // that a no-op.
                                ascendingOrder = true,
                                pageToken = pageToken,
                            ),
                        )
                    }
                    pageToken = response.pageToken
                    done = pageToken == null
                    Batch(response.records, emptyList())
                }
            }
        }
    }

    /**
     * The changes since [token], one batch per getChanges page: that page's records of the type,
     * sorted by start, and every change on the page in feed order, which decides which deletions
     * stand. A feed lists records in the order they changed, and uploadType orders each
     * identity's buffer across batches as well. [nextToken] is set after
     * the last page and is the token to save once the type landed. A token Health Connect no
     * longer honours sets [expired] and ends the feed.
     */
    private class ChangesSource(private val client: HealthConnectClient, private val token: String) : BatchSource {
        var nextToken: String? = null
            private set
        var expired: Boolean = false
            private set

        override fun <T : Record> batches(type: KClass<T>): suspend () -> Batch<T>? {
            var current = token
            var done = false
            return {
                if (done) {
                    null
                } else {
                    val response = withContext(Dispatchers.IO) { client.getChanges(current) }
                    if (response.changesTokenExpired) {
                        expired = true
                        done = true
                        null
                    } else {
                        val records = mutableListOf<T>()
                        val changes = mutableListOf<ChangeFeed.Change>()
                        for (change in response.changes) {
                            when (change) {
                                is UpsertionChange -> {
                                    if (type.java.isInstance(change.record)) records += type.java.cast(change.record)!!
                                    changes += ChangeFeed.Change(change.record.metadata.id, deleted = false)
                                }
                                is DeletionChange -> changes += ChangeFeed.Change(change.recordId, deleted = true)
                            }
                        }
                        current = response.nextChangesToken
                        if (!response.hasMore) {
                            done = true
                            nextToken = current
                        }
                        Batch(records.sortedBy { startOf(it) }, changes)
                    }
                }
            }
        }
    }

    // ---- Mapping to the Google Health API v4 shapes haelan's mappers read ----

    /**
     * The identity a record carries, read off its own metadata rather than assumed. This is what
     * makes a watch's reading the watch's source and a typed-in one a source somebody can
     * exclude; see SourceIdentity for what each field decides on the instance. The writing app's
     * package is part of it for records starting at or after [cutoverMs]; earlier ones keep the
     * device-only identity they were already filed under.
     */
    private fun identityOf(record: Record, cutoverMs: Long?): SourceIdentity {
        val md = record.metadata
        return SourceIdentity.of(
            md.device?.manufacturer, md.device?.model, md.recordingMethod,
            md.dataOrigin.packageName, startOf(record).toEpochMilli(), cutoverMs,
        )
    }

    /** The instant a record starts, which is what the cutover is compared with. */
    internal fun startOf(record: Record): Instant = when (record) {
        is StepsRecord -> record.startTime
        is DistanceRecord -> record.startTime
        is ElevationGainedRecord -> record.startTime
        is ActiveCaloriesBurnedRecord -> record.startTime
        is ExerciseSessionRecord -> record.startTime
        is SleepSessionRecord -> record.startTime
        is HydrationRecord -> record.startTime
        is HeartRateRecord -> record.startTime
        is BasalMetabolicRateRecord -> record.time
        is RestingHeartRateRecord -> record.time
        is WeightRecord -> record.time
        is HeightRecord -> record.time
        is BodyFatRecord -> record.time
        is BodyTemperatureRecord -> record.time
        is BloodGlucoseRecord -> record.time
        is HeartRateVariabilityRmssdRecord -> record.time
        is OxygenSaturationRecord -> record.time
        is RespiratoryRateRecord -> record.time
        is Vo2MaxRecord -> record.time
        // A type added to the sync without a start here would silently file under the wrong
        // identity, so it fails loudly instead.
        else -> throw IllegalArgumentException("${record::class.simpleName} has no start time mapped")
    }

    /**
     * The dataSource one request carries. An identity with an origin package names the app that
     * wrote the record and marks itself origin scoped, so the instance files it under that app.
     * Without one (a record from before the cutover) it names the same source id it always did:
     * this install's own package, read rather than written down because a review build installs
     * under its own id and a source naming the release package would file a reviewer's push under
     * the app somebody actually paired. That object ends with `originScoped: false`, which the
     * source id ignores and the instance reads as "an upgraded phone's old identity", so these
     * posts never move the cutover the way a 0.1.0 phone's would.
     */
    internal fun dataSourceOf(identity: SourceIdentity, packageName: String): JSONObject = JSONObject()
        .put("platform", "HEALTH_CONNECT")
        .put("application", JSONObject().put("packageName", identity.originPackage ?: packageName))
        .apply { if (identity.originPackage != null) put("originScoped", true) }
        // Both omitted rather than blank when the record carries neither: an absent device is
        // what makes the package name the identity, and an unstated method is not a claim.
        .apply { identity.deviceName?.let { put("device", JSONObject().put("displayName", it)) } }
        .apply { identity.recordingMethod?.let { put("recordingMethod", it) } }
        .apply { if (identity.originPackage == null) put("originScoped", false) }

    private fun toStepPoints(records: List<StepsRecord>): List<JSONObject> = records.map { record ->
        JSONObject()
            .put("name", record.metadata.id)
            .put("steps", JSONObject()
                .put("interval", JSONObject()
                    .put("startTime", WireTime.atOffset(record.startTime, record.startZoneOffset))
                    .put("startUtcOffset", WireTime.offsetSeconds(record.startZoneOffset))
                    .put("endTime", WireTime.atOffset(record.endTime, record.endZoneOffset))
                    .put("endUtcOffset", WireTime.offsetSeconds(record.endZoneOffset)))
                .put("count", record.count))
    }

    internal fun toHeartRatePoints(records: List<HeartRateRecord>): List<JSONObject> =
        records.flatMap { record ->
            record.samples.map { sample ->
                JSONObject()
                    .put("name", record.metadata.id)
                    .put("heartRate", JSONObject()
                        .put("sampleTime", JSONObject()
                            .put("physicalTime", sample.time.toString())
                            .put("utcOffset", WireTime.offsetSeconds(record.startZoneOffset)))
                        .put("beatsPerMinute", sample.beatsPerMinute))
            }
        }

    internal fun toWeightPoints(records: List<WeightRecord>): List<JSONObject> = records.map { record ->
        val grams = Math.round(record.weight.inKilograms * 1000.0)
        JSONObject()
            .put("name", record.metadata.id)
            .put("weight", JSONObject()
                .put("sampleTime", JSONObject()
                    .put("physicalTime", record.time.toString())
                    .put("utcOffset", WireTime.offsetSeconds(record.zoneOffset)))
                .put("weightGrams", grams.toString()))
    }

    private fun toDistancePoints(records: List<DistanceRecord>): List<JSONObject> = records.map { record ->
        JSONObject()
            .put("name", record.metadata.id)
            .put("distance", JSONObject()
                .put("interval", JSONObject()
                    .put("startTime", WireTime.atOffset(record.startTime, record.startZoneOffset))
                    .put("startUtcOffset", WireTime.offsetSeconds(record.startZoneOffset))
                    .put("endTime", WireTime.atOffset(record.endTime, record.endZoneOffset))
                    .put("endUtcOffset", WireTime.offsetSeconds(record.endZoneOffset)))
                .put("millimeters", Math.round(record.distance.inMeters * 1000.0)))
    }

    private fun toAltitudePoints(records: List<ElevationGainedRecord>): List<JSONObject> = records.map { record ->
        JSONObject()
            .put("name", record.metadata.id)
            .put("altitude", JSONObject()
                .put("interval", JSONObject()
                    .put("startTime", WireTime.atOffset(record.startTime, record.startZoneOffset))
                    .put("startUtcOffset", WireTime.offsetSeconds(record.startZoneOffset))
                    .put("endTime", WireTime.atOffset(record.endTime, record.endZoneOffset))
                    .put("endUtcOffset", WireTime.offsetSeconds(record.endZoneOffset)))
                .put("gainMillimeters", Math.round(record.elevation.inMeters * 1000.0).toString()))
    }

    private fun toHeightPoints(records: List<HeightRecord>): List<JSONObject> = records.map { record ->
        JSONObject()
            .put("name", record.metadata.id)
            .put("height", JSONObject()
                .put("sampleTime", JSONObject()
                    .put("physicalTime", record.time.toString())
                    .put("utcOffset", WireTime.offsetSeconds(record.zoneOffset)))
                .put("heightMillimeters", Math.round(record.height.inMeters * 1000.0).toString()))
    }

    private fun toBodyFatPoints(records: List<BodyFatRecord>): List<JSONObject> = records.map { record ->
        JSONObject()
            .put("name", record.metadata.id)
            .put("bodyFat", JSONObject()
                .put("sampleTime", JSONObject()
                    .put("physicalTime", record.time.toString())
                    .put("utcOffset", WireTime.offsetSeconds(record.zoneOffset)))
                .put("percentage", record.percentage.value))
    }

    private fun toHrvPoints(records: List<HeartRateVariabilityRmssdRecord>): List<JSONObject> = records.map { record ->
        JSONObject()
            .put("name", record.metadata.id)
            .put("heartRateVariability", JSONObject()
                .put("sampleTime", JSONObject()
                    .put("physicalTime", record.time.toString())
                    .put("utcOffset", WireTime.offsetSeconds(record.zoneOffset)))
                .put("rootMeanSquareOfSuccessiveDifferencesMilliseconds", record.heartRateVariabilityMillis))
    }

    private fun toSpo2Points(records: List<OxygenSaturationRecord>): List<JSONObject> = records.map { record ->
        JSONObject()
            .put("name", record.metadata.id)
            .put("oxygenSaturation", JSONObject()
                .put("sampleTime", JSONObject()
                    .put("physicalTime", record.time.toString())
                    .put("utcOffset", WireTime.offsetSeconds(record.zoneOffset)))
                .put("percentage", record.percentage.value))
    }

    private fun toBodyTempPoints(records: List<BodyTemperatureRecord>): List<JSONObject> = records.map { record ->
        JSONObject()
            .put("name", record.metadata.id)
            .put("coreBodyTemperature", JSONObject()
                .put("sampleTime", JSONObject()
                    .put("physicalTime", record.time.toString())
                    .put("utcOffset", WireTime.offsetSeconds(record.zoneOffset)))
                .put("temperatureCelsius", record.temperature.inCelsius))
    }

    private fun toBloodGlucosePoints(records: List<BloodGlucoseRecord>): List<JSONObject> = records.map { record ->
        JSONObject()
            .put("name", record.metadata.id)
            .put("bloodGlucose", JSONObject()
                .put("sampleTime", JSONObject()
                    .put("physicalTime", record.time.toString())
                    .put("utcOffset", WireTime.offsetSeconds(record.zoneOffset)))
                .put("bloodGlucoseMilligramsPerDeciliter", record.level.inMilligramsPerDeciliter))
    }

    private fun toHydrationPoints(records: List<HydrationRecord>): List<JSONObject> = records.map { record ->
        JSONObject()
            .put("name", record.metadata.id)
            .put("hydrationLog", JSONObject()
                .put("interval", JSONObject()
                    .put("startTime", WireTime.atOffset(record.startTime, record.startZoneOffset))
                    .put("startUtcOffset", WireTime.offsetSeconds(record.startZoneOffset))
                    .put("endTime", WireTime.atOffset(record.endTime, record.endZoneOffset))
                    .put("endUtcOffset", WireTime.offsetSeconds(record.endZoneOffset)))
                .put("amountConsumed", JSONObject().put("milliliters", record.volume.inMilliliters)))
    }

    private fun toVo2Points(records: List<Vo2MaxRecord>): List<JSONObject> = records.map { record ->
        JSONObject()
            .put("name", record.metadata.id)
            .put("vo2Max", JSONObject()
                .put("sampleTime", JSONObject()
                    .put("physicalTime", record.time.toString())
                    .put("utcOffset", WireTime.offsetSeconds(record.zoneOffset)))
                .put("vo2Max", record.vo2MillilitersPerMinuteKilogram))
    }

    // The nightly breathing summary travels on the sleep type with fullSleepStats.
    private fun toSleepRespPoints(records: List<RespiratoryRateRecord>): List<JSONObject> = records.map { record ->
        JSONObject()
            .put("name", record.metadata.id)
            .put("respiratoryRateSleepSummary", JSONObject()
                .put("sampleTime", JSONObject()
                    .put("physicalTime", record.time.toString())
                    .put("utcOffset", WireTime.offsetSeconds(record.zoneOffset)))
                .put("fullSleepStats", JSONObject().put("breathsPerMinute", record.rate)))
    }

    private fun dateJson(date: LocalDate): JSONObject =
        JSONObject().put("year", date.year).put("month", date.monthValue).put("day", date.dayOfMonth)

    private fun dailyRestingPoint(date: LocalDate, beatsPerMinute: String, id: String): JSONObject =
        JSONObject()
            .put("name", id)
            .put("dailyRestingHeartRate", JSONObject()
                .put("date", dateJson(date))
                .put("beatsPerMinute", beatsPerMinute))

    // Health Connect knows no main sleep, so every uploaded night claims it. What that claim is
    // worth is measured on the instance side rather than assumed here: pickNight prefers the flag
    // only when exactly one group carries it, so with every session claiming it that branch can
    // only choose a day that has one group, which the longest-group fallback would have chosen
    // anyway (`packages/core/test/sleep-assembly.test.ts`, "falls back to the longest group when
    // two groups both claim the flag"). A phone's nights therefore assemble by gap, the same rule
    // Google's own sessions arrive under. A stage's offsets ride the session's own ends, and
    // SleepStages says what that gets right and what nothing downstream reads.
    private fun toSleepPoints(records: List<SleepSessionRecord>): List<JSONObject> =
        SleepStages.nights(records).map { night ->
            if (night.leftOutStages > 0) {
                // The one place a stage nobody can name leaves a trace: the caller's reasons go
                // to its own log, and a drop with no line at all is data lost in silence.
                Log.w(TAG, "sleep from ${night.startTime}: ${night.leftOutStages} stage(s) of a type v4 cannot name, left out")
            }
            JSONObject()
                // Health Connect's own record id, so a night the wearable revises in place
                // (a later sync moving its start a few minutes once the algorithm settles)
                // upserts the same session instead of arriving as a second one under a new
                // start-time key. A sibling of "sleep", not a field inside it: mapSessions.ts
                // reads `name` off the point itself (valueAt(point, 'name')), the same level
                // Google's own payloads carry it at, and never looks inside the payload for it.
                .put("name", night.id)
                .put("sleep", JSONObject()
                    .put("interval", JSONObject()
                        .put("startTime", WireTime.atOffset(night.startTime, night.startZoneOffset))
                        .put("startUtcOffset", WireTime.offsetSeconds(night.startZoneOffset))
                        .put("endTime", WireTime.atOffset(night.endTime, night.endZoneOffset))
                        .put("endUtcOffset", WireTime.offsetSeconds(night.endZoneOffset)))
                    .put("type", "STAGES")
                    .put("metadata", JSONObject()
                        .put("mainSleep", true)
                        .put("processed", true)
                        .put("stagesStatus", "SUCCEEDED"))
                    .put("stages", JSONArray(night.stages.map { stage ->
                        JSONObject()
                            .put("type", stage.name)
                            .put("startTime", WireTime.atOffset(stage.startTime, night.startZoneOffset))
                            .put("startUtcOffset", WireTime.offsetSeconds(night.startZoneOffset))
                            .put("endTime", WireTime.atOffset(stage.endTime, night.endZoneOffset))
                            .put("endUtcOffset", WireTime.offsetSeconds(night.endZoneOffset))
                    })))
        }

    // internal rather than private so its test can assert the shape at the level mapSessions.ts
    // reads it, the same reason chunkEnds and the other mappers' neighbours below are internal.
    internal fun toExercisePoints(records: List<ExerciseSessionRecord>): List<JSONObject> =
        records.map { exercisePoint(it, it.exerciseRouteResult) }

    /**
     * One exercise point, with the route taken from [routeResult] rather than from the record.
     *
     * The two differ in exactly one case: a route released through Health Connect's per-session
     * request. That route is handed to the activity that asked, as the contract's result, while
     * the record itself still reads `ConsentRequired` - so the release builds its point from the
     * record and the route it was given, and everything else about the point stays the one shape
     * a sync sends.
     */
    internal fun exercisePoint(record: ExerciseSessionRecord, routeResult: ExerciseRouteResult): JSONObject {
        val exercise = JSONObject()
            .put("interval", JSONObject()
                .put("startTime", WireTime.atOffset(record.startTime, record.startZoneOffset))
                .put("startUtcOffset", WireTime.offsetSeconds(record.startZoneOffset))
                .put("endTime", WireTime.atOffset(record.endTime, record.endZoneOffset))
                .put("endUtcOffset", WireTime.offsetSeconds(record.endZoneOffset)))
            .put("exerciseType", ExerciseTypes.nameFor(record.exerciseType))
        // A sibling on the exercise payload itself, per wire-shape.txt (the comment mapSessions.ts
        // carries, which is the only definition of this shape and the one this file builds
        // against): not a sibling of "exercise" on the point, not nested under interval or
        // exerciseType. routeJson answers null for every refusal shape, which folds the route in
        // only when there is one to send and leaves every other point exactly as it was before
        // this task touched it.
        routeJson(routeResult)?.let { exercise.put("route", it) }
        // Only when Health Connect is holding a route back. A workout that simply has none sends
        // nothing here, so the absence of this key keeps meaning what it already meant.
        if (routeConsentRequired(routeResult)) exercise.put("routeConsentRequired", true)
        return JSONObject()
            // Same reasoning as the sleep mapper just above, and the same sibling placement:
            // the record's own id survives a revised start instead of minting a second session
            // for it, and mapSessions.ts only reads `name` off the point, never off "exercise".
            .put("name", record.metadata.id)
            .put("exercise", exercise)
    }

    /**
     * Sends workouts whose routes the household just released, one point each, under the same
     * data type, identity and chunking a sync would have used. The instance keys a session on its
     * name, which is the record id, so each lands on the session a sync already filed and
     * replaces its routeless copy rather than adding a second workout beside it.
     *
     * The ledger is moved only for what landed: a release that did not arrive stays withheld, and
     * the screen goes on offering it.
     */
    suspend fun uploadReleased(
        session: Session,
        packageName: String,
        prefs: SharedPreferences,
        released: List<Pair<ExerciseSessionRecord, ExerciseRoute>>,
        cutoverMs: Long?,
        post: suspend (path: String, payload: String) -> InstanceClient.Outcome<Unit>,
    ): InstanceClient.Outcome<Boolean> {
        if (released.isEmpty()) return InstanceClient.Outcome.Ok(false)
        val points = withContext(Dispatchers.Default) {
            released.map { (record, route) ->
                Point(identityOf(record, cutoverMs), exercisePoint(record, ExerciseRouteResult.Data(route)))
            }
        }
        val outcome = uploadPoints(session, packageName, SyncTypes.forKey("exercise").dataTypeId, points, post)
        if (outcome is InstanceClient.Outcome.Ok) {
            RouteLedger.record(
                prefs,
                RouteLedger.ownerOf(session),
                released.associate { (record, route) -> record.metadata.id to RouteLedger.seenOf(ExerciseRouteResult.Data(route)) },
            )
        }
        return outcome
    }

    /**
     * The route inside one exercise point, or null when there is none to send.
     *
     * A session's route is reached through `ExerciseSessionRecord.exerciseRouteResult`, sealed to
     * `Data`, `ConsentRequired` and `NoData`. `Data` needs READ_EXERCISE_ROUTES, which the request
     * screen cannot grant (see the constant): the household grants it with "Always allow" in
     * Health Connect's route request activity, which the main screen opens through RouteLedger's
     * withheld list. Even then only a foreground read gets `Data` for another app's route; the
     * worker is answered `ConsentRequired` every time.
     *
     * `ConsentRequired` and `NoData` are still both read as nothing to send, the same way any
     * other type with nothing to send is read anywhere else in this file: a normal outcome, not a
     * refusal, and never a reason to fail the exercise type the way syncOne's first-refusal rule
     * would stop a post the instance actually refused.
     */
    // internal for the same reason toExercisePoints is: ExerciseRouteResult.ConsentRequired is
    // public and constructible, but the ExerciseSessionRecord constructor that would carry one is
    // Kotlin-internal to connect-client, so this is the only way a test reaches that branch at all.
    /**
     * Whether Health Connect is withholding a route rather than saying there is none.
     *
     * routeJson answers null for both, which is right for what gets sent and wrong for what gets
     * said about it. `NoData` is a workout with no route: an indoor session, or one nobody
     * recorded a track for, and there is nothing to tell the household. `ConsentRequired` is a
     * route that EXISTS and was not released, because the app that recorded it keeps its routes
     * behind Health Connect's own per-session consent - a separate system intent
     * (`android.health.connect.action.REQUEST_EXERCISE_ROUTE`) keyed on one session at a time,
     * which needs a foreground Activity this headless sync does not have.
     *
     * Those are opposite answers to "why is there no map", and collapsing them meant the page
     * could only stay silent. This carries the difference far enough for it to be said.
     */
    internal fun routeConsentRequired(result: ExerciseRouteResult): Boolean =
        result is ExerciseRouteResult.ConsentRequired

    internal fun routeJson(result: ExerciseRouteResult): JSONArray? {
        val points = (result as? ExerciseRouteResult.Data)?.exerciseRoute?.route ?: return null
        if (points.isEmpty()) return null
        return JSONArray(points.map { location ->
            JSONObject()
                .put("time", location.time.toString())
                .put("latitude", location.latitude)
                .put("longitude", location.longitude)
                // Independently optional, and never defaulted to a fabricated 0: Health Connect's
                // own Location leaves each of the three null when its provider did not carry it,
                // and put() is only called when there is a real reading to put.
                .apply { location.altitude?.let { put("altitudeMetres", it.inMeters) } }
                .apply { location.horizontalAccuracy?.let { put("horizontalAccuracyMetres", it.inMeters) } }
                .apply { location.verticalAccuracy?.let { put("verticalAccuracyMetres", it.inMeters) } }
        })
    }

    private fun toCaloriesPoints(records: List<ActiveCaloriesBurnedRecord>): List<JSONObject> = records.map { record ->
        JSONObject()
            .put("name", record.metadata.id)
            .put("activeEnergyBurned", JSONObject()
                .put("interval", JSONObject()
                    .put("startTime", WireTime.atOffset(record.startTime, record.startZoneOffset))
                    .put("startUtcOffset", WireTime.offsetSeconds(record.startZoneOffset))
                    .put("endTime", WireTime.atOffset(record.endTime, record.endZoneOffset))
                    .put("endUtcOffset", WireTime.offsetSeconds(record.endZoneOffset)))
                .put("kcal", record.energy.inKilocalories))
    }

    // v4 files this type by its interval while Health Connect's record is a single instant, so
    // the interval is empty and sits on the reading's own instant: no day boundary is invented
    // here, and the figure is the one Health Connect shows for the day the instant falls in.
    private fun basalPoint(point: BasalMetabolicRate.Point): JSONObject =
        JSONObject()
            .put("name", point.id)
            .put("basalEnergyBurned", JSONObject()
                .put("interval", JSONObject()
                    .put("startTime", WireTime.atOffset(point.time, point.zoneOffset))
                    .put("startUtcOffset", WireTime.offsetSeconds(point.zoneOffset))
                    .put("endTime", WireTime.atOffset(point.time, point.zoneOffset))
                    .put("endUtcOffset", WireTime.offsetSeconds(point.zoneOffset)))
                .put("kcal", point.kcal))
}
