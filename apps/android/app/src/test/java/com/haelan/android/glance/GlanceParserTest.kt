package com.haelan.android.glance

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The parser against the bodies the server really sends. Each fixture under `glance/` is written by
 * apps/server/test/android-glance-fixture.test.ts from a seeded person, and that test fails when a
 * committed fixture differs from what the routes now answer, so nothing read here is a shape typed
 * by hand. The seeded values the assertions name are that test's own.
 */
class GlanceParserTest {

    private fun fixture(name: String): String =
        checkNotNull(javaClass.getResourceAsStream("/glance/$name")) {
            "glance/$name is not on the test classpath"
        }.bufferedReader().readText()

    private val today by lazy { GlanceParser.parse(fixture("today.json")) }

    /** The fixture edited as JSON, for the cases no real server sends. */
    private fun edited(name: String, edit: (JSONObject) -> Unit): String =
        JSONObject(fixture(name)).also(edit).toString()

    @Test
    fun `the glance's own fields land`() {
        assertEquals("2026-08-20", today.today)
        assertFalse(today.finished)
        assertEquals(GlanceNav(previous = "2026-08-19", next = null), today.nav)
    }

    @Test
    fun `last night lands with its span and its stages, upper case as sent`() {
        val sleep = checkNotNull(today.sleep)
        assertEquals("2026-08-20", sleep.localDate)
        assertEquals("watch", sleep.sourceId)
        assertEquals(1787175600000L, sleep.startMs)
        assertEquals(1787202600000L, sleep.endMs)
        assertEquals(120, sleep.startOffsetMinutes)
        assertEquals(120, sleep.endOffsetMinutes)
        assertEquals(7, sleep.segments.size)
        assertEquals(GlanceNightSegment("DEEP", 1787178000000L, 1787182200000L), sleep.segments[1])
        assertEquals("AWAKE", sleep.segments[4].stage)
    }

    @Test
    fun `a figure lands whole, its baseline, as-of, strip and verdict`() {
        val asleep = checkNotNull(today.sleep).asleep
        assertEquals("sleep_asleep_minutes", asleep.metric)
        assertEquals(420.0, asleep.value)
        assertEquals("minutes", asleep.unit)
        assertEquals(GlanceBaseline(center = 430.0, low = 422.0, high = 438.0, thin = false), asleep.baseline)
        assertEquals("2026-08-20", asleep.asOfDate)
        assertEquals(1787202600000L, asleep.asOfMs)
        assertFalse(asleep.partial)
        assertEquals(emptyList<GlanceStaleSource>(), asleep.staleSources)
        assertEquals(GlanceStanding.BELOW, asleep.standing)
        assertEquals(7, asleep.strip.size)
        assertEquals(
            GlanceStripDay(
                localDate = "2026-08-15",
                value = 440.0,
                band = GlanceBaseline(center = 430.0, low = 422.0, high = 438.0, thin = false),
                standing = GlanceStanding.ABOVE,
            ),
            asleep.strip[1],
        )
        assertEquals(GlanceStanding.WITHIN, asleep.strip[2].standing)
        val sleep = checkNotNull(today.sleep)
        assertEquals("sleep_efficiency", sleep.efficiency.metric)
        assertEquals("sleep_bedtime_minutes", sleep.bedtime.metric)
        assertEquals("sleep_waketime_minutes", sleep.waketime.metric)
    }

    @Test
    fun `a running figure lands partial, with no verdict on its own day`() {
        val steps = today.day.steps
        assertEquals(4000.0, steps.value)
        assertTrue(steps.partial)
        assertNull(steps.standing)
        assertNull(steps.strip.last().standing)
        assertEquals(GlanceStanding.ABOVE, steps.strip[3].standing)
        assertEquals(1787205600000L, steps.asOfMs)
    }

    @Test
    fun `recovery lands with its band, and respiratory rate on the day it rose`() {
        val recovery = today.recovery
        assertEquals(4.0, recovery.index.value)
        assertNull(recovery.index.baseline)
        assertNull(recovery.index.strip[0].band)
        assertEquals(RecoveryBand.LOW, recovery.band)
        assertNull(recovery.missing)
        assertEquals(55.0, recovery.restingHeartRate.value)
        assertEquals("daily_hrv", recovery.hrv.metric)
        val respiratory = checkNotNull(recovery.respiratoryRate)
        assertEquals(17.0, respiratory.value)
        assertEquals(14.2, checkNotNull(respiratory.baseline).center, 0.0)
        assertEquals(GlanceStanding.ABOVE, respiratory.standing)
    }

