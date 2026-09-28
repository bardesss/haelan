package com.haelan.android.glance.format

import com.haelan.android.glance.geometry.StepsDot
import com.haelan.android.glance.geometry.SleepDot
import com.haelan.android.glance.GlanceStanding
import com.haelan.android.glance.GlanceStepsPace
import com.haelan.android.glance.GlanceWeek
import com.haelan.android.glance.GlanceWeekFigure
import com.haelan.android.glance.PaceStanding
import com.haelan.android.glance.RecoveryBand
import com.haelan.android.glance.baseline
import com.haelan.android.glance.day
import com.haelan.android.glance.figure
import com.haelan.android.glance.geometry.HypnoStage
import com.haelan.android.glance.geometry.StageTotal
import com.haelan.android.glance.glance
import com.haelan.android.glance.recovery
import com.haelan.android.glance.sleep
import com.haelan.android.glance.stripDay
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant
import java.time.ZoneId
import java.util.Locale

/**
 * Every sentence the glance prints, whole, in English and in Dutch, from the web's own text. The
 * verdict each one words is the figure's `standing` (or the pace's, or the band); the values sit on
 * whichever side of their band suits the test, since no sentence may be picked by comparing them.
 */
class GlanceWordsTest {

    private val amsterdam = ZoneId.of("Europe/Amsterdam")
    private val english = GlanceWords(MapStrings(ENGLISH_TEXT), Locale.ENGLISH, amsterdam)
    private val dutch = GlanceWords(MapStrings(DUTCH_TEXT), Locale.forLanguageTag("nl"), amsterdam)
    private fun ms(iso: String) = Instant.parse(iso).toEpochMilli()

    // 11:40 in Amsterdam on the glance's day.
    private val elevenForty = ms("2026-08-20T09:40:00Z")

    private val steps = baseline(low = 6800.0, high = 10400.0, center = 8600.0)

    @Test
    fun `a figure prints the way its metric reads`() {
        assertEquals("1,827", english.figure(figure("steps", 1827.0)))
        assertEquals("1.827", dutch.figure(figure("steps", 1827.0)))
        assertEquals("6h 36m", english.figure(figure("sleep_asleep_minutes", 396.0)))
        assertEquals("23:40", english.figure(figure("sleep_bedtime_minutes", -20.0)))
        assertEquals("46", english.figure(figure("active_minutes", 45.6)))
        assertEquals("14.2", english.figure(figure("respiratory_rate", 14.2)))
        assertEquals("14,2", dutch.figure(figure("respiratory_rate", 14.2)))
        assertNull(english.figure(figure("steps", null)))
    }

    @Test
    fun `a percentage carries the unit after a space`() {
        assertEquals("92 %", english.percent(92.0))
        assertEquals("92 %", dutch.percent(92.0))
    }

    @Test
    fun `within its usual, in both languages`() {
        val f = figure("steps", 9000.0, steps, GlanceStanding.WITHIN)
        assertEquals("within your usual 6,800 – 10,400", english.usualLine(f))
        assertEquals("binnen je gebruikelijke bereik 6.800 – 10.400", dutch.usualLine(f))
    }

    @Test
    fun `above its usual is the server's word, whatever the value`() {
        // A value inside the band: only `standing` may say above.
        val f = figure("steps", 9000.0, steps, GlanceStanding.ABOVE)
        assertEquals("above your usual 6,800 – 10,400", english.usualLine(f))
        assertEquals("boven je gebruikelijke bereik 6.800 – 10.400", dutch.usualLine(f))
    }

    @Test
    fun `below its usual is the server's word, whatever the value`() {
        val f = figure("steps", 9000.0, steps, GlanceStanding.BELOW)
        assertEquals("below your usual 6,800 – 10,400", english.usualLine(f))
        assertEquals("onder je gebruikelijke bereik 6.800 – 10.400", dutch.usualLine(f))
    }

