package com.haelan.android.glance.format

import com.haelan.android.glance.Glance
import com.haelan.android.glance.GlanceBaseline
import com.haelan.android.glance.GlanceDay
import com.haelan.android.glance.GlanceFigure
import com.haelan.android.glance.GlanceHeartRate
import com.haelan.android.glance.GlanceRecovery
import com.haelan.android.glance.GlanceSleep
import com.haelan.android.glance.GlanceStanding
import com.haelan.android.glance.GlanceStepsPace
import com.haelan.android.glance.PaceStanding
import com.haelan.android.glance.RecoveryBand
import com.haelan.android.glance.geometry.SleepDot
import com.haelan.android.glance.geometry.StageTotal
import com.haelan.android.glance.geometry.StepsDot
import java.math.RoundingMode
import java.text.NumberFormat
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale
import kotlin.math.roundToLong

// The glance's words: every sentence and every number the cards print, worded the way the web's
// apps/web/src/pages/dashboard/glanceText.ts and the four card components word them. The verdicts
// are the payload's (`standing`, the pace's `standing`, the recovery `band`); nothing here compares
// a value with a band, it only picks the sentence the server's verdict names.

/**
 * Where the sentences come from: Android resources on a phone, a map of the web's en and nl text in
 * a test. Keys are the web's key path in snake case under the same prefix (`glance.usual.within` is
 * `glance_usual_within`, `recoveryIndex.band.low` is `recovery_index_band_low`), so a key here and
 * its resource name are one name. Placeholders stay the web's own named `{{low}}`, filled by [fill],
 * so a translation can put them in any order and the text is copied from the web JSON verbatim.
 */
fun interface Strings {
    fun get(key: String, args: Map<String, String>): String

    companion object {
        /** The web's `{{name}}` placeholders filled from [args]; a name not in the text is ignored. */
        fun fill(template: String, args: Map<String, String>): String =
            args.entries.fold(template) { text, (name, value) -> text.replace("{{$name}}", value) }
    }
}

/**
 * The locale- and zone-only formatters, the web's format.ts and glanceText.ts helpers that take no
 * sentence. Dates are the payload's local dates read as calendar days (no zone can move one), and
 * instants are read in the person's zone, never the phone's: two people looking at one glance from
 * two zones read the same clock times the web would show each of them.
 */
object GlanceFormat {

    /** Minutes as "6h 36m", the minutes always two digits: the web's formatDuration. */
    fun duration(minutes: Double): String {
        val total = Math.round(minutes)
        return "${Math.floorDiv(total, 60L)}h ${Math.floorMod(total, 60L).toString().padStart(2, '0')}m"
    }

    /**
     * Minutes from local midnight as a 24-hour "HH:mm", wrapped into one day: a bed time of -20 (the
     * bed-time convention's 23:40) reads 23:40. The web's formatClock.
     */
    fun clock(minutesPastMidnight: Double): String {
        val total = Math.floorMod(Math.round(minutesPastMidnight), 1440L)
        return "${(total / 60).toString().padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}"
    }

    /**
     * An instant as a 24-hour "HH:mm" in the person's [zone]: the web's formatTimeOfDay, which forces
     * a 24-hour clock in every language so an as-of time never reads as a different kind of fact
     * beside a bed time.
     */
    fun clock(atMs: Long, zone: ZoneId): String =
        DateTimeFormatter.ofPattern("HH:mm", Locale.ROOT).withZone(zone).format(Instant.ofEpochMilli(atMs))

    /**
     * A number grouped the locale's way (1,827 in English, 1.827 in Dutch) with exactly [precision]
     * decimals, half rounded away from zero as the web's toLocaleString does; NumberFormat's own
     * default is half-even, which would print 12.5 as 12 where the web prints 13.
     */
    fun number(value: Double, locale: Locale, precision: Int = 0): String {
        val format = NumberFormat.getNumberInstance(locale)
        format.minimumFractionDigits = precision
        format.maximumFractionDigits = precision
        format.isGroupingUsed = true
        format.roundingMode = RoundingMode.HALF_UP
        return format.format(value)
    }