    @Test
    fun `the day lands its pace, active minutes and heart rate`() {
        assertEquals(
            GlanceStepsPace(
                center = 1100.0, low = 1018.0, high = 1182.0, thin = false,
                value = 1200.0, atMs = 1787205600000L, standing = PaceStanding.AHEAD,
            ),
            today.day.stepsPace,
        )
        assertEquals("active_minutes", today.day.activeMinutes.metric)
        val heartRate = today.day.heartRate
        assertEquals(5, heartRate.points.size)
        assertEquals(
            IntradayPoint("watch", 1787212800000L, min = 58.0, mean = 62.0, max = 66.0, n = 1, excluded = false),
            heartRate.points[0],
        )
        assertEquals(1787213040000L, heartRate.asOfMs)
        assertEquals(emptyList<GlanceStaleSource>(), heartRate.staleSources)
        // The offset the day's readings were recorded under, as the server wrote it.
        assertEquals(120, heartRate.offsetMinutes)
    }

    @Test
    fun `a heart rate with no offset reads as none, from a server that sends null or predates the field`() {
        assertNull(GlanceParser.parse(edited("today.json") { it.getJSONObject("day").getJSONObject("heartRate").put("offsetMinutes", JSONObject.NULL) }).day.heartRate.offsetMinutes)
        assertNull(GlanceParser.parse(edited("today.json") { it.getJSONObject("day").getJSONObject("heartRate").remove("offsetMinutes") }).day.heartRate.offsetMinutes)
    }

    @Test
    fun `a workout lands with what its row shows, read out of its attrs`() {
        val run = today.day.workouts.single()
        assertEquals("run-1", run.id)
        assertEquals("watch", run.sourceId)
        assertEquals(1787206500000L, run.startMs)
        assertEquals(1787209020000L, run.endMs)
        assertEquals(120, run.startOffsetMinutes)
        assertEquals(120, run.endOffsetMinutes)
        assertEquals("2026-08-20", run.localDate)
        assertFalse(run.excluded)
        assertNull(run.excludeReason)
        assertEquals(listOf("watch"), run.sources)
        assertEquals(emptyList<String>(), run.alternateIds)
        // The heart rate arrives as a string and the rest as numbers, the provider's own mix.
        assertEquals(
            WorkoutSummary(
                exerciseType = "RUNNING", caloriesKcal = 412.0, averageHeartRateBpm = 151.0,
                distanceMeters = 7200.0, paceSecondsPerKm = 350.0, elevationGainMeters = 42.0,
            ),
            run.summary,
        )
    }

    @Test
    fun `the week lands its per-day averages, days and totals`() {
        assertEquals(GlanceWeekFigure(perDay = 10667.0, days = 6, total = 68000.0), today.week.steps)
        assertEquals(GlanceWeekFigure(perDay = 48.0, days = 6, total = 310.0), today.week.activeMinutes)
        assertEquals(GlanceWeekFigure(perDay = 429.0, days = 7, total = 3000.0), today.week.asleep)
    }

    @Test
    fun `a glance with quick logging off has no log`() {
        assertNull(today.log)
    }

    @Test
    fun `a glance with quick logging on carries the day's log`() {
        val glance = GlanceParser.parse(fixture("today-quick-log.json"))
        assertEquals(
            DayLog(
                presets = listOf("illness", "travel", "alcohol", "medication", "injury", "caffeine", "meditation", "sauna", "reading", "screen_free", "stretching"),
                mood = 4,
                counts = mapOf("caffeine" to 2),
                note = "Slept with the window open.",
                today = "2026-08-20",
            ),
            glance.log,
        )
    }

    @Test
    fun `a finished day lands finished, with no pace and a night without stages`() {
        val glance = GlanceParser.parse(fixture("past-day.json"))
        assertEquals("2026-08-18", glance.today)
        assertTrue(glance.finished)
        assertEquals(GlanceNav(previous = "2026-08-17", next = "2026-08-19"), glance.nav)
        assertNull(glance.day.stepsPace)
        assertEquals(emptyList<GlanceNightSegment>(), checkNotNull(glance.sleep).segments)
        assertEquals(7, checkNotNull(glance.week.steps).days)
    }

    @Test
    fun `a person with no data parses to nulls and empties`() {
        val glance = GlanceParser.parse(fixture("empty.json"))
        assertNull(glance.sleep)
        assertEquals(GlanceNav(null, null), glance.nav)
        assertEquals(GlanceWeek(null, null, null), glance.week)
        assertNull(glance.recovery.index.value)
        assertNull(glance.recovery.index.asOfDate)
        assertNull(glance.recovery.band)
        assertEquals(listOf("hrv", "restingHeartRate"), glance.recovery.missing)
        assertNull(glance.recovery.respiratoryRate)
        assertNull(glance.day.steps.value)
        assertNull(glance.day.steps.baseline)
        assertNull(glance.day.stepsPace)
        assertEquals(emptyList<IntradayPoint>(), glance.day.heartRate.points)
        assertNull(glance.day.heartRate.asOfMs)
        assertEquals(emptyList<WorkoutSession>(), glance.day.workouts)
        assertNull(glance.log)
    }