    @Test
    fun `an unjudged figure reads as within rather than inventing a side`() {
        val f = figure("steps", 20000.0, steps, standing = null)
        assertEquals("within your usual 6,800 – 10,400", english.usualLine(f))
    }

    @Test
    fun `a thin usual outranks the verdict and the partial day`() {
        val f = figure("steps", 9000.0, baseline(6800.0, 10400.0, thin = true), GlanceStanding.ABOVE, partial = true)
        assertEquals("not enough history for a usual yet", english.usualLine(f))
        assertEquals("nog te weinig geschiedenis voor een gebruikelijke waarde", dutch.usualLine(f))
    }

    @Test
    fun `a partial day reads so far, never as a shortfall`() {
        val f = figure("steps", 900.0, steps, GlanceStanding.BELOW, partial = true)
        assertEquals("so far; your usual day 8,600", english.usualLine(f))
        assertEquals("tot nu toe; op een gewone dag 8.600", dutch.usualLine(f))
    }

    @Test
    fun `the usual's edges print as the value does`() {
        val f = figure("sleep_asleep_minutes", 400.0, baseline(422.0, 438.0), GlanceStanding.WITHIN)
        assertEquals("within your usual 7h 02m – 7h 18m", english.usualLine(f))
    }

    @Test
    fun `no usual line without a value or a baseline`() {
        assertNull(english.usualLine(figure("steps", null, steps, GlanceStanding.WITHIN)))
        assertNull(english.usualLine(figure("steps", 9000.0, null, GlanceStanding.WITHIN)))
    }

    @Test
    fun `a finished day's verdict and the range it was judged against`() {
        val f = figure("steps", 12000.0, steps, GlanceStanding.ABOVE)
        assertEquals(
            TodayLine.Verdict(GlanceStanding.ABOVE, "Above your usual day", "usual 6,800 – 10,400"),
            english.dayStandingLine(f),
        )
        assertEquals(
            TodayLine.Verdict(GlanceStanding.ABOVE, "Meer dan op een gewone dag", "normaal 6.800 – 10.400"),
            dutch.dayStandingLine(f),
        )
        assertEquals("Minder dan op een gewone dag", dutch.dayStandingLine(f.copy(standing = GlanceStanding.BELOW))?.word)
        assertEquals("Within your usual day", english.dayStandingLine(f.copy(standing = GlanceStanding.WITHIN))?.word)
    }

    @Test
    fun `no day verdict on a thin usual or an unjudged day`() {
        assertNull(english.dayStandingLine(figure("steps", 12000.0, baseline(1.0, 2.0, thin = true), GlanceStanding.ABOVE)))
        assertNull(english.dayStandingLine(figure("steps", 12000.0, steps, standing = null)))
    }

    private fun pace(standing: PaceStanding?) =
        GlanceStepsPace(center = 5900.0, low = 4000.0, high = 7000.0, thin = false, value = 3000.0, atMs = elevenForty, standing = standing)

    @Test
    fun `the pace line in both languages, its time in the person's zone`() {
        assertEquals(
            TodayLine.Pace(PaceStanding.AHEAD, "Ahead of your usual pace", "usual by 11:40 is 5,900"),
            english.paceLine(pace(PaceStanding.AHEAD)),
        )
        assertEquals(
            TodayLine.Pace(PaceStanding.AHEAD, "Vóór op je gebruikelijke tempo", "normaal zit je om 11:40 op 5.900"),
            dutch.paceLine(pace(PaceStanding.AHEAD)),
        )
        assertEquals("On your usual pace", english.paceLine(pace(PaceStanding.ON))?.word)
        assertEquals("Achter op je gebruikelijke tempo", dutch.paceLine(pace(PaceStanding.BEHIND))?.word)
    }

    @Test
    fun `no pace line before the server judges`() {
        assertNull(english.paceLine(pace(null)))
        assertNull(english.paceLine(null))
    }