    /** A local date as the page's long date: "Wednesday, September 23", "woensdag 23 september". */
    fun longDate(localDate: String, locale: Locale): String = date(localDate, patterns(locale).long, locale)

    /** A local date as a "night of" clause reads it, month and day alone: "Sep 5", "5 sep". */
    fun shortDate(localDate: String, locale: Locale): String = date(localDate, patterns(locale).monthDay, locale)

    /**
     * A past day's title: the long date, or on a phone the short one ("Tue, Sep 22", "di 22 sep"),
     * the web's formatHeaderDate.
     */
    fun headerDate(localDate: String, locale: Locale, short: Boolean): String =
        if (short) date(localDate, patterns(locale).short, locale) else longDate(localDate, locale)

    /**
     * A night's two dates as the Last night card's subtitle, in the person's zone: "Sat, Sep 5 – Sun,
     * Sep 6", "za 5 – zo 6 sep", one date for a night that starts after midnight. The web hands this
     * to Intl's formatRange, which has no JVM twin, so its three outputs are written out here: English
     * repeats the month, Dutch collapses a shared one, both add the year only when the two differ,
     * and the dash is an en dash between thin spaces, as ICU writes it.
     */
    fun nightRange(startMs: Long, endMs: Long, zone: ZoneId, locale: Locale): String {
        val p = patterns(locale)
        val start = Instant.ofEpochMilli(startMs).atZone(zone).toLocalDate()
        val end = Instant.ofEpochMilli(endMs).atZone(zone).toLocalDate()
        val short = DateTimeFormatter.ofPattern(p.short, locale)
        if (start == end) return short.format(start)
        if (start.year != end.year) {
            val withYear = DateTimeFormatter.ofPattern(p.shortWithYear, locale)
            return withYear.format(start) + RANGE_DASH + withYear.format(end)
        }
        val first = if (p.collapsesMonth && start.month == end.month) p.weekdayDay else p.short
        return DateTimeFormatter.ofPattern(first, locale).format(start) + RANGE_DASH + short.format(end)
    }

    /**
     * The greeting's key by the hour in the person's zone: morning 05-12, afternoon 12-18, evening
     * otherwise, the web's greetingKey.
     */
    fun greetingKey(hour: Int): String = when (hour) {
        in 5..11 -> "glance_greeting_morning"
        in 12..17 -> "glance_greeting_afternoon"
        else -> "glance_greeting_evening"
    }

    private const val RANGE_DASH = " – "

    /**
     * The calendar's month title for [month] (YYYY-MM): "September 2026", "september 2026", Intl's
     * long month and numeric year. The stand-alone month form, as Intl uses for a month with no day.
     */
    fun monthTitle(month: String, locale: Locale): String =
        DateTimeFormatter.ofPattern("LLLL y", locale).format(YearMonth.parse(month))

    /**
     * The calendar's column heads, Monday first: the short weekday's first two letters ("Mo",
     * "ma") as the web slices them, and the full name a screen reader hears.
     */
    fun weekdays(locale: Locale): List<Pair<String, String>> = DayOfWeek.entries.map {
        it.getDisplayName(TextStyle.SHORT, locale).take(2) to it.getDisplayName(TextStyle.FULL, locale)
    }

    private class Patterns(
        val long: String,
        val short: String,
        val shortWithYear: String,
        val weekdayDay: String,
        val monthDay: String,
        val collapsesMonth: Boolean,
    )

    // What Intl writes for the web's option sets, per language: the JVM has no skeleton formatter
    // (Android's getBestDateTimePattern is not on it), so the two languages the app speaks are
    // written out, English the fallback. The names inside ("Sep", "sep", "za") are CLDR's.
    private val ENGLISH = Patterns(
        long = "EEEE, MMMM d",
        short = "EEE, MMM d",
        shortWithYear = "EEE, MMM d, y",
        weekdayDay = "EEE, MMM d",
        monthDay = "MMM d",
        collapsesMonth = false,
    )
    private val DUTCH = Patterns(
        long = "EEEE d MMMM",
        short = "EEE d MMM",
        shortWithYear = "EEE d MMM y",
        weekdayDay = "EEE d",
        monthDay = "d MMM",
        collapsesMonth = true,
    )