    @Test
    fun `the calendar lands its month, first day and each day's two dots`() {
        val month = GlanceParser.parseCalendar(fixture("calendar.json"))
        assertEquals("2026-08", month.month)
        assertEquals("2026-06-21", month.firstDay)
        assertEquals(20, month.days.size)
        assertEquals(CalendarDay("2026-08-19", CalendarSleep.WITHIN, CalendarSteps.REACHED), month.days[18])
        assertEquals(CalendarDay("2026-08-20", CalendarSleep.OUTSIDE, null), month.days[19])
    }

    @Test
    fun `a day's log lands, a kind no preset names counted under its own spelling`() {
        assertEquals(
            DayLog(
                presets = listOf("illness", "travel", "alcohol", "medication", "injury", "caffeine", "meditation", "sauna", "reading", "screen_free", "stretching"),
                mood = 2,
                counts = mapOf("sauna" to 1),
                note = null,
                today = "2026-08-20",
            ),
            GlanceParser.parseDayLog(fixture("day-log.json")),
        )
    }

    @Test
    fun `a missing required field fails the parse, naming it`() {
        val json = edited("today.json") { it.getJSONObject("sleep").remove("asleep") }
        val failure = assertThrows(GlanceParseException::class.java) { GlanceParser.parse(json) }
        assertTrue(failure.message, failure.message!!.contains("sleep.asleep"))
    }

    @Test
    fun `a missing field inside a list names its place in the list`() {
        val json = edited("today.json") {
            it.getJSONObject("day").getJSONObject("steps").getJSONArray("strip").getJSONObject(2).remove("standing")
        }
        val failure = assertThrows(GlanceParseException::class.java) { GlanceParser.parse(json) }
        assertTrue(failure.message, failure.message!!.contains("day.steps.strip[2].standing"))
    }

    @Test
    fun `a field of the wrong type fails the parse, naming it`() {
        val json = edited("today.json") { it.put("finished", "no") }
        val failure = assertThrows(GlanceParseException::class.java) { GlanceParser.parse(json) }
        assertTrue(failure.message, failure.message!!.contains("finished"))
    }

    /**
     * A verdict word a newer server adds is not guessed at, and does not freeze the app on a stale
     * glance either: it reads as not judged, and the rest of the payload lands.
     */
    @Test
    fun `a verdict word the app does not know reads as not judged`() {
        val json = edited("today.json") {
            it.getJSONObject("sleep").getJSONObject("asleep").put("standing", "sideways")
            it.getJSONObject("recovery").put("band", "stellar")
            it.getJSONObject("day").getJSONObject("stepsPace").put("standing", "sprinting")
        }
        val glance = GlanceParser.parse(json)
        assertNull(checkNotNull(glance.sleep).asleep.standing)
        assertNull(glance.recovery.band)
        assertNull(checkNotNull(glance.day.stepsPace).standing)
        assertEquals(420.0, checkNotNull(glance.sleep).asleep.value)

        val calendar = edited("calendar.json") {
            it.getJSONArray("days").getJSONObject(18).put("sleep", "dreamy").put("steps", "soaring")
        }
        assertEquals(CalendarDay("2026-08-19", null, null), GlanceParser.parseCalendar(calendar).days[18])
    }

    /** The fixtures carry each of these at one value only, so each read is proven at the other. */
    @Test
    fun `flags and offsets the fixtures hold at one value land at the other`() {
        val json = edited("today.json") {
            val sleep = it.getJSONObject("sleep")
            sleep.put("endOffsetMinutes", 60)
            sleep.getJSONObject("asleep").getJSONObject("baseline").put("thin", true)
            val day = it.getJSONObject("day")
            day.getJSONObject("stepsPace").put("thin", true)
            day.getJSONObject("heartRate").getJSONArray("points").getJSONObject(0).put("excluded", true)
            day.getJSONArray("workouts").getJSONObject(0)
                .put("excluded", true)
                .put("excludeReason", "Wore it on the bike")
                .put("alternateIds", JSONArray().put("phone-run"))
                .put("endOffsetMinutes", 60)
        }
        val glance = GlanceParser.parse(json)
        val sleep = checkNotNull(glance.sleep)
        assertEquals(60, sleep.endOffsetMinutes)
        assertEquals(120, sleep.startOffsetMinutes)
        assertTrue(checkNotNull(sleep.asleep.baseline).thin)
        assertTrue(checkNotNull(glance.day.stepsPace).thin)
        assertTrue(glance.day.heartRate.points[0].excluded)
        val run = glance.day.workouts.single()
        assertTrue(run.excluded)
        assertEquals("Wore it on the bike", run.excludeReason)
        assertEquals(listOf("phone-run"), run.alternateIds)
        assertEquals(60, run.endOffsetMinutes)
        assertEquals(120, run.startOffsetMinutes)
    }

