package com.haelan.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Per type, what one request may carry: the ceilings measured on the wire shape of the type's own
 * mapper, through the whole loop that turns a page into requests.
 *
 * One type's measurement cannot answer for the rest. The bytes a point costs decide whether the
 * byte budget or the count closes a chunk, the points one record maps to decide how far past a
 * ceiling a single page can jump the buffer, and the gap between two readings decides whether the
 * span is the ceiling that closes it. Heart rate is the type where the first is smallest and the
 * second is not one, and that difference is the defect this file guards: its page left several
 * closed chunks in the buffer at once, and a flush that handed all of them to one request posted
 * a body several times the byte budget in one go, which the instance refused for its count.
 *
 * THE LOOP IS THE PRODUCTION ONE. [SyncEngine.chunkEnds] cuts and [SyncEngine.flushEnd] flushes,
 * the same two the engine runs, and the model around them is uploadType's own order: a page in,
 * every closed chunk out as its own request, the remainder flushed once the pages are over. A
 * model that reimplemented either half is how the defect travelled this far: it agreed with
 * itself while the phone sent what the ceilings forbid.
 *
 * THE COSTS ARE MEASURED FROM LITERALS, because the mappers cannot be called from here: they
 * build org.json.JSONObject, a stub in a JVM unit test ("Method put in org.json.JSONObject not
 * mocked"), and the flush they feed calls android.util.Log, which is a stub too. Each row carries
 * one point as the literal its mapper writes, with the envelope transcribed from the mapper named
 * in the helpers below. Two tests keep the literals from drifting into fiction: one asserts every
 * literal carries the payload key of the type it claims, the other asserts every type the engine
 * syncs has a row here, so a type added without one fails the suite instead of going unmeasured.
 */
class TypeChunkLimitTest {

    /** SyncEngine.MAX_CHUNK_BYTES, repeated because that constant is private to the engine. */
    private val budget = 512 * 1024

    /**
     * The provider's page: connect-client's own `ReadRecordsRequest` default of a thousand
     * records, read out of the 1.1.0 artifact rather than remembered, because how far one page can
     * push the buffer is what decides whether a merged flush is reachable at all. Every mapper but
     * heart rate writes at most one point per record, so a page is at most a thousand points for
     * them: sleep groups a night's records into one, and nothing else multiplies them.
     */
    private val recordsPerPage = 1000

    /**
     * The pages one type is measured over: the fewest that leave three requests behind, so the
     * drain has closed a chunk and then closed another, and never more than ten, so a type whose
     * page fills many chunks (heart rate) is measured on the single page that produced the defect
     * instead of on a volume nothing would ever hold.
     */
    private val maxPages = 10

    private val second = 1000L
    private val minute = 60 * second
    private val hour = 60 * minute
    private val day = 24 * hour

    private val firstPointMs = 1_700_000_000_000L

    // The wire spellings WireTime writes: the instant with its own offset, and the offset as the
    // seconds-suffixed duration the API carries.
    private val startAt = "2026-09-14T10:40:00+02:00"
    private val endAt = "2026-09-14T10:41:00+02:00"
    private val offset = "7200s"

    /**
     * One type as it reaches the wire, and how densely it arrives.
     */
    private class Shape(
        /** The toggle key, the one SyncTypes.KEYS carries. */
        val key: String,
        /** The v4 payload key the mapper wraps a reading in, which the literal has to carry. */
        val payloadKey: String,
        /** One point, as the mapper writes it. */
        val point: String,
        /** The points one provider page leaves in the buffer, by identity. */
        val pointsPerPage: Int,
        /**
         * The gap between two consecutive readings at their densest, which is the clock the span
         * ceiling measures. Spacing only decides which ceiling closes a chunk, so a rate slower
         * than the one here cannot fail a test this one passes.
         */
        val stepMs: Long,
    )

    /**
     * The interval envelope the interval mappers share (toStepPoints, toDistancePoints,
     * toAltitudePoints, toCaloriesPoints, toExercisePoints, toHydrationPoints and basalPoint): the
     * type's own key, the four ends, and the reading's value beside them.
     *
     * A value's spelling is the mapper's own and not a formatting choice: the two that are strings
     * below are strings because the mapper writes `.toString()` where it writes a number
     * elsewhere, and this file measures what the mapper does rather than what it should have done.
     */
    private fun interval(key: String, value: String): String =
        """{"$key":{"interval":{"startTime":"$startAt","startUtcOffset":"$offset",""" +
            """"endTime":"$endAt","endUtcOffset":"$offset"},$value}}"""

    /**
     * The sample envelope the sample-time mappers share (toWeightPoints, toHeightPoints,
     * toBodyFatPoints, toHeartRatePoints, toHrvPoints, toSpo2Points, toBodyTempPoints,
     * toBloodGlucosePoints, toVo2Points and toSleepRespPoints): the reading's own instant and
     * offset, with the value beside them.
     */
    private fun sample(key: String, value: String): String =
        """{"$key":{"sampleTime":{"physicalTime":"$startAt","utcOffset":"$offset"},$value}}"""

    /** dailyRestingPoint: a civil date where the others carry an instant, because the day is it. */
    private fun daily(value: String): String =
        """{"dailyRestingHeartRate":{"date":{"year":2026,"month":9,"day":14},$value}}"""

    /**
     * toSleepPoints: the interval, the STAGES envelope, and one object per stage. The only shape
     * whose size moves with the data, which is why it is built rather than written out: a night is
     * a dozen stages and a night of a hundred is the same mapper, and the ceiling has to hold for
     * both.
     */
    private fun sleepNight(stages: Int): String {
        val names = listOf("LIGHT", "DEEP", "REM", "AWAKE")
        val objects = (0 until stages).joinToString(",") { index ->
            val from = "2026-09-14T23:%02d:00+02:00".format(index * 4)
            val to = "2026-09-14T23:%02d:00+02:00".format(index * 4 + 4)
            """{"type":"${names[index % names.size]}","startTime":"$from","startUtcOffset":"$offset",""" +
                """"endTime":"$to","endUtcOffset":"$offset"}"""
        }
        return """{"sleep":{"interval":{"startTime":"$startAt","startUtcOffset":"$offset",""" +
            """"endTime":"$endAt","endUtcOffset":"$offset"},"type":"STAGES",""" +
            """"metadata":{"mainSleep":true,"processed":true,"stagesStatus":"SUCCEEDED"},"stages":[$objects]}}"""
    }

    /**
     * Every type the engine syncs, with the point its mapper writes and the density it arrives at.
     *
     * Heart rate carries what a real phone was left holding on 2026-09-18: 24045 points in the
     * buffer after one page, which is a thousand records of about twenty samples each, and the
     * shape the count ceiling was written for. The others carry a page of records, which is the
     * widest one the provider can answer whatever a person's own history holds.
     */
    private val shapes = listOf(
        // Interval types: one point per record, the record's own aggregate.
        Shape("steps", "steps", interval("steps", "\"count\":42"), recordsPerPage, minute),
        Shape("distance", "distance", interval("distance", "\"millimeters\":1250"), recordsPerPage, minute),
        Shape("elevation", "altitude", interval("altitude", "\"gainMillimeters\":\"37\""), recordsPerPage, minute),
        Shape(
            "active_energy", "activeEnergyBurned", interval("activeEnergyBurned", "\"kcal\":12.5"),
            recordsPerPage, minute,
        ),
        // A daily reading whose interval is empty and sits on the reading's own instant.
        Shape("basal", "basalEnergyBurned", interval("basalEnergyBurned", "\"kcal\":1650.0"), recordsPerPage, day),
        Shape("exercise", "exercise", interval("exercise", "\"exerciseType\":\"RUNNING\""), recordsPerPage, hour),
        Shape("sleep", "sleep", sleepNight(stages = 12), recordsPerPage, day),
        Shape(
            "hydration", "hydrationLog", interval("hydrationLog", "\"amountConsumed\":{\"milliliters\":250.0}"),
            recordsPerPage, hour,
        ),
        // Sample-time types: the same envelope with the reading's own value under it.
        Shape("weight", "weight", sample("weight", "\"weightGrams\":\"75200\""), recordsPerPage, day),
        Shape("height", "height", sample("height", "\"heightMillimeters\":\"1780\""), recordsPerPage, day),
        Shape("body_fat", "bodyFat", sample("bodyFat", "\"percentage\":21.5"), recordsPerPage, day),
        Shape(
            "body_temp", "coreBodyTemperature", sample("coreBodyTemperature", "\"temperatureCelsius\":36.6"),
            recordsPerPage, hour,
        ),
        Shape(
            "glucose", "bloodGlucose", sample("bloodGlucose", "\"bloodGlucoseMilligramsPerDeciliter\":95.0"),
            recordsPerPage, 5 * minute,
        ),
        // The dense one: the only mapper that flattens the samples inside a record into a point
        // each, so the only type whose page can leave several closed chunks buffered at once.
        Shape("heart_rate", "heartRate", sample("heartRate", "\"beatsPerMinute\":62"), 24_045, second),
        Shape("resting", "dailyRestingHeartRate", daily("\"beatsPerMinute\":\"58\""), recordsPerPage, day),
        Shape(
            "hrv", "heartRateVariability",
            sample("heartRateVariability", "\"rootMeanSquareOfSuccessiveDifferencesMilliseconds\":42.5"),
            recordsPerPage, 10 * minute,
        ),
        Shape("spo2", "oxygenSaturation", sample("oxygenSaturation", "\"percentage\":97.0"), recordsPerPage, 10 * minute),
        Shape(
            "breathing", "respiratoryRateSleepSummary",
            sample("respiratoryRateSleepSummary", "\"fullSleepStats\":{\"breathsPerMinute\":14.5}"),
            recordsPerPage, day,
        ),
        Shape("vo2", "vo2Max", sample("vo2Max", "\"vo2Max\":44.5"), recordsPerPage, day),
    )

    /** One mapped point as the buffer holds it: what it costs on the wire, and when it happened. */
    private class Wire(val cost: Int, val atMs: Long)

    /** One request: what it would carry, and the reach of what it carries. */
    private class Request(val points: Int, val bytes: Int, val fromMs: Long, val toMs: Long) {
        val reachMs: Long get() = toMs - fromMs
    }

    /** What one type's stream left behind: the points the pages held, and the requests they became. */
    private class Plan(val pointsRead: Int, val requests: List<Request>)

    /**
     * The engine's loop on one type, as uploadType runs it. Pages go in one at a time, because
     * that is when the buffer is cut in production, and that is what makes a page holding more
     * than one chunk visible here.
     */
    private fun drain(shape: Shape, pages: Int): Plan {
        // One byte per point for the separator between them, which is the count chunkEnds cuts by.
        val cost = shape.point.toByteArray(Charsets.UTF_8).size + 1
        val buffer = mutableListOf<Wire>()
        val requests = mutableListOf<Request>()
        var atMs = firstPointMs
        repeat(pages) {
            repeat(shape.pointsPerPage) {
                buffer += Wire(cost, atMs)
                atMs += shape.stepMs
            }
            while (true) {
                val end = SyncEngine.flushEnd(chunkEnds(buffer)) ?: break
                requests += requestOf(buffer, 0, end)
                buffer.subList(0, end).clear()
            }
        }
        // Whatever the read still holds once the pages are over: the tail, cut to the same ceilings.
        var from = 0
        for (end in chunkEnds(buffer)) {
            requests += requestOf(buffer, from, end)
            from = end
        }
        return Plan(pointsRead = pages * shape.pointsPerPage, requests = requests)
    }

    private fun chunkEnds(buffer: List<Wire>): List<Int> = SyncEngine.chunkEnds(
        buffer.map { it.cost },
        budget,
        buffer.map { it.atMs },
        SyncEngine.MAX_CHUNK_SPAN_MS,
        SyncEngine.MAX_CHUNK_POINTS,
    )

    private fun requestOf(buffer: List<Wire>, from: Int, to: Int): Request = Request(
        points = to - from,
        // The points' own bytes, separators included: one per point, less the one after the last.
        // The body's envelope rides beside them and is a pair of braces, not a whole point.
        bytes = (from until to).sumOf { buffer[it].cost } - 1,
        fromMs = buffer[from].atMs,
        toMs = buffer[to - 1].atMs,
    )

    private fun planOf(shape: Shape): Plan {
        var pages = 1
        var plan = drain(shape, pages)
        while (plan.requests.size < 3 && pages < maxPages) {
            pages++
            plan = drain(shape, pages)
        }
        return plan
    }

    /** The requests one type's stream leaves, which is never empty: a page carries at least a point. */
    private fun requestsOf(shape: Shape): List<Request> = planOf(shape).requests.also { requests ->
        assertTrue("${shape.key}: no request was measured at all", requests.isNotEmpty())
    }

    @Test
    fun `every type the engine syncs is measured here`() {
        // The tripwire: a type that reaches the toggles has to bring the wire shape its requests
        // are cut by. A type nobody measured is a type whose body nothing here can vouch for.
        assertEquals(SyncTypes.KEYS.sorted(), shapes.map { it.key }.sorted())
    }

    @Test
    fun `every literal carries the payload key of the type it claims`() {
        for (shape in shapes) {
            assertTrue(
                "${shape.key}: the literal does not carry \"${shape.payloadKey}\"",
                shape.point.contains("\"${shape.payloadKey}\""),
            )
        }
    }

    /**
     * A literal assembled by hand can still be balanced-looking garbage, and garbage measures
     * bytes that no point costs. Counted rather than parsed, because this classpath has no JSON
     * parser: a brace that does not close and a quote that does not pair are the two mistakes
     * building an envelope out of pieces actually makes.
     */
    @Test
    fun `every literal is balanced enough to be the JSON a point is`() {
        for (shape in shapes) {
            assertTrue(
                "${shape.key}: the braces do not balance in ${shape.point}",
                shape.point.count { it == '{' } == shape.point.count { it == '}' },
            )
            assertTrue(
                "${shape.key}: the quotes do not pair in ${shape.point}",
                shape.point.count { it == '"' } % 2 == 0,
            )
        }
    }

    @Test
    fun `no type's request carries more points than the app caps a chunk at`() {
        for (shape in shapes) {
            val worst = requestsOf(shape).maxByOrNull { it.points }!!
            assertTrue(
                "${shape.key}: a request carried ${worst.points} points, over the ${SyncEngine.MAX_CHUNK_POINTS} the app caps at",
                worst.points <= SyncEngine.MAX_CHUNK_POINTS,
            )
        }
    }

    @Test
    fun `no type's request carries more bytes than the budget it was cut to`() {
        for (shape in shapes) {
            val worst = requestsOf(shape).maxByOrNull { it.bytes }!!
            // A single point over the budget travels alone rather than being split: a record the
            // provider answered with cannot be cut in half, and it is the one request allowed past.
            val alone = worst.points == 1
            assertTrue(
                "${shape.key}: a request carried ${worst.bytes} bytes, over the $budget budget",
                alone || worst.bytes <= budget,
            )
        }
    }

    @Test
    fun `no type's chunk reaches past the span that bounds what a refusal costs`() {
        for (shape in shapes) {
            val worst = requestsOf(shape).maxByOrNull { it.reachMs }!!
            val ceilingHours = SyncEngine.MAX_CHUNK_SPAN_MS / hour
            assertTrue(
                "${shape.key}: a chunk reached ${worst.reachMs / hour} hours, past the $ceilingHours hour ceiling",
                worst.reachMs <= SyncEngine.MAX_CHUNK_SPAN_MS,
            )
        }
    }

    @Test
    fun `every type's readings travel once and in order with nothing left in the buffer`() {
        for (shape in shapes) {
            val plan = planOf(shape)
            assertEquals(
                "${shape.key}: the requests carry ${plan.requests.sumOf { it.points }} of the ${plan.pointsRead} points read",
                plan.pointsRead,
                plan.requests.sumOf { it.points },
            )
            // Contiguous and ascending: a request opens where the previous one closed, so no
            // reading is skipped and none travels twice.
            var expected = firstPointMs
            for (request in plan.requests) {
                assertEquals("${shape.key}: a request opens where the previous one closed", expected, request.fromMs)
                expected = request.toMs + shape.stepMs
            }
        }
    }

    /**
     * The count ceiling on its own, which no type reaches today: with heart rate's measured point
     * this file's densest type is closed by the byte budget first, so nothing in the table above
     * makes the count the binding ceiling. The ceiling exists for a shape that does not exist yet,
     * a type whose points are small enough that bytes and span both pass it, and this is that
     * shape: a page of tiny points where the count is the only ceiling that bites.
     *
     * It is also the drain regression: a flush that took every closed end in the buffer as one
     * chunk would answer 19980 points for the first request here, and this is the case that says
     * one chunk per request.
     */
    @Test
    fun `a type whose points are tiny is closed by the count, one chunk per request`() {
        val tiny = Shape(
            key = "hypothetical",
            payloadKey = "p",
            point = """{"p":{"t":1}}""",
            pointsPerPage = 24_045,
            stepMs = second,
        )

        val requests = requestsOf(tiny)

        assertTrue("the tiny points must travel as several requests, not one", requests.size > 1)
        for (request in requests) {
            assertTrue(
                "a request carried ${request.points} points, over the ${SyncEngine.MAX_CHUNK_POINTS} the app caps at",
                request.points <= SyncEngine.MAX_CHUNK_POINTS,
            )
        }
        assertEquals(
            "and the requests still cover every point once",
            tiny.pointsPerPage * 1,
            requests.sumOf { it.points },
        )
    }

    /**
     * The table itself, printed: what one request may carry per type, which is the answer this
     * file exists to give and the number a body has to stay under. The ceilings are asserted
     * above; this is what they came out to for the shapes the mappers write today, so a change
     * that moves a number moves it visibly instead of inside a passing assertion.
     */
    @Test
    fun `the measurement table, per type`() {
        println("type              bytes/pt  pts/page  pages  requests  max pts  max bytes  max reach h")
        for (shape in shapes) {
            val plan = planOf(shape)
            val bytesPerPoint = shape.point.toByteArray(Charsets.UTF_8).size + 1
            val worstPoints = plan.requests.maxOf { it.points }
            val worstBytes = plan.requests.maxOf { it.bytes }
            val worstReach = plan.requests.maxOf { it.reachMs }
            println(
                "%-17s %8d %9d %6d %9d %8d %10d %12d".format(
                    shape.key,
                    bytesPerPoint,
                    shape.pointsPerPage,
                    plan.pointsRead / shape.pointsPerPage,
                    plan.requests.size,
                    worstPoints,
                    worstBytes,
                    worstReach / hour,
                ),
            )
        }
    }
}
