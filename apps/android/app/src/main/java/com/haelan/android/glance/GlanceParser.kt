package com.haelan.android.glance

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/** A body the glance cannot read. The message names the field, by its path in the payload. */
class GlanceParseException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * The glance, the calendar and a day's log, from the text [GlanceClient] returns into the model.
 *
 * Strict about what the model needs and blind to everything else: a field the app does not know is
 * ignored, so a newer server can add to the payload freely, while a field it needs being absent,
 * or of the wrong type, fails the whole parse with that field's path. The screen then treats the
 * answer as unreachable and keeps the last good glance, rather than drawing half a payload. A
 * verdict word the app has no meaning for fails the same way: the app never guesses at a verdict.
 *
 * Reads through `has`, `isNull` and `get` alone, never the `opt*` family: those differ between
 * the platform's org.json and the library the unit tests run on (the platform's `optString` answers
 * "null" for a JSON null), and a parser whose tests pass on one and whose app runs on the other
 * would be proving nothing.
 */
object GlanceParser {

    fun parse(json: String): Glance {
        val root = Node.root(json)
        return Glance(
            today = root.string("today"),
            sleep = root.nullableObj("sleep")?.let(::sleep),
            recovery = recovery(root.obj("recovery")),
            day = day(root.obj("day")),
            week = week(root.obj("week")),
            finished = root.boolean("finished"),
            nav = root.obj("nav").let { GlanceNav(it.nullableString("previous"), it.nullableString("next")) },
            // Absent, not null, while the person has quick logging off.
            log = if (root.has("log")) dayLog(root.obj("log")) else null,
        )
    }

    fun parseCalendar(json: String): CalendarMonth {
        val root = Node.root(json)
        return CalendarMonth(
            month = root.string("month"),
            firstDay = root.nullableString("firstDay"),
            days = root.objects("days").map { day ->
                CalendarDay(
                    localDate = day.string("localDate"),
                    sleep = day.nullableEnum("sleep", CALENDAR_SLEEP),
                    steps = day.nullableEnum("steps", CALENDAR_STEPS),
                )
            },
        )
    }

    fun parseDayLog(json: String): DayLog = dayLog(Node.root(json))

    private val STANDINGS = mapOf(
        "within" to GlanceStanding.WITHIN, "above" to GlanceStanding.ABOVE, "below" to GlanceStanding.BELOW,
    )
    private val RECOVERY_BANDS = mapOf(
        "low" to RecoveryBand.LOW, "below" to RecoveryBand.BELOW, "usual" to RecoveryBand.USUAL,
        "above" to RecoveryBand.ABOVE, "high" to RecoveryBand.HIGH,
    )
    private val PACE_STANDINGS = mapOf(
        "ahead" to PaceStanding.AHEAD, "on" to PaceStanding.ON, "behind" to PaceStanding.BEHIND,
    )
    private val CALENDAR_SLEEP = mapOf("within" to CalendarSleep.WITHIN, "outside" to CalendarSleep.OUTSIDE)
    private val CALENDAR_STEPS = mapOf("reached" to CalendarSteps.REACHED, "below" to CalendarSteps.BELOW)

    private fun sleep(node: Node) = GlanceSleep(
        localDate = node.string("localDate"),
        sourceId = node.string("sourceId"),
        startMs = node.long("startMs"),
        endMs = node.long("endMs"),
        startOffsetMinutes = node.int("startOffsetMinutes"),
        endOffsetMinutes = node.int("endOffsetMinutes"),
        segments = node.objects("segments").map {
            GlanceNightSegment(stage = it.string("stage"), startMs = it.long("startMs"), endMs = it.long("endMs"))
        },
        asleep = figure(node.obj("asleep")),
        efficiency = figure(node.obj("efficiency")),
        bedtime = figure(node.obj("bedtime")),
        waketime = figure(node.obj("waketime")),
    )

    private fun recovery(node: Node) = GlanceRecovery(
        index = figure(node.obj("index")),
        band = node.nullableEnum("band", RECOVERY_BANDS),
        missing = node.nullableStrings("missing"),
        restingHeartRate = figure(node.obj("restingHeartRate")),
        hrv = figure(node.obj("hrv")),
        respiratoryRate = node.nullableObj("respiratoryRate")?.let(::figure),
    )

