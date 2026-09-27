package com.haelan.android.glance

// The glance payload as the phone reads it: field for field the web's mirror of it
// (apps/web/src/data/useGlance.ts), which mirrors core's packages/core/src/query/glance.ts as the
// route sends it (apps/server/src/routes/v1/glance.ts, rounded to catalogue precision). Every
// verdict here arrives from the server; nothing in the app compares a value with a band.
//
// Numbers the server rounds to a metric's precision are Double, since a precision can be a decimal
// (respiratory rate is 14.2); instants are Long milliseconds; counts and offsets are Int.

/** Where a value sits against its usual; null on the figure wherever the server could not judge it. */
enum class GlanceStanding { WITHIN, ABOVE, BELOW }

/** The recovery index's band, the five words `recoveryIndex.band.*` names. */
enum class RecoveryBand { LOW, BELOW, USUAL, ABOVE, HIGH }

/** Today's steps so far against the count usual by this time of day. */
enum class PaceStanding { AHEAD, ON, BEHIND }

/** A calendar day's sleep dot: within its usual or outside it. */
enum class CalendarSleep { WITHIN, OUTSIDE }

/** A calendar day's steps dot: its usual reached or not. */
enum class CalendarSteps { REACHED, BELOW }

/**
 * A source that fed a figure and has gone quiet. Parsed and not drawn: since the status panel took
 * the warning over, no card shows it, but the payload is every client's answer, so the model keeps it.
 */
data class GlanceStaleSource(
    val sourceId: String,
    val name: String,
    val lastReportedDate: String,
    val medianGapDays: Double?,
)

/** A usual range. A thin one has too little history behind it to judge anything against. */
data class GlanceBaseline(
    val center: Double,
    val low: Double,
    val high: Double,
    val thin: Boolean,
)

/** One day of a figure's seven-day strip, judged against that day's own usual, [band]. */
data class GlanceStripDay(
    val localDate: String,
    val value: Double?,
    val band: GlanceBaseline?,
    val standing: GlanceStanding?,
)

/** One figure: its value, its usual, the day it is for, and the seven days ending on that day. */
data class GlanceFigure(
    val metric: String,
    val value: Double?,
    val unit: String,
    val baseline: GlanceBaseline?,
    val asOfDate: String?,
    val asOfMs: Long?,
    /** The day is still running, so no verdict is given on it yet. */
    val partial: Boolean,
    val staleSources: List<GlanceStaleSource>,
    val strip: List<GlanceStripDay>,
    val standing: GlanceStanding?,
)

/** A stretch of one sleep stage. [stage] stays the server's upper-case word (DEEP, LIGHT, REM, AWAKE, and others a device may report), not an enum, so a stage the app has no row for is not a parse failure. */
data class GlanceNightSegment(
    val stage: String,
    val startMs: Long,
    val endMs: Long,
)

/** Last night: its span, its stages, and its four figures. */
data class GlanceSleep(
    val localDate: String,
    val sourceId: String,
    val startMs: Long,
    val endMs: Long,
    val startOffsetMinutes: Int,
    val endOffsetMinutes: Int,
    val segments: List<GlanceNightSegment>,
    val asleep: GlanceFigure,
    val efficiency: GlanceFigure,
    val bedtime: GlanceFigure,
    val waketime: GlanceFigure,
)

/** The recovery index with the two readings beside it, and respiratory rate only on a day it rose. */
data class GlanceRecovery(
    val index: GlanceFigure,
    val band: RecoveryBand?,
    /** Why the day could not be scored; null whenever it was. */
    val missing: List<String>?,
    val restingHeartRate: GlanceFigure,
    val hrv: GlanceFigure,
    val respiratoryRate: GlanceFigure?,
)

/** Today's steps against the usual count by this minute of the day. */
data class GlanceStepsPace(
    val center: Double,
    val low: Double,
    val high: Double,
    val thin: Boolean,
    /** Today's own count cut at the same minute as the band: what [standing] judges. */
    val value: Double,
    val atMs: Long,
    val standing: PaceStanding?,
)

/** One minute of heart rate: [n] readings combined, [excluded] when the person excluded the row. */
data class IntradayPoint(
    val sourceId: String,
    val utcMs: Long,
    val min: Double?,
    val mean: Double?,
    val max: Double?,
    val n: Int,
    val excluded: Boolean,
)

/** Today's heart rate from local midnight. */
data class GlanceHeartRate(
    val points: List<IntradayPoint>,
    val asOfMs: Long?,
    val staleSources: List<GlanceStaleSource>,
)

/**
 * What the web's SessionRow reads out of a workout's attrs, read the way core's workoutSummary.ts
 * reads them: each field null when the session never recorded it, a recorded zero kept as zero.
 */
data class WorkoutSummary(
    val exerciseType: String?,
    val caloriesKcal: Double?,
    val averageHeartRateBpm: Double?,
    val distanceMeters: Double?,
    val paceSecondsPerKm: Double?,
    val elevationGainMeters: Double?,
)

/** A workout of the day, merged across the sources that recorded it: the Activity list's own row. */
data class WorkoutSession(
    val id: String,
    val sourceId: String,
    val startMs: Long,
    val endMs: Long,
    val startOffsetMinutes: Int,
    val endOffsetMinutes: Int,
    val localDate: String,
    /** Its attrs, already read into the fields a row shows; the raw blob is not kept. */
    val summary: WorkoutSummary,
    val excluded: Boolean,
    val excludeReason: String?,
    /** Every source that recorded it, its own first. */
    val sources: List<String>,
    /** The ids of the other copies merged into it. */
    val alternateIds: List<String>,
)

/** Today so far, or a finished day whole. */
data class GlanceDay(
    val steps: GlanceFigure,
    val stepsPace: GlanceStepsPace?,
    val activeMinutes: GlanceFigure,
    val heartRate: GlanceHeartRate,
    /** Oldest first, the order the day happened in. */
    val workouts: List<WorkoutSession>,
)

/** A week row: the average over its finished days, how many there were, and the seven days' total. */
data class GlanceWeekFigure(
    val perDay: Double,
    val days: Int,
    val total: Double,
)

data class GlanceWeek(
    val steps: GlanceWeekFigure?,
    val activeMinutes: GlanceWeekFigure?,
    val asleep: GlanceWeekFigure?,
)

/** The nearest days with data either side of the glance's own, as the server found them. */
data class GlanceNav(
    val previous: String?,
    val next: String?,
)

/**
 * A day's quick log (M9c): its presets, its mood (null unanswered), how often each kind was tapped
 * (kinds no preset names included), and its note. [today] is the person's real today, whichever
 * day the log is for, which is how the log sheet knows where a tap may still go.
 */
data class DayLog(
    val presets: List<String>,
    val mood: Int?,
    val counts: Map<String, Int>,
    val note: String?,
    val today: String,
)

data class Glance(
    /** The day this glance is for: today, or the finished day that was asked for. */
    val today: String,
    val sleep: GlanceSleep?,
    val recovery: GlanceRecovery,
    val day: GlanceDay,
    val week: GlanceWeek,
    /** True when [today] names a day already over. */
    val finished: Boolean,
    val nav: GlanceNav,
    /** Present only for a person who turned quick logging on; null otherwise. */
    val log: DayLog?,
)

/** One day of the month calendar; only days with data are listed. */
data class CalendarDay(
    val localDate: String,
    val sleep: CalendarSleep?,
    val steps: CalendarSteps?,
)

/** A month of the calendar, with the first day anywhere in the archive to bound its arrows. */
data class CalendarMonth(
    val month: String,
    val firstDay: String?,
    val days: List<CalendarDay>,
)