    @Test
    fun `today's line is the pace, a finished day's the verdict, and the so-far line otherwise`() {
        val stepsToday = figure("steps", 12000.0, steps, GlanceStanding.ABOVE, partial = true)
        val today = day(steps = stepsToday, stepsPace = pace(PaceStanding.AHEAD))
        assertEquals("Ahead of your usual pace", (english.todayLine(today, finished = false) as TodayLine.Pace).word)
        val over = day(steps = stepsToday.copy(partial = false), stepsPace = pace(PaceStanding.AHEAD))
        assertEquals("Above your usual day", (english.todayLine(over, finished = true) as TodayLine.Verdict).word)
        val unjudged = day(steps = stepsToday, stepsPace = pace(null))
        assertEquals(TodayLine.Usual("so far; your usual day 8,600"), english.todayLine(unjudged, finished = false))
        assertNull(english.todayLine(day(steps = figure("steps", 10.0)), finished = false))
    }

    @Test
    fun `as of a time today, in both languages`() {
        val f = figure("steps", 10.0, asOfDate = "2026-08-20", asOfMs = elevenForty)
        assertEquals("as of 11:40", english.asOfLine(f, "2026-08-20"))
        assertEquals("bijgewerkt om 11:40", dutch.asOfLine(f, "2026-08-20"))
    }

    @Test
    fun `as of a day, and a finished day's words for it`() {
        val today = figure("daily_hrv", 48.0, asOfDate = "2026-08-20")
        val yesterday = figure("daily_hrv", 48.0, asOfDate = "2026-08-19")
        assertEquals("today", english.asOfLine(today, "2026-08-20"))
        assertEquals("gisteren", dutch.asOfLine(yesterday, "2026-08-20"))
        assertEquals("that day", english.asOfLine(today.copy(asOfMs = elevenForty), "2026-08-20", finished = true))
        assertEquals("de dag ervoor", dutch.asOfLine(yesterday, "2026-08-20", finished = true))
        assertNull(english.asOfLine(figure("daily_hrv", 48.0, asOfDate = "2026-08-17"), "2026-08-20"))
        assertNull(english.asOfLine(figure("daily_hrv", null, asOfDate = "2026-08-20"), "2026-08-20"))
    }

    @Test
    fun `a sleep figure is as of its night, whatever instant it carries`() {
        val f = figure("sleep_asleep_minutes", 420.0, asOfDate = "2026-09-05", asOfMs = elevenForty)
        assertEquals("night of Sep 5", english.asOfLine(f, "2026-09-05", night = true))
        assertEquals("nacht van 5 sep", dutch.asOfLine(f, "2026-09-05", night = true))
    }

    @Test
    fun `the span line's four cases, in both languages`() {
        val withTime = day(heartRateAsOfMs = elevenForty)
        assertEquals("last night, and today until 11:40", english.spanLine(glance(day = withTime)))
        assertEquals("afgelopen nacht, en vandaag tot 11:40", dutch.spanLine(glance(day = withTime)))
        assertEquals("last night, and today so far", english.spanLine(glance()))
        assertEquals("afgelopen nacht, en vandaag tot nu toe", dutch.spanLine(glance()))
        assertEquals("no night recorded · today until 11:40", english.spanLine(glance(sleep = null, day = withTime)))
        assertEquals("afgelopen nacht niet gemeten · vandaag tot 11:40", dutch.spanLine(glance(sleep = null, day = withTime)))
        assertEquals("no night recorded · today so far", english.spanLine(glance(sleep = null)))
        assertEquals("afgelopen nacht niet gemeten · vandaag tot nu toe", dutch.spanLine(glance(sleep = null)))
    }

    @Test
    fun `the span's time falls back to steps when the day has no heart rate`() {
        val stepsOnly = day(steps = figure("steps", 10.0, asOfMs = elevenForty))
        assertEquals("last night, and today until 11:40", english.spanLine(glance(day = stepsOnly)))
    }