    private fun patterns(locale: Locale): Patterns = if (locale.language == "nl") DUTCH else ENGLISH

    private fun date(localDate: String, pattern: String, locale: Locale): String =
        DateTimeFormatter.ofPattern(pattern, locale).format(LocalDate.parse(localDate))
}

/** Which of the Last night card's three small figures a standing note is for. */
enum class SleepMini(internal val key: String) { EFFICIENCY("efficiency"), BED("bed"), WOKE("woke") }

/** The Today card's line under its two figures: a finished day's verdict, today's pace, or the so-far line. */
sealed interface TodayLine {
    /** A finished day against the usual whole day: "Above your usual day" and "usual 6,800 – 10,400". */
    data class Verdict(val standing: GlanceStanding, val word: String, val range: String) : TodayLine

    /** Today against the usual pace: "Ahead of your usual pace" and "usual by 11:40 is 5,900". */
    data class Pace(val standing: PaceStanding, val word: String, val usualBy: String) : TodayLine

    /** No verdict to word: [usualLine][GlanceWords.usualLine]'s sentence stands in. */
    data class Usual(val text: String) : TodayLine
}

/** Which week row. */
enum class WeekRowKind { STEPS, ACTIVE, ASLEEP }

/**
 * One row of the week card: its figure ("57,432"), what follows it ("· 8,205 a day", or "a night"
 * for sleep, which has no total), the bars' accessible label, and the seven days the bars draw.
 */
data class WeekLine(
    val kind: WeekRowKind,
    val label: String,
    val value: String,
    val per: String,
    val barsLabel: String,
    val values: List<Double?>,
    val dates: List<String>,
)

/** The Recovery card's two gauges. */
enum class GaugeKind { RESTING_HEART_RATE, HRV }

/**
 * One gauge dial, everything the card places: the reading and the usual it is drawn against (null
 * when there is none or it is thin, which the web hands its gauge as no baseline, so the arc
 * centres on the value), the server's verdict for the marker, the dial's name and unit, the as-of
 * line when its day is not the index's, and the gauge's accessible description.
 */
data class GaugeDial(
    val value: Double,
    val baseline: GlanceBaseline?,
    val standing: GlanceStanding?,
    val name: String,
    val unit: String,
    val asOf: String?,
    val description: String,
)

/** Which seven-day strip. */
enum class StripKind { NIGHT, RECOVERY, STEPS }

/** A strip's chart name, the caption under it, and the sentence its description reads. */
data class StripText(val label: String, val caption: String, val description: String)

/**
 * Every sentence the glance prints, in one language and one zone. A phone builds one from its
 * resources, the person's timezone and the app's locale; a test builds one from the web's en or nl
 * text, so it asserts the whole sentence in both languages.
 */
