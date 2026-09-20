package com.haelan.android

import android.content.SharedPreferences
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.BasalMetabolicRateRecord
import androidx.health.connect.client.records.BloodGlucoseRecord
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.BodyTemperatureRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ElevationGainedRecord
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
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
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
     * window. That is the shape that loses data. The instance answers one cursor per data type -
     * the newest end that landed, whichever source carried it - and the phone re-reads from that
     * cursor minus SyncCursors.OVERLAP_MS, so anything a refusal leaves unposted behind that
     * point is never asked for again. A window-sized chunk puts the whole window there.
     *
     * Twelve hours is half of SyncCursors.OVERLAP_MS, and half is the point: the worst a
     * refusal can leave unposted is one chunk, so half the overlap still covers it with the
     * other half to spare, rather than a single day balancing on the boundary.
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
     * Every Health Connect permission this app reads with, background included. One set, read by
     * the screen that asks and the worker that relies on the answer: a permission the set forgets
     * is a type the worker's reads are refused for, with no row on any screen saying so.
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
        // type's read back to it. Empty on a first sync or when the cursors fetch failed:
        // every type then keeps the full window instead of skipping.
        cursorEnds: Map<String, Long> = emptyMap(),
    ) {
        // Read, not remembered: the permission can be granted or revoked between two syncs, and
        // the window that is honest is the one the provider will actually answer right now.
        // It is the fallback every type keeps without a cursor, and the floor no delta may pass.
        val fallbackStart = readWindow(client, end)
        for (key in SyncTypes.KEYS) {
            if (!isOn(prefs, key)) continue
            report.typeStarted(key)
            // One window per type: a cursor means the delta back to it minus the overlap,
            // no cursor means the full fallback. The key is a toggle, the cursor is filed
            // under what the instance files, so the lookup goes through the same knot.
            val dataTypeId = SyncTypes.forKey(key).dataTypeId
            val start = SyncCursors.startFor(cursorEnds[dataTypeId], fallbackStart, end)
            // Null is a cursor ahead of the phone's own clock, not a failure: see
            // SyncCursors.startFor. There is nothing to read yet, so the type is reported
            // exactly as a read that found nothing would be, and Health Connect is never
            // asked for a range that ends where it starts.
            if (start == null) {
                report.typeEmpty(key)
                continue
            }
            // Whatever the block threw - a Health Connect read, a socket - is this type's own
            // failure, and becomes an outcome here so there is one path below rather than two.
            val outcome = try {
                syncOne(client, session, packageName, key, start, end, post)
            } catch (e: Exception) {
                InstanceClient.Outcome.Failed(e)
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

    private suspend fun syncOne(
        client: HealthConnectClient,
        session: Session,
        packageName: String,
        key: String,
        start: Instant,
        end: Instant,
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
                val points = withContext(Dispatchers.Default) {
                    readAll(client, BasalMetabolicRateRecord::class, start, end)
                        .groupBy { identityOf(it.metadata) }
                        .flatMap { (identity, records) ->
                            val readings = records.map {
                                BasalMetabolicRate.Reading(it.time, it.zoneOffset, it.basalMetabolicRate)
                            }
                            BasalMetabolicRate.points(readings).map { Point(identity, basalPoint(it)) }
                        }
                }
                return uploadPoints(session, packageName, "basal-energy-burned", points, post)
            }
            "resting" -> {
                // One point per reading, never the day's mean: see DailyRestingHeartRate. The
                // records are split by identity first, because a day whose later reading came
                // off another device is that device's reading and not this app's merge.
                val points = withContext(Dispatchers.Default) {
                    readAll(client, RestingHeartRateRecord::class, start, end)
                        .groupBy { identityOf(it.metadata) }
                        .flatMap { (identity, records) ->
                            val readings = records.map {
                                DailyRestingHeartRate.Reading(it.time, it.zoneOffset, it.beatsPerMinute)
                            }
                            DailyRestingHeartRate.daily(readings).map {
                                Point(identity, dailyRestingPoint(it.date, it.beatsPerMinute.toString()))
                            }
                        }
                }
                return uploadPoints(session, packageName, "daily-resting-heart-rate", points, post)
            }
            "steps" -> return uploadType(client, session, packageName, dataTypeId, StepsRecord::class, start, end, post) { toStepPoints(it) }
            "distance" -> return uploadType(client, session, packageName, dataTypeId, DistanceRecord::class, start, end, post) { toDistancePoints(it) }
            "elevation" -> return uploadType(client, session, packageName, dataTypeId, ElevationGainedRecord::class, start, end, post) { toAltitudePoints(it) }
            "active_energy" -> return uploadType(client, session, packageName, dataTypeId, ActiveCaloriesBurnedRecord::class, start, end, post) { toCaloriesPoints(it) }
            "exercise" -> return uploadType(client, session, packageName, dataTypeId, ExerciseSessionRecord::class, start, end, post) { toExercisePoints(it) }
            "sleep" -> return uploadType(client, session, packageName, dataTypeId, SleepSessionRecord::class, start, end, post) { toSleepPoints(it) }
            "weight" -> return uploadType(client, session, packageName, dataTypeId, WeightRecord::class, start, end, post) { toWeightPoints(it) }
            "height" -> return uploadType(client, session, packageName, dataTypeId, HeightRecord::class, start, end, post) { toHeightPoints(it) }
            "body_fat" -> return uploadType(client, session, packageName, dataTypeId, BodyFatRecord::class, start, end, post) { toBodyFatPoints(it) }
            "body_temp" -> return uploadType(client, session, packageName, dataTypeId, BodyTemperatureRecord::class, start, end, post) { toBodyTempPoints(it) }
            "glucose" -> return uploadType(client, session, packageName, dataTypeId, BloodGlucoseRecord::class, start, end, post) { toBloodGlucosePoints(it) }
            "hydration" -> return uploadType(client, session, packageName, dataTypeId, HydrationRecord::class, start, end, post) { toHydrationPoints(it) }
            "heart_rate" -> return uploadType(client, session, packageName, dataTypeId, HeartRateRecord::class, start, end, post) { toHeartRatePoints(it) }
            "hrv" -> return uploadType(client, session, packageName, dataTypeId, HeartRateVariabilityRmssdRecord::class, start, end, post) { toHrvPoints(it) }
            "spo2" -> return uploadType(client, session, packageName, dataTypeId, OxygenSaturationRecord::class, start, end, post) { toSpo2Points(it) }
            "breathing" -> {
                // No intraday respiratory rate exists in the catalogue, so the night's own
                // summary is the only shape a reading arrives in. The day's mean was ours.
                return uploadType(client, session, packageName, dataTypeId, RespiratoryRateRecord::class, start, end, post) { toSleepRespPoints(it) }
            }
            "vo2" -> return uploadType(client, session, packageName, dataTypeId, Vo2MaxRecord::class, start, end, post) { toVo2Points(it) }
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
     */
    internal fun chunkEnds(
        sizes: List<Int>,
        maxBytes: Int,
        timesMs: List<Long?> = emptyList(),
        maxSpanMs: Long = Long.MAX_VALUE,
        maxPoints: Int = Int.MAX_VALUE,
    ): List<Int> {
        val ends = mutableListOf<Int>()
        var start = 0
        var size = 0
        for (i in sizes.indices) {
            // A chunk holding points [start, i) is full: close it before this point, which
            // then opens the next one. A point whose own instant is unknown measures no span,
            // so a type the mappers give no clock for is bounded by bytes exactly as before.
            val from = timesMs.getOrNull(start)
            val at = timesMs.getOrNull(i)
            val overBytes = size + sizes[i] > maxBytes
            val overSpan = from != null && at != null && at - from > maxSpanMs
            val overCount = i - start >= maxPoints
            if (i > start && (overBytes || overSpan || overCount)) {
                ends += i
                start = i
                size = 0
            }
            size += sizes[i]
        }
        if (start < sizes.size) ends += sizes.size
        return ends
    }

    /**
     * The first chunk [points] holds, cut to its own bytes, to [MAX_CHUNK_SPAN_MS] and to
     * [MAX_CHUNK_POINTS], or null while they still fit in one and the buffer should keep
     * growing.
     *
     * Every chunk this hands back is closed by reaching a ceiling and never by running out of
     * points, which is the whole point: what stays in the buffer is what a refusal can leave
     * unposted, and a chunk closed by its own limit bounds that to one chunk's worth of time.
     * What is left after a cut is a fragment, and it grows into the next full chunk as the pages
     * arrive rather than being posted as it is.
     */
    private fun readyChunk(points: MutableList<JSONObject>): List<JSONObject>? {
        val sizes = points.map { it.toString().toByteArray(Charsets.UTF_8).size + 1 }
        val times = points.map { instantMsOf(it) }
        val ends = chunkEnds(sizes, MAX_CHUNK_BYTES, times, MAX_CHUNK_SPAN_MS, MAX_CHUNK_POINTS)
        val end = flushEnd(ends) ?: return null
        val ready = points.subList(0, end).toList()
        points.subList(0, end).clear()
        return ready
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

    /** Whatever the buffer still holds once the read is over: the tail, cut to the same ceilings. */
    private fun chunksBySize(points: List<JSONObject>): List<List<JSONObject>> {
        val sizes = points.map { it.toString().toByteArray(Charsets.UTF_8).size + 1 }
        val times = points.map { instantMsOf(it) }
        var from = 0
        return chunkEnds(sizes, MAX_CHUNK_BYTES, times, MAX_CHUNK_SPAN_MS, MAX_CHUNK_POINTS).map { end ->
            points.subList(from, end).toList().also { from = end }
        }
    }

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
    private fun instantMsOf(body: JSONObject): Long? {
        val key = body.keys().asSequence().firstOrNull() ?: return null
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
     * Streams provider pages instead of materializing the window: a real watch writes
     * heart-rate every few seconds, and 30 days of that is hundreds of thousands of samples.
     * Mapping them all to JSONObjects at once exhausted the 256 MB heap on a real phone
     * (OOM on the main thread, after an ANR). One page is mapped, buffered per identity
     * and posted as soon as its buffer reaches a ceiling, then forgotten. Chunk
     * boundaries move compared to one-shot batching; the rows do not, because the instance
     * upserts on the natural key.
     *
     * A chunk is bounded by bytes, by [MAX_CHUNK_SPAN_MS] and by [MAX_CHUNK_POINTS], and the
     * second one is what decides what a refusal costs while the third is what keeps a dense
     * hour postable at all: tens of thousands of small points fit inside the other two and
     * the instance refuses the request for their count. The instance's cursor is per data type - the newest end that landed,
     * whichever source carried it - and the next sync re-reads from it minus the overlap, so
     * whatever a refusal leaves unposted behind that point is never asked for again. Bounding a
     * chunk's reach bounds that loss to half the overlap, for every type including the ones that
     * write too little to ever fill the byte budget.
     */
    private suspend fun <T : Record> uploadType(
        client: HealthConnectClient,
        session: Session,
        packageName: String,
        dataTypeId: String,
        type: KClass<T>,
        start: Instant,
        end: Instant,
        post: suspend (path: String, payload: String) -> InstanceClient.Outcome<Unit>,
        map: (List<T>) -> List<JSONObject>,
    ): InstanceClient.Outcome<Boolean> {
        val buffers = mutableMapOf<SourceIdentity, MutableList<JSONObject>>()
        var sentAny = false
        var pageToken: String? = null
        do {
            val response = withContext(Dispatchers.IO) {
                client.readRecords(
                    ReadRecordsRequest(
                        recordType = type,
                        timeRangeFilter = TimeRangeFilter.between(start, end),
                        // Written out although it is connect-client's own default (ReadRecordsRequest,
                        // `ascendingOrder: Boolean = true`), because the cut policy below rests on it:
                        // a chunk's reach is its last point's instant minus its first point's, so pages
                        // that arrived out of order would measure a span that means nothing and the
                        // ceiling would stop bounding what a refusal leaves behind. A default is a
                        // promise the provider makes; this is the one promise this file depends on.
                        ascendingOrder = true,
                        pageToken = pageToken,
                    ),
                )
            }
            // CPU- and memory-bound: off the caller's thread, which is the screen's when the
            // button started this. Each identity's buffer is cut as soon as it reaches a ceiling,
            // so what leaves here is always a full chunk and never a fragment; the rest stays
            // buffered for the next page.
            val ready: List<Pair<SourceIdentity, List<JSONObject>>> = withContext(Dispatchers.Default) {
                val out = mutableListOf<Pair<SourceIdentity, List<JSONObject>>>()
                val page = response.records.groupBy { identityOf(it.metadata) }
                    .flatMap { (identity, records) -> map(records).map { Point(identity, it) } }
                if (page.isNotEmpty()) sentAny = true
                for ((identity, bodies) in page.groupBy({ it.source }, { it.body })) {
                    val buffer = buffers.getOrPut(identity) { mutableListOf() }
                    buffer += bodies
                    while (true) {
                        val chunk = readyChunk(buffer) ?: break
                        out += identity to chunk
                    }
                }
                out
            }
            for ((identity, chunk) in ready) {
                val outcome = postChunk(session, packageName, dataTypeId, identity, chunk, post)
                // The first refusal stops this type: the chunks after it would carry the same
                // answer, and a caller that kept going would only be slower at saying so.
                if (outcome is InstanceClient.Outcome.Failed) return outcome
            }
            pageToken = response.pageToken
        } while (pageToken != null)
        val tail: List<Pair<SourceIdentity, List<JSONObject>>> = withContext(Dispatchers.Default) {
            buffers.flatMap { (identity, buffer) ->
                if (buffer.isEmpty()) emptyList() else chunksBySize(buffer).map { identity to it }
            }
        }
        for ((identity, chunk) in tail) {
            val outcome = postChunk(session, packageName, dataTypeId, identity, chunk, post)
            if (outcome is InstanceClient.Outcome.Failed) return outcome
        }
        return InstanceClient.Outcome.Ok(sentAny)
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
            for (chunk in chunksBySize(group.map { it.body })) {
                val outcome = postChunk(session, packageName, dataTypeId, identity, chunk, post)
                // The first refusal stops this type: the chunks after it would carry the same
                // answer, and a caller that kept going would only be slower at saying so.
                if (outcome is InstanceClient.Outcome.Failed) return outcome
            }
        }
        return InstanceClient.Outcome.Ok(true)
    }

    private suspend fun <T : Record> readAll(
        client: HealthConnectClient,
        type: KClass<T>,
        start: Instant,
        end: Instant,
    ): List<T> {
        val out = mutableListOf<T>()
        var pageToken: String? = null
        do {
            val response = withContext(Dispatchers.IO) {
                client.readRecords(
                    ReadRecordsRequest(
                        recordType = type,
                        timeRangeFilter = TimeRangeFilter.between(start, end),
                        pageToken = pageToken,
                    ),
                )
            }
            out += response.records
            pageToken = response.pageToken
        } while (pageToken != null)
        return out
    }

    // ---- Mapping to the Google Health API v4 shapes haelan's mappers read ----

    /**
     * The identity a record carries, read off its own metadata rather than assumed. This is what
     * makes a watch's reading the watch's source and a typed-in one a source somebody can
     * exclude; see SourceIdentity for what each field decides on the instance.
     */
    private fun identityOf(metadata: Metadata): SourceIdentity =
        SourceIdentity.of(metadata.device?.manufacturer, metadata.device?.model, metadata.recordingMethod)

    /**
     * The dataSource one request carries. The package is read rather than written down: a review
     * build installs under its own id, and a source naming the release package would file
     * a reviewer's push under the app somebody actually paired.
     */
    private fun dataSourceOf(identity: SourceIdentity, packageName: String): JSONObject = JSONObject()
        .put("platform", "HEALTH_CONNECT")
        .put("application", JSONObject().put("packageName", packageName))
        // Both omitted rather than blank when the record carries neither: an absent device is
        // what makes the package name the identity, and an unstated method is not a claim.
        .apply { identity.deviceName?.let { put("device", JSONObject().put("displayName", it)) } }
        .apply { identity.recordingMethod?.let { put("recordingMethod", it) } }

    private fun toStepPoints(records: List<StepsRecord>): List<JSONObject> = records.map { record ->
        JSONObject()
            .put("steps", JSONObject()
                .put("interval", JSONObject()
                    .put("startTime", WireTime.atOffset(record.startTime, record.startZoneOffset))
                    .put("startUtcOffset", WireTime.offsetSeconds(record.startZoneOffset))
                    .put("endTime", WireTime.atOffset(record.endTime, record.endZoneOffset))
                    .put("endUtcOffset", WireTime.offsetSeconds(record.endZoneOffset)))
                .put("count", record.count))
    }

    private fun toHeartRatePoints(records: List<HeartRateRecord>): List<JSONObject> =
        records.flatMap { record ->
            record.samples.map { sample ->
                JSONObject()
                    .put("heartRate", JSONObject()
                        .put("sampleTime", JSONObject()
                            .put("physicalTime", sample.time.toString())
                            .put("utcOffset", WireTime.offsetSeconds(record.startZoneOffset)))
                        .put("beatsPerMinute", sample.beatsPerMinute))
            }
        }

    private fun toWeightPoints(records: List<WeightRecord>): List<JSONObject> = records.map { record ->
        val grams = Math.round(record.weight.inKilograms * 1000.0)
        JSONObject()
            .put("weight", JSONObject()
                .put("sampleTime", JSONObject()
                    .put("physicalTime", record.time.toString())
                    .put("utcOffset", WireTime.offsetSeconds(record.zoneOffset)))
                .put("weightGrams", grams.toString()))
    }

    private fun toDistancePoints(records: List<DistanceRecord>): List<JSONObject> = records.map { record ->
        JSONObject()
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
            .put("height", JSONObject()
                .put("sampleTime", JSONObject()
                    .put("physicalTime", record.time.toString())
                    .put("utcOffset", WireTime.offsetSeconds(record.zoneOffset)))
                .put("heightMillimeters", Math.round(record.height.inMeters * 1000.0).toString()))
    }

    private fun toBodyFatPoints(records: List<BodyFatRecord>): List<JSONObject> = records.map { record ->
        JSONObject()
            .put("bodyFat", JSONObject()
                .put("sampleTime", JSONObject()
                    .put("physicalTime", record.time.toString())
                    .put("utcOffset", WireTime.offsetSeconds(record.zoneOffset)))
                .put("percentage", record.percentage.value))
    }

    private fun toHrvPoints(records: List<HeartRateVariabilityRmssdRecord>): List<JSONObject> = records.map { record ->
        JSONObject()
            .put("heartRateVariability", JSONObject()
                .put("sampleTime", JSONObject()
                    .put("physicalTime", record.time.toString())
                    .put("utcOffset", WireTime.offsetSeconds(record.zoneOffset)))
                .put("rootMeanSquareOfSuccessiveDifferencesMilliseconds", record.heartRateVariabilityMillis))
    }

    private fun toSpo2Points(records: List<OxygenSaturationRecord>): List<JSONObject> = records.map { record ->
        JSONObject()
            .put("oxygenSaturation", JSONObject()
                .put("sampleTime", JSONObject()
                    .put("physicalTime", record.time.toString())
                    .put("utcOffset", WireTime.offsetSeconds(record.zoneOffset)))
                .put("percentage", record.percentage.value))
    }

    private fun toBodyTempPoints(records: List<BodyTemperatureRecord>): List<JSONObject> = records.map { record ->
        JSONObject()
            .put("coreBodyTemperature", JSONObject()
                .put("sampleTime", JSONObject()
                    .put("physicalTime", record.time.toString())
                    .put("utcOffset", WireTime.offsetSeconds(record.zoneOffset)))
                .put("temperatureCelsius", record.temperature.inCelsius))
    }

    private fun toBloodGlucosePoints(records: List<BloodGlucoseRecord>): List<JSONObject> = records.map { record ->
        JSONObject()
            .put("bloodGlucose", JSONObject()
                .put("sampleTime", JSONObject()
                    .put("physicalTime", record.time.toString())
                    .put("utcOffset", WireTime.offsetSeconds(record.zoneOffset)))
                .put("bloodGlucoseMilligramsPerDeciliter", record.level.inMilligramsPerDeciliter))
    }

    private fun toHydrationPoints(records: List<HydrationRecord>): List<JSONObject> = records.map { record ->
        JSONObject()
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
            .put("vo2Max", JSONObject()
                .put("sampleTime", JSONObject()
                    .put("physicalTime", record.time.toString())
                    .put("utcOffset", WireTime.offsetSeconds(record.zoneOffset)))
                .put("vo2Max", record.vo2MillilitersPerMinuteKilogram))
    }

    // The nightly breathing summary travels on the sleep type with fullSleepStats.
    private fun toSleepRespPoints(records: List<RespiratoryRateRecord>): List<JSONObject> = records.map { record ->
        JSONObject()
            .put("respiratoryRateSleepSummary", JSONObject()
                .put("sampleTime", JSONObject()
                    .put("physicalTime", record.time.toString())
                    .put("utcOffset", WireTime.offsetSeconds(record.zoneOffset)))
                .put("fullSleepStats", JSONObject().put("breathsPerMinute", record.rate)))
    }

    private fun dateJson(date: LocalDate): JSONObject =
        JSONObject().put("year", date.year).put("month", date.monthValue).put("day", date.dayOfMonth)

    private fun dailyRestingPoint(date: LocalDate, beatsPerMinute: String): JSONObject =
        JSONObject()
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
                    // Health Connect's own record id, so a night the wearable revises in place
                    // (a later sync moving its start a few minutes once the algorithm settles)
                    // upserts the same session instead of arriving as a second one under a new
                    // start-time key. mapSessions.ts prefers `name` over its start-time fallback.
                    .put("name", night.id)
                    .put("stages", JSONArray(night.stages.map { stage ->
                        JSONObject()
                            .put("type", stage.name)
                            .put("startTime", WireTime.atOffset(stage.startTime, night.startZoneOffset))
                            .put("startUtcOffset", WireTime.offsetSeconds(night.startZoneOffset))
                            .put("endTime", WireTime.atOffset(stage.endTime, night.endZoneOffset))
                            .put("endUtcOffset", WireTime.offsetSeconds(night.endZoneOffset))
                    })))
        }

    private fun toExercisePoints(records: List<ExerciseSessionRecord>): List<JSONObject> = records.map { record ->
        JSONObject()
            .put("exercise", JSONObject()
                .put("interval", JSONObject()
                    .put("startTime", WireTime.atOffset(record.startTime, record.startZoneOffset))
                    .put("startUtcOffset", WireTime.offsetSeconds(record.startZoneOffset))
                    .put("endTime", WireTime.atOffset(record.endTime, record.endZoneOffset))
                    .put("endUtcOffset", WireTime.offsetSeconds(record.endZoneOffset)))
                // Same reasoning as the sleep mapper just above: the record's own id survives a
                // revised start instead of minting a second session for it.
                .put("name", record.metadata.id)
                .put("exerciseType", ExerciseTypes.nameFor(record.exerciseType)))
    }

    private fun toCaloriesPoints(records: List<ActiveCaloriesBurnedRecord>): List<JSONObject> = records.map { record ->
        JSONObject()
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
            .put("basalEnergyBurned", JSONObject()
                .put("interval", JSONObject()
                    .put("startTime", WireTime.atOffset(point.time, point.zoneOffset))
                    .put("startUtcOffset", WireTime.offsetSeconds(point.zoneOffset))
                    .put("endTime", WireTime.atOffset(point.time, point.zoneOffset))
                    .put("endUtcOffset", WireTime.offsetSeconds(point.zoneOffset)))
                .put("kcal", point.kcal))
}