    @Test
    fun `a past day's line, and the line under the title`() {
        assertEquals("that night, and the whole day", english.pastLine(glance(finished = true)))
        assertEquals("die nacht, en de hele dag", dutch.pastLine(glance(finished = true)))
        assertEquals("no night recorded · the whole day", english.pastLine(glance(sleep = null, finished = true)))
        assertEquals("die nacht niet gemeten · de hele dag", dutch.pastLine(glance(sleep = null, finished = true)))
        assertEquals("that night, and the whole day", english.headerLine(glance(finished = true)))
        assertEquals(
            "donderdag 20 augustus · afgelopen nacht, en vandaag tot 11:40",
            dutch.headerLine(glance(day = day(heartRateAsOfMs = elevenForty))),
        )
    }

    @Test
    fun `the greeting by the hour in the person's zone`() {
        // 03:30 UTC is 05:30 in Amsterdam and 23:30 the evening before in New York.
        val at = ms("2026-09-05T03:30:00Z")
        assertEquals("Good morning", english.greeting(at))
        assertEquals("Goedemorgen", dutch.greeting(at))
        val newYork = GlanceWords(MapStrings(ENGLISH_TEXT), Locale.ENGLISH, ZoneId.of("America/New_York"))
        assertEquals("Good evening", newYork.greeting(at))
        assertEquals("Goedemiddag", dutch.greeting(ms("2026-09-05T11:00:00Z")))
    }

    @Test
    fun `the night's subtitle in the person's zone`() {
        val night = sleep(startMs = ms("2026-09-05T21:30:00Z"), endMs = ms("2026-09-06T05:00:00Z"))
        assertEquals("Sat, Sep 5 – Sun, Sep 6", english.nightRange(night))
        assertEquals("za 5 – zo 6 sep", dutch.nightRange(night))
    }

    @Test
    fun `a small sleep figure outside its usual says which way`() {
        val late = figure("sleep_bedtime_minutes", -20.0, standing = GlanceStanding.ABOVE)
        assertEquals("later than usual", english.miniNote(SleepMini.BED, late))
        assertEquals("later dan gewoonlijk", dutch.miniNote(SleepMini.BED, late))
        val low = figure("sleep_efficiency", 80.0, standing = GlanceStanding.BELOW)
        assertEquals("lower than usual", english.miniNote(SleepMini.EFFICIENCY, low))
        assertEquals("eerder dan gewoonlijk", dutch.miniNote(SleepMini.WOKE, low))
        assertNull(english.miniNote(SleepMini.BED, late.copy(standing = GlanceStanding.WITHIN)))
        assertNull(english.miniNote(SleepMini.BED, late.copy(standing = null)))
    }

    @Test
    fun `the recovery subtitle names the index's day`() {
        val today = recovery(figure("recovery_index", 62.0, asOfDate = "2026-08-20"))
        val yesterday = recovery(figure("recovery_index", 62.0, asOfDate = "2026-08-19"))
        assertEquals("today", english.recoverySubtitle(today, "2026-08-20", finished = false))
        assertEquals("gisteren", dutch.recoverySubtitle(yesterday, "2026-08-20", finished = false))
        assertEquals("die dag", dutch.recoverySubtitle(today, "2026-08-20", finished = true))
        assertEquals("the day before", english.recoverySubtitle(yesterday, "2026-08-20", finished = true))
        assertNull(english.recoverySubtitle(recovery(figure("recovery_index", null)), "2026-08-20", finished = false))
    }

    @Test
    fun `the band's words, from the server's band`() {
        assertEquals("Around your usual", english.bandWords(RecoveryBand.USUAL))
        assertEquals("Ruim onder gebruikelijk", dutch.bandWords(RecoveryBand.LOW))
        assertNull(english.bandWords(null))
    }