class GlanceWords(
    private val strings: Strings,
    private val locale: Locale,
    private val zone: ZoneId,
) {

    private fun t(key: String, vararg args: Pair<String, String>): String = strings.get(key, args.toMap())

    /**
     * A raw number as a card prints it for [metric]: a duration for sleep minutes, a clock time for
     * bed and wake, a bare rounded count for active minutes and the recovery index, and otherwise the
     * catalogue's precision grouped by the locale. The one place a value and its usual's edges are
     * formatted, so the partial clause's centre reads the same way the value does (the web's
     * formatValue, and its reason for being one function).
     */
    fun value(value: Double, metric: String): String = when (metric) {
        "sleep_asleep_minutes" -> GlanceFormat.duration(value)
        "sleep_bedtime_minutes", "sleep_waketime_minutes" -> GlanceFormat.clock(value)
        "active_minutes", "recovery_index" -> value.roundToLong().toString()
        else -> GlanceFormat.number(value, locale, PRECISION[metric] ?: 0)
    }

    /** The figure's value as printed, or null when it has none: never a zero or a placeholder. */
    fun figure(figure: GlanceFigure): String? = figure.value?.let { value(it, figure.metric) }

    /** A percentage as the efficiency figure prints it: "92 %". */
    fun percent(value: Double): String = "${GlanceFormat.number(value, locale)} ${t("charts_units_percent")}"

    /**
     * The figure against its usual, in words, or null with nothing to say (no value, no baseline).
     * A thin baseline outranks everything; a partial day reads "so far" before any verdict is looked
     * at, so a day still running never reads as a shortfall; then the server's `standing` picks the
     * sentence, and a figure it left unjudged reads as within rather than inventing a side.
     */
    fun usualLine(figure: GlanceFigure): String? {
        val baseline = figure.baseline
        if (figure.value == null || baseline == null) return null
        if (baseline.thin) return t("glance_usual_thin")
        if (figure.partial) return t("glance_usual_partial", "center" to value(baseline.center, figure.metric))
        val low = "low" to value(baseline.low, figure.metric)
        val high = "high" to value(baseline.high, figure.metric)
        return when (figure.standing) {
            GlanceStanding.BELOW -> t("glance_usual_below", low, high)
            GlanceStanding.ABOVE -> t("glance_usual_above", low, high)
            GlanceStanding.WITHIN, null -> t("glance_usual_within", low, high)
        }
    }

    /**
     * A finished day's steps against the whole usual day, or null when there is no verdict to word
     * (no value, no baseline, a thin one, or no `standing`): the web's dayStanding.
     */
    fun dayStandingLine(figure: GlanceFigure): TodayLine.Verdict? {
        val baseline = figure.baseline
        val standing = figure.standing
        if (figure.value == null || baseline == null || baseline.thin || standing == null) return null
        return TodayLine.Verdict(
            standing = standing,
            word = t("glance_today_day_standing_${standing.name.lowercase()}"),
            range = t(
                "glance_today_usual_range",
                "low" to value(baseline.low, figure.metric),
                "high" to value(baseline.high, figure.metric),
            ),
        )
    }

    /**
     * Today's pace in words, or null on no pace or no verdict yet (the band can arrive before the
     * server will judge, under 5% of the usual day). The usual count is formatted as steps are.
     */
    fun paceLine(pace: GlanceStepsPace?): TodayLine.Pace? {
        val standing = pace?.standing ?: return null
        return TodayLine.Pace(
            standing = standing,
            word = t("glance_pace_${standing.name.lowercase()}"),
            usualBy = t(
                "glance_pace_usual_by",
                "time" to GlanceFormat.clock(pace.atMs, zone),
                "value" to value(pace.center, "steps"),
            ),
        )
    }

    /**
     * The Today card's line, chosen the way the card chooses it: a finished day's verdict, else
     * today's pace (never on a finished day, whatever the payload carries: a day that is over has no
     * "so far" to be ahead in), else the so-far line, else nothing.
     */
    fun todayLine(day: GlanceDay, finished: Boolean): TodayLine? {
        if (finished) dayStandingLine(day.steps)?.let { return it }
        if (!finished) paceLine(day.stepsPace)?.let { return it }
        return usualLine(day.steps)?.let { TodayLine.Usual(it) }
    }

    /**
     * What a figure is current to: "as of 11:32" for an instant on today, else today or yesterday
     * from its date, or for a sleep figure "night of Sep 5". A finished day's page says "that day"
     * and "the day before" and drops the clock time. Null with no value, or a day neither names.
     */
    fun asOfLine(figure: GlanceFigure, today: String, night: Boolean = false, finished: Boolean = false): String? {
        if (figure.value == null) return null
        val asOfDate = figure.asOfDate
        if (night) {
            if (asOfDate == null) return null
            return t("glance_as_of_night", "date" to GlanceFormat.shortDate(asOfDate, locale))
        }
        val asOfMs = figure.asOfMs
        if (asOfMs != null && asOfDate == today && !finished) {
            return t("glance_as_of_time", "time" to GlanceFormat.clock(asOfMs, zone))
        }
        if (asOfDate == today) return t(if (finished) "glance_as_of_that_day" else "glance_as_of_today")
        if (asOfDate == yesterdayOf(today)) return t(if (finished) "glance_as_of_day_before" else "glance_as_of_yesterday")
        return null
    }

    /**
     * The span half of today's line under the title: "last night, and today until 11:40", its time
     * the latest instant anything was read at (the heart rate trace, or steps on a day with no heart
     * rate), and a missing night said rather than opened on "last night".
     */
    fun spanLine(glance: Glance): String {
        val asOfMs = glance.day.heartRate.asOfMs ?: glance.day.steps.asOfMs
        val time = asOfMs?.let { GlanceFormat.clock(it, zone) }
        return if (glance.sleep == null) {
            if (time == null) t("glance_span_no_night_no_time") else t("glance_span_no_night", "time" to time)
        } else {
            if (time == null) t("glance_span_no_time") else t("glance_span", "time" to time)
        }
    }

    /** A past day's line under its title: "that night, and the whole day", or its no-night form. */
    fun pastLine(glance: Glance): String =
        t(if (glance.sleep == null) "glance_day_nav_past_line_no_night" else "glance_day_nav_past_line")

    /** The whole line under the title once a glance has settled: the long date and the span today, the past line on a finished day. */
    fun headerLine(glance: Glance): String =
        if (glance.finished) pastLine(glance) else "${GlanceFormat.longDate(glance.today, locale)} · ${spanLine(glance)}"

    /** The greeting for [nowMs] read in the person's zone. */
    fun greeting(nowMs: Long): String =
        t(GlanceFormat.greetingKey(Instant.ofEpochMilli(nowMs).atZone(zone).hour))

    /**
     * The line under the title, [stepping] included: while a past day loads over the previous day's
     * cards the line is already that day's, as the header is, and its no-night form waits for the
     * day's own answer, since the held cards' night is not the new day's (the web's Dashboard line).
     */
    fun dayLine(glance: Glance, shownDay: String?, stepping: Boolean): String =
        if (stepping && shownDay != null) t("glance_day_nav_past_line") else headerLine(glance)

    /**
     * The line over a glance the instance could not confirm: "Shown from 07:42, not reachable", the
     * time it was last confirmed, read in the person's zone.
     */
    fun offlineLine(fetchedAtMs: Long): String = t("glance_offline", "time" to GlanceFormat.clock(fetchedAtMs, zone))

    /**
     * A calendar day as a screen reader hears it: its long date and both verdicts in words, or "no
     * data" for a grey day ([sleep] and [steps] null), the web's dayName.
     */
    fun calendarDay(localDate: String, sleep: SleepDot?, steps: StepsDot?): String {
        val date = GlanceFormat.longDate(localDate, locale)
        if (sleep == null || steps == null) return t("glance_calendar_no_data", "date" to date)
        val sleepKey = when (sleep) {
            SleepDot.WITHIN -> "within"
            SleepDot.OUTSIDE -> "outside"
            SleepDot.NOT_JUDGED -> "none"
        }
        val stepsKey = when (steps) {
            StepsDot.REACHED -> "reached"
            StepsDot.BELOW -> "below"
            StepsDot.NOT_JUDGED -> "none"
        }
        return t(
            "glance_calendar_day",
            "date" to date,
            "sleep" to t("glance_calendar_spoken_sleep_$sleepKey"),
            "steps" to t("glance_calendar_spoken_steps_$stepsKey"),
        )
    }

    /** The Last night card's subtitle. */
    fun nightRange(sleep: GlanceSleep): String = GlanceFormat.nightRange(sleep.startMs, sleep.endMs, zone, locale)

    /**
     * The words beside a small sleep figure outside its usual ("later than usual"), or null inside it
     * or unjudged, where the figure's colour is plain too.
     */
    fun miniNote(mini: SleepMini, figure: GlanceFigure): String? = when (figure.standing) {
        GlanceStanding.ABOVE -> t("glance_sleep_${mini.key}_standing_above")
        GlanceStanding.BELOW -> t("glance_sleep_${mini.key}_standing_below")
        GlanceStanding.WITHIN, null -> null
    }

    /** The Recovery card's subtitle: the day its index is for, when that is today or the day before. */
    fun recoverySubtitle(recovery: GlanceRecovery, today: String, finished: Boolean): String? = when (recovery.index.asOfDate) {
        null -> null
        today -> t(if (finished) "glance_subtitle_that_day" else "glance_subtitle_today")
        yesterdayOf(today) -> t(if (finished) "glance_subtitle_day_before" else "glance_subtitle_yesterday")
        else -> null
    }

    /** The recovery band in words, or null on an unscored day. */
    fun bandWords(band: RecoveryBand?): String? = band?.let { t("recovery_index_band_${it.name.lowercase()}") }

    /** The breathing-rate note, printed only on a day the server sent the figure (it rose). */
    fun respiratoryLine(figure: GlanceFigure?): String? {
        val text = figure?.let { figure(it) } ?: return null
        return t("glance_recovery_respiratory", "value" to "$text ${t("recovery_units_breaths_per_minute_short")}")
    }

    /**
     * The compact hypnogram's one line of totals, "Deep 1h 40m · Light 3h 50m", or the not-staged
     * sentence for a night with no staged segment: an empty line or invented zeros would claim a
     * measurement that was never taken.
     */
    fun stageTotalsLine(totals: List<StageTotal>): String {
        if (totals.isEmpty()) return t("charts_absence_not_staged")
        return totals.joinToString(" · ") {
            "${t("sleep_stage_${it.stage.name.lowercase()}")} ${GlanceFormat.duration(it.minutes.toDouble())}"
        }
    }

    /**
     * The week card's rows: steps and active time as the seven-day total and the per-day average of
     * the finished days, time asleep as the per-night average alone; a row without a figure is left
     * out, and the sleep row also without a night to draw its bars from.
     */
    fun weekLines(glance: Glance): List<WeekLine> {
        val rows = mutableListOf<WeekLine>()
        val daysLabel = if (glance.finished) "glance_week_bars_label_finished" else "glance_week_bars_label"
        val minutes = t("activity_units_min")
        fun count(value: Double) = GlanceFormat.number(value, locale)
        fun row(kind: WeekRowKind, key: String, value: String, per: String, labelKey: String, figure: GlanceFigure): WeekLine {
            val label = t("glance_week_$key")
            return WeekLine(
                kind = kind,
                label = label,
                value = value,
                per = per,
                barsLabel = t(labelKey, "what" to label),
                values = figure.strip.map { it.value },
                dates = figure.strip.map { it.localDate },
            )
        }
        glance.week.steps?.let {
            val per = t("glance_week_per_day", "value" to count(it.perDay))
            rows += row(WeekRowKind.STEPS, "steps", count(it.total), t("glance_week_total_per", "per" to per), daysLabel, glance.day.steps)
        }
        glance.week.activeMinutes?.let {
            val per = t("glance_week_per_day", "value" to "${it.perDay.roundToLong()} $minutes")
            rows += row(
                WeekRowKind.ACTIVE, "active", GlanceFormat.duration(it.total), t("glance_week_total_per", "per" to per),
                daysLabel, glance.day.activeMinutes,
            )
        }
        val asleep = glance.week.asleep
        val sleep = glance.sleep
        if (asleep != null && sleep != null) {
            rows += row(
                WeekRowKind.ASLEEP, "asleep", GlanceFormat.duration(asleep.perDay), t("glance_week_per_night"),
                if (glance.finished) "glance_week_bars_label_nights_finished" else "glance_week_bars_label_nights",
                sleep.asleep,
            )
        }
        return rows
    }

    /** One bar's value as its row prints figures, for the bar's tooltip and accessible name. */
    fun weekBarValue(kind: WeekRowKind, value: Double): String = when (kind) {
        WeekRowKind.STEPS -> GlanceFormat.number(value, locale)
        WeekRowKind.ACTIVE -> "${value.roundToLong()} ${t("activity_units_min")}"
        WeekRowKind.ASLEEP -> GlanceFormat.duration(value)
    }

    /**
     * A recovery gauge, or null with no reading, where the card says "No reading yet" in its place.
     * Its description is the web's: name, value and unit, then the usual line.
     */
    fun gaugeDial(kind: GaugeKind, recovery: GlanceRecovery, today: String, finished: Boolean): GaugeDial? {
        val (figure, nameKey, unitKey) = when (kind) {
            GaugeKind.RESTING_HEART_RATE -> Triple(recovery.restingHeartRate, "glance_recovery_rhr", "charts_units_bpm")
            GaugeKind.HRV -> Triple(recovery.hrv, "glance_recovery_hrv", "charts_units_milliseconds")
        }
        val value = figure.value ?: return null
        val name = t(nameKey)
        val unit = t(unitKey)
        return GaugeDial(
            value = value,
            baseline = figure.baseline?.takeUnless { it.thin },
            standing = figure.standing,
            name = name,
            unit = unit,
            asOf = if (figure.asOfDate != recovery.index.asOfDate) asOfLine(figure, today, finished = finished) else null,
            description = listOfNotNull("$name ${figure(figure)} $unit", usualLine(figure)).joinToString(", "),
        )
    }

    /** The index ring's description: "Recovery index 64, Around your usual", or that it went unscored. */
    fun ringDescription(recovery: GlanceRecovery): String {
        val score = recovery.index.value ?: return t("glance_recovery_score_unscored")
        return listOfNotNull("${t("glance_recovery_index")} ${score.roundToLong()}", bandWords(recovery.band)).joinToString(", ")
    }

    /** The line under the dials: the band in words, or why the day went unscored; null for a scored day with no band. */
    fun recoveryLine(recovery: GlanceRecovery, finished: Boolean): String? =
        if (recovery.index.value == null) t(if (finished) "glance_recovery_unscored_finished" else "glance_recovery_unscored")
        else bandWords(recovery.band)

    /**
     * A strip's words. Its description is the figure's usual line, or the caption when there is none
     * to say; the recovery strip draws no usual and is described by its caption alone, as on the web.
     */
    fun stripText(kind: StripKind, figure: GlanceFigure, finished: Boolean): StripText {
        val base = when (kind) {
            StripKind.NIGHT -> "glance_sleep"
            StripKind.RECOVERY -> "glance_recovery"
            StripKind.STEPS -> "glance_today"
        }
        val suffix = if (finished) "_finished" else ""
        val caption = t("${base}_caption$suffix")
        val usual = if (kind == StripKind.RECOVERY) null else usualLine(figure)
        return StripText(label = t("${base}_strip$suffix"), caption = caption, description = usual ?: caption)
    }

    /**
     * The heart rate trace's description: its name and what it is current to, "that day" on a
     * finished day, else the time of the last reading, else "today".
     */
    fun traceDescription(heartRate: GlanceHeartRate, finished: Boolean): String {
        val asOfMs = heartRate.asOfMs
        val asOf = when {
            finished -> t("glance_as_of_that_day")
            asOfMs != null -> t("glance_as_of_time", "time" to GlanceFormat.clock(asOfMs, zone))
            else -> t("glance_as_of_today")
        }
        return "${t(if (finished) "glance_today_heart_rate_chart_that_day" else "glance_today_heart_rate_chart")}, $asOf"
    }

    private companion object {
        // The catalogue's precision (packages/core/src/derive/metrics.ts) for the glance's figures
        // that carry a decimal; every other glance metric is a whole number there.
        val PRECISION = mapOf("respiratory_rate" to 1, "sleep_respiratory_rate" to 1, "daily_spo2" to 1, "spo2" to 1)

        fun yesterdayOf(today: String): String = LocalDate.parse(today).minusDays(1).toString()
    }
}