    private fun day(node: Node): GlanceDay {
        val heartRate = node.obj("heartRate")
        return GlanceDay(
            steps = figure(node.obj("steps")),
            stepsPace = node.nullableObj("stepsPace")?.let { pace ->
                GlanceStepsPace(
                    center = pace.double("center"),
                    low = pace.double("low"),
                    high = pace.double("high"),
                    thin = pace.boolean("thin"),
                    value = pace.double("value"),
                    atMs = pace.long("atMs"),
                    standing = pace.nullableEnum("standing", PACE_STANDINGS),
                )
            },
            activeMinutes = figure(node.obj("activeMinutes")),
            heartRate = GlanceHeartRate(
                points = heartRate.objects("points").map { point ->
                    IntradayPoint(
                        sourceId = point.string("sourceId"),
                        utcMs = point.long("utcMs"),
                        min = point.nullableDouble("min"),
                        mean = point.nullableDouble("mean"),
                        max = point.nullableDouble("max"),
                        n = point.int("n"),
                        excluded = point.boolean("excluded"),
                    )
                },
                asOfMs = heartRate.nullableLong("asOfMs"),
                staleSources = staleSources(heartRate),
            ),
            workouts = node.objects("workouts").map(::workout),
        )
    }

    private fun workout(node: Node): WorkoutSession {
        val sourceId = node.string("sourceId")
        return WorkoutSession(
            id = node.string("id"),
            sourceId = sourceId,
            startMs = node.long("startMs"),
            endMs = node.long("endMs"),
            startOffsetMinutes = node.int("startOffsetMinutes"),
            endOffsetMinutes = node.int("endOffsetMinutes"),
            localDate = node.string("localDate"),
            summary = workoutSummary(node.raw("attrs")),
            excluded = node.boolean("excluded"),
            excludeReason = node.nullableString("excludeReason"),
            // Optional on the wire, as the web reads them: a response from before workouts were
            // merged carries neither, and "one source, no other copies" is what it meant.
            sources = if (node.has("sources")) node.strings("sources") else listOf(sourceId),
            alternateIds = if (node.has("alternateIds")) node.strings("alternateIds") else emptyList(),
        )
    }

    /**
     * core's workoutSummary.ts, the fields the web's SessionRow shows. attrs is whatever the
     * provider stored, never validated, so this never fails the parse: a field that is absent, blank
     * or not a number is null, and attrs that are not an object carry no fields at all.
     */
    private fun workoutSummary(attrs: Any?): WorkoutSummary {
        if (attrs !is JSONObject) return WorkoutSummary(null, null, null, null, null, null)
        val metrics = attrs.valueOrNull("metricsSummary") as? JSONObject ?: JSONObject()
        fun number(key: String) = numberOrNull(metrics.valueOrNull(key))
        return WorkoutSummary(
            exerciseType = attrs.valueOrNull("exerciseType") as? String,
            caloriesKcal = number("caloriesKcal"),
            averageHeartRateBpm = number("averageHeartRateBeatsPerMinute"),
            distanceMeters = number("distanceMillimeters")?.let { it / 1000 },
            paceSecondsPerKm = number("averagePaceSecondsPerMeter")?.let { it * 1000 },
            elevationGainMeters = number("elevationGainMillimeters")?.let { it / 1000 },
        )
    }

    /** numberOrNull in workoutSummary.ts: the provider sends some of these as strings. Negative zero comes out as zero. */
    private fun numberOrNull(value: Any?): Double? {
        val n = when (value) {
            is Number -> value.toDouble()
            is String -> if (value.isBlank()) null else value.trim().toDoubleOrNull()
            else -> null
        } ?: return null
        return if (!n.isFinite()) null else if (n == 0.0) 0.0 else n
    }

    private fun JSONObject.valueOrNull(key: String): Any? =
        if (!has(key) || isNull(key)) null else get(key)

    private fun figure(node: Node) = GlanceFigure(
        metric = node.string("metric"),
        value = node.nullableDouble("value"),
        unit = node.string("unit"),
        baseline = node.nullableObj("baseline")?.let(::baseline),
        asOfDate = node.nullableString("asOfDate"),
        asOfMs = node.nullableLong("asOfMs"),
        partial = node.boolean("partial"),
        staleSources = staleSources(node),
        strip = node.objects("strip").map { day ->
            GlanceStripDay(
                localDate = day.string("localDate"),
                value = day.nullableDouble("value"),
                band = day.nullableObj("band")?.let(::baseline),
                standing = day.nullableEnum("standing", STANDINGS),
            )
        },
        standing = node.nullableEnum("standing", STANDINGS),
    )