    @Test
    fun `the breathing note carries its value and unit`() {
        val f = figure("respiratory_rate", 14.2)
        assertEquals("Breathing rate 14.2 breaths/min, above your usual", english.respiratoryLine(f))
        assertEquals("Ademhaling 14,2 ademh./min, boven je gebruikelijke waarde", dutch.respiratoryLine(f))
        assertNull(english.respiratoryLine(null))
    }

    @Test
    fun `the hypnogram's totals line, or the not-staged sentence`() {
        val totals = listOf(StageTotal(HypnoStage.DEEP, 100), StageTotal(HypnoStage.LIGHT, 230))
        assertEquals("Deep 1h 40m · Light 3h 50m", english.stageTotalsLine(totals))
        assertEquals("Diep 1h 40m · Licht 3h 50m", dutch.stageTotalsLine(totals))
        assertEquals("This night was not staged, so there is nothing to total.", english.stageTotalsLine(emptyList()))
        assertEquals("Deze nacht is niet in fasen ingedeeld, dus is er niets te tellen.", dutch.stageTotalsLine(emptyList()))
    }

    private val strip = listOf(stripDay("2026-08-19", 9000.0), stripDay("2026-08-20", 5900.0))
    private val week = GlanceWeek(
        steps = GlanceWeekFigure(perDay = 8205.4, days = 6, total = 57432.0),
        activeMinutes = GlanceWeekFigure(perDay = 35.2, days = 6, total = 245.0),
        asleep = GlanceWeekFigure(perDay = 412.0, days = 7, total = 2884.0),
    )
    private val weekGlance = glance(
        day = day(steps = figure("steps", 5900.0, strip = strip), activeMinutes = figure("active_minutes", 30.0, strip = strip)),
        sleep = sleep(asleep = figure("sleep_asleep_minutes", 420.0, strip = strip)),
        week = week,
    )

    @Test
    fun `the week's rows in English`() {
        val rows = english.weekLines(weekGlance)
        assertEquals(listOf(WeekRowKind.STEPS, WeekRowKind.ACTIVE, WeekRowKind.ASLEEP), rows.map { it.kind })
        assertEquals(listOf("Steps", "57,432", "· 8,205 a day"), rows[0].let { listOf(it.label, it.value, it.per) })
        assertEquals(
            "Steps, last 7 days; the average counts finished days only, today not counted",
            rows[0].barsLabel,
        )
        assertEquals(listOf("Active", "4h 05m", "· 35 min a day"), rows[1].let { listOf(it.label, it.value, it.per) })
        assertEquals(listOf("Asleep", "6h 52m", "a night"), rows[2].let { listOf(it.label, it.value, it.per) })
        assertEquals("Asleep, last 7 nights; the average includes last night", rows[2].barsLabel)
        assertEquals(listOf(9000.0, 5900.0), rows[0].values)
        assertEquals(listOf("2026-08-19", "2026-08-20"), rows[0].dates)
    }

    @Test
    fun `the week's rows in Dutch, and on a finished day`() {
        val rows = dutch.weekLines(weekGlance.copy(finished = true))
        assertEquals(listOf("Stappen", "57.432", "· 8.205 per dag"), rows[0].let { listOf(it.label, it.value, it.per) })
        assertEquals("Stappen, de 7 dagen tot en met die dag; het gemiddelde telt elke getoonde dag mee", rows[0].barsLabel)
        assertEquals("· 35 min per dag", rows[1].per)
        assertEquals("per nacht", rows[2].per)
        assertEquals("Slaaptijd, de 7 nachten tot en met die dag; die nacht telt mee in het gemiddelde", rows[2].barsLabel)
    }

    @Test
    fun `a week row without a figure, or sleep without a night, is left out`() {
        val noSleep = english.weekLines(weekGlance.copy(sleep = null, week = week.copy(steps = null)))
        assertEquals(listOf(WeekRowKind.ACTIVE), noSleep.map { it.kind })
    }