    @Test
    fun `fields the app does not know are ignored`() {
        val json = edited("today.json") {
            it.put("somethingNew", JSONObject().put("x", 1))
            it.getJSONObject("day").getJSONObject("steps").put("trend", "up")
        }
        assertEquals(today, GlanceParser.parse(json))
    }

    @Test
    fun `a stage the app has no row for is kept as sent`() {
        val json = edited("today.json") {
            it.getJSONObject("sleep").getJSONArray("segments").getJSONObject(0).put("stage", "OUT_OF_BED")
        }
        assertEquals("OUT_OF_BED", checkNotNull(GlanceParser.parse(json).sleep).segments[0].stage)
    }

    @Test
    fun `a stale source lands with its name and gap`() {
        val json = edited("today.json") {
            it.getJSONObject("day").getJSONObject("steps").put(
                "staleSources",
                JSONArray().put(
                    JSONObject().put("sourceId", "w1").put("name", "My watch")
                        .put("lastReportedDate", "2026-07-31").put("medianGapDays", 1),
                ),
            )
        }
        assertEquals(
            listOf(GlanceStaleSource("w1", "My watch", "2026-07-31", 1.0)),
            GlanceParser.parse(json).day.steps.staleSources,
        )
    }

    /** The web reads both with a fallback: a response from before the merge carries neither. */
    @Test
    fun `a workout without sources or alternate ids is its own source alone`() {
        val json = edited("today.json") {
            val run = it.getJSONObject("day").getJSONArray("workouts").getJSONObject(0)
            run.remove("sources")
            run.remove("alternateIds")
        }
        val run = GlanceParser.parse(json).day.workouts.single()
        assertEquals(listOf("watch"), run.sources)
        assertEquals(emptyList<String>(), run.alternateIds)
    }

    /**
     * workoutSummary.ts's rules: absent or blank is null, a recorded zero is zero, and attrs that
     * are not an object are no fields at all.
     */
    @Test
    fun `a workout's attrs read absent as null and zero as zero`() {
        val json = edited("today.json") {
            val run = it.getJSONObject("day").getJSONArray("workouts").getJSONObject(0)
            val metrics = JSONObject().put("caloriesKcal", 0).put("averageHeartRateBeatsPerMinute", " ")
            run.put("attrs", JSONObject().put("metricsSummary", metrics))
        }
        assertEquals(
            WorkoutSummary(null, caloriesKcal = 0.0, averageHeartRateBpm = null, null, null, null),
            GlanceParser.parse(json).day.workouts.single().summary,
        )
        val notAnObject = edited("today.json") {
            it.getJSONObject("day").getJSONArray("workouts").getJSONObject(0).put("attrs", JSONObject.NULL)
        }
        assertEquals(
            WorkoutSummary(null, null, null, null, null, null),
            GlanceParser.parse(notAnObject).day.workouts.single().summary,
        )
    }

    @Test
    fun `a body that is not JSON fails the parse`() {
        assertThrows(GlanceParseException::class.java) { GlanceParser.parse("<html>") }
        assertThrows(GlanceParseException::class.java) { GlanceParser.parseCalendar("") }
        assertThrows(GlanceParseException::class.java) { GlanceParser.parseDayLog("[]") }
    }

    @Test
    fun `a calendar day without its sleep dot fails the parse, naming it`() {
        val json = edited("calendar.json") { it.getJSONArray("days").getJSONObject(0).remove("sleep") }
        val failure = assertThrows(GlanceParseException::class.java) { GlanceParser.parseCalendar(json) }
        assertTrue(failure.message, failure.message!!.contains("days[0].sleep"))
    }

    @Test
    fun `a log lands the same on the glance and on its own`() {
        val onGlance = checkNotNull(GlanceParser.parse(fixture("today-quick-log.json")).log)
        val alone = GlanceParser.parseDayLog(JSONObject(fixture("today-quick-log.json")).getJSONObject("log").toString())
        assertEquals(onGlance, alone)
    }
}
