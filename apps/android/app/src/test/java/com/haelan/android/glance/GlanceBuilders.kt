package com.haelan.android.glance

// Glance values built in a test, each default the plain case, so a test names only what it is about.
// The parser's fixtures are the real server's shape; these are for the words and shapes drawn from
// them, where a test needs a value the seeded person does not happen to have.

internal fun baseline(low: Double, high: Double, center: Double = (low + high) / 2, thin: Boolean = false) =
    GlanceBaseline(center = center, low = low, high = high, thin = thin)

internal fun stripDay(
    localDate: String,
    value: Double?,
    band: GlanceBaseline? = null,
    standing: GlanceStanding? = null,
) = GlanceStripDay(localDate, value, band, standing)

internal fun figure(
    metric: String,
    value: Double?,
    baseline: GlanceBaseline? = null,
    standing: GlanceStanding? = null,
    partial: Boolean = false,
    asOfDate: String? = null,
    asOfMs: Long? = null,
    strip: List<GlanceStripDay> = emptyList(),
) = GlanceFigure(
    metric = metric,
    value = value,
    unit = "",
    baseline = baseline,
    asOfDate = asOfDate,
    asOfMs = asOfMs,
    partial = partial,
    staleSources = emptyList(),
    strip = strip,
    standing = standing,
)

internal fun sleep(
    startMs: Long = 0L,
    endMs: Long = 0L,
    segments: List<GlanceNightSegment> = emptyList(),
    asleep: GlanceFigure = figure("sleep_asleep_minutes", 420.0),
) = GlanceSleep(
    localDate = "2026-08-20",
    sourceId = "watch",
    startMs = startMs,
    endMs = endMs,
    startOffsetMinutes = 120,
    endOffsetMinutes = 120,
    segments = segments,
    asleep = asleep,
    efficiency = figure("sleep_efficiency", 92.0),
    bedtime = figure("sleep_bedtime_minutes", -20.0),
    waketime = figure("sleep_waketime_minutes", 410.0),
)

internal fun recovery(index: GlanceFigure = figure("recovery_index", 62.0), band: RecoveryBand? = RecoveryBand.USUAL) =
    GlanceRecovery(
        index = index,
        band = band,
        missing = null,
        restingHeartRate = figure("resting_heart_rate", 52.0),
        hrv = figure("daily_hrv", 48.0),
        respiratoryRate = null,
    )

internal fun day(
    steps: GlanceFigure = figure("steps", 5900.0),
    stepsPace: GlanceStepsPace? = null,
    activeMinutes: GlanceFigure = figure("active_minutes", 30.0),
    heartRateAsOfMs: Long? = null,
) = GlanceDay(
    steps = steps,
    stepsPace = stepsPace,
    activeMinutes = activeMinutes,
    heartRate = GlanceHeartRate(points = emptyList(), asOfMs = heartRateAsOfMs, staleSources = emptyList()),
    workouts = emptyList(),
)

internal fun glance(
    today: String = "2026-08-20",
    sleep: GlanceSleep? = sleep(),
    day: GlanceDay = day(),
    week: GlanceWeek = GlanceWeek(steps = null, activeMinutes = null, asleep = null),
    finished: Boolean = false,
    recovery: GlanceRecovery = recovery(),
) = Glance(
    today = today,
    sleep = sleep,
    recovery = recovery,
    day = day,
    week = week,
    finished = finished,
    nav = GlanceNav(previous = null, next = null),
    log = null,
)