    private fun baseline(node: Node) = GlanceBaseline(
        center = node.double("center"),
        low = node.double("low"),
        high = node.double("high"),
        thin = node.boolean("thin"),
    )

    private fun staleSources(node: Node) = node.objects("staleSources").map {
        GlanceStaleSource(
            sourceId = it.string("sourceId"),
            name = it.string("name"),
            lastReportedDate = it.string("lastReportedDate"),
            medianGapDays = it.nullableDouble("medianGapDays"),
        )
    }

    private fun week(node: Node): GlanceWeek {
        fun row(key: String) = node.nullableObj(key)?.let {
            GlanceWeekFigure(perDay = it.double("perDay"), days = it.int("days"), total = it.double("total"))
        }
        return GlanceWeek(steps = row("steps"), activeMinutes = row("activeMinutes"), asleep = row("asleep"))
    }

    private fun dayLog(node: Node): DayLog {
        val counts = node.obj("counts")
        return DayLog(
            presets = node.strings("presets"),
            mood = node.nullableInt("mood"),
            counts = counts.keys().associateWith { counts.int(it) },
            note = node.nullableString("note"),
            today = node.string("today"),
        )
    }

    /**
     * One JSON object and where it sits in the payload, so every failure can name its field by path
     * ("day.steps.strip[2].standing") rather than by a bare key that appears in forty places.
     */
    private class Node(private val json: JSONObject, private val path: String) {

        companion object {
            fun root(text: String): Node {
                val json = try {
                    JSONObject(text)
                } catch (e: JSONException) {
                    throw GlanceParseException("not a JSON object", e)
                }
                return Node(json, "")
            }
        }

        private fun at(key: String) = if (path.isEmpty()) key else "$path.$key"

        fun has(key: String) = json.has(key)

        fun keys(): List<String> = json.keys().asSequence().toList()

        /** The value under [key], JSON null as null; absent is a failure, since every field read this way is one the payload always sends. */
        fun raw(key: String): Any? {
            if (!json.has(key)) throw GlanceParseException("${at(key)} is missing")
            return if (json.isNull(key)) null else json.get(key)
        }

        private fun wrong(key: String, expected: String): Nothing =
            throw GlanceParseException("${at(key)} is not $expected")

        private fun <T : Any> required(key: String, value: T?): T =
            value ?: throw GlanceParseException("${at(key)} is null")

        fun nullableString(key: String): String? = when (val v = raw(key)) {
            null -> null
            is String -> v
            else -> wrong(key, "a string")
        }

        fun string(key: String): String = required(key, nullableString(key))

        fun nullableDouble(key: String): Double? = when (val v = raw(key)) {
            null -> null
            is Number -> v.toDouble()
            else -> wrong(key, "a number")
        }

        fun double(key: String): Double = required(key, nullableDouble(key))

        fun nullableLong(key: String): Long? = when (val v = raw(key)) {
            null -> null
            is Number -> v.toLong()
            else -> wrong(key, "a number")
        }

        fun long(key: String): Long = required(key, nullableLong(key))

        fun nullableInt(key: String): Int? = nullableLong(key)?.toInt()

        fun int(key: String): Int = required(key, nullableInt(key))

        fun boolean(key: String): Boolean = when (val v = raw(key)) {
            is Boolean -> v
            else -> wrong(key, "true or false")
        }

        fun nullableObj(key: String): Node? = when (val v = raw(key)) {
            null -> null
            is JSONObject -> Node(v, at(key))
            else -> wrong(key, "an object")
        }

        fun obj(key: String): Node = required(key, nullableObj(key))

        private fun array(key: String): JSONArray? = when (val v = raw(key)) {
            null -> null
            is JSONArray -> v
            else -> wrong(key, "a list")
        }

        fun objects(key: String): List<Node> {
            val list = required(key, array(key))
            return (0 until list.length()).map { i ->
                val item = list.get(i) as? JSONObject ?: throw GlanceParseException("${at(key)}[$i] is not an object")
                Node(item, "${at(key)}[$i]")
            }
        }

        fun nullableStrings(key: String): List<String>? {
            val list = array(key) ?: return null
            return (0 until list.length()).map { i ->
                list.get(i) as? String ?: throw GlanceParseException("${at(key)}[$i] is not a string")
            }
        }

        fun strings(key: String): List<String> = required(key, nullableStrings(key))

        fun <E> nullableEnum(key: String, words: Map<String, E>): E? {
            val word = nullableString(key) ?: return null
            return words[word] ?: throw GlanceParseException("${at(key)} is '$word', which the app does not know")
        }
    }
}