    @Test
    fun `a bar's value prints as its row does`() {
        assertEquals("9,840", english.weekBarValue(WeekRowKind.STEPS, 9840.0))
        assertEquals("9.840", dutch.weekBarValue(WeekRowKind.STEPS, 9840.0))
        assertEquals("42 min", english.weekBarValue(WeekRowKind.ACTIVE, 41.6))
        assertEquals("7h 00m", english.weekBarValue(WeekRowKind.ASLEEP, 420.0))
    }

    @Test
    fun `the offline line dates the glance in the person's zone`() {
        // 07:42 in Amsterdam is 05:42 UTC in summer.
        val at = ms("2026-08-20T05:42:00Z")
        val later = ms("2026-08-20T09:00:00Z")
        assertEquals("Shown from 07:42, not reachable", english.offlineLine(at, later))
        assertEquals("Weergegeven van 07:42, niet bereikbaar", dutch.offlineLine(at, later))
        val london = GlanceWords(MapStrings(ENGLISH_TEXT), Locale.ENGLISH, ZoneId.of("Europe/London"))
        assertEquals("Shown from 06:42, not reachable", london.offlineLine(at, later))
    }

    @Test
    fun `a glance confirmed on another day names that day, so last night's is not read as this morning's`() {
        // 23:10 in Amsterdam on the 19th, read at 07:30 on the 20th.
        val lastNight = ms("2026-08-19T21:10:00Z")
        val morning = ms("2026-08-20T05:30:00Z")
        assertEquals("Shown from Wed, Aug 19 23:10, not reachable", english.offlineLine(lastNight, morning))
        assertEquals("Weergegeven van wo 19 aug 23:10, niet bereikbaar", dutch.offlineLine(lastNight, morning))
        // The day is the person's: 22:30 UTC is already the 20th in Amsterdam, still the 19th in London.
        val halfPastMidnight = ms("2026-08-19T22:30:00Z")
        assertEquals("Shown from 00:30, not reachable", english.offlineLine(halfPastMidnight, morning))
        val london = GlanceWords(MapStrings(ENGLISH_TEXT), Locale.ENGLISH, ZoneId.of("Europe/London"))
        assertEquals("Shown from Wed, Aug 19 23:30, not reachable", london.offlineLine(halfPastMidnight, morning))
    }

    @Test
    fun `while a past day loads the line is already that day's, its night unknown yet`() {
        val today = glance(day = day(heartRateAsOfMs = elevenForty))
        assertEquals("that night, and the whole day", english.dayLine(today.copy(sleep = null), "2026-08-18", stepping = true))
        assertEquals("die nacht, en de hele dag", dutch.dayLine(today, "2026-08-18", stepping = true))
        // Settled, or stepping back to today, it is the glance's own line.
        assertEquals(english.headerLine(today), english.dayLine(today, null, stepping = false))
        assertEquals(english.headerLine(today), english.dayLine(today, null, stepping = true))
        val past = glance(today = "2026-08-18", sleep = null, finished = true)
        assertEquals("no night recorded · the whole day", english.dayLine(past, "2026-08-18", stepping = false))
    }

    @Test
    fun `a calendar day is heard with its date and both verdicts, a grey one as no data`() {
        assertEquals(
            "Tuesday, August 18, slept in your usual range, steps below your usual",
            english.calendarDay("2026-08-18", SleepDot.WITHIN, StepsDot.BELOW),
        )
        assertEquals(
            "Tuesday, August 18, slept outside your usual range, steps reached your usual",
            english.calendarDay("2026-08-18", SleepDot.OUTSIDE, StepsDot.REACHED),
        )
        assertEquals(
            "dinsdag 18 augustus, slaap niet beoordeeld, stappen niet beoordeeld",
            dutch.calendarDay("2026-08-18", SleepDot.NOT_JUDGED, StepsDot.NOT_JUDGED),
        )
        assertEquals("Tuesday, August 18, no data", english.calendarDay("2026-08-18", null, null))
        assertEquals("dinsdag 18 augustus, geen gegevens", dutch.calendarDay("2026-08-18", null, null))
    }
}
