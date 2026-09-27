package com.haelan.android.glance.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import com.haelan.android.glance.Glance
import com.haelan.android.glance.GlanceBaseline
import com.haelan.android.glance.GlanceDay
import com.haelan.android.glance.GlanceFigure
import com.haelan.android.glance.GlanceHeartRate
import com.haelan.android.glance.GlanceNav
import com.haelan.android.glance.GlanceNightSegment
import com.haelan.android.glance.GlanceRecovery
import com.haelan.android.glance.GlanceSleep
import com.haelan.android.glance.GlanceStanding
import com.haelan.android.glance.GlanceStepsPace
import com.haelan.android.glance.GlanceStripDay
import com.haelan.android.glance.GlanceUiState
import com.haelan.android.glance.GlanceWeek
import com.haelan.android.glance.GlanceWeekFigure
import com.haelan.android.glance.IntradayPoint
import com.haelan.android.glance.PaceStanding
import com.haelan.android.glance.RecoveryBand
import com.haelan.android.glance.WorkoutSession
import com.haelan.android.glance.WorkoutSummary
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime

// Previews of the glance, debug only. The data is made up here, round numbers on a fixed day, so no
// preview can carry anybody's real figures; the parser's fixtures stay test resources.

private val zone: ZoneId = ZoneId.of("Europe/Amsterdam")
private const val DAY = "2026-08-20"

private fun at(hour: Int, minute: Int = 0, day: String = DAY): Long =
    ZonedDateTime.of(LocalDate.parse(day).atTime(hour, minute), zone).toInstant().toEpochMilli()

private val week = (0..6).map { LocalDate.parse(DAY).minusDays(6L - it).toString() }

private fun strip(values: List<Double?>, low: Double, high: Double, outside: Set<Int> = emptySet()) = values.mapIndexed { i, v ->
    GlanceStripDay(
        week[i], v, GlanceBaseline((low + high) / 2, low, high, thin = false),
        if (v == null) null else if (i in outside) GlanceStanding.ABOVE else GlanceStanding.WITHIN,
    )
}

private fun figure(
    metric: String,
    value: Double?,
    low: Double,
    high: Double,
    strip: List<GlanceStripDay> = emptyList(),
    standing: GlanceStanding? = GlanceStanding.WITHIN,
    partial: Boolean = false,
) = GlanceFigure(
    metric, value, "", GlanceBaseline((low + high) / 2, low, high, thin = false), DAY, at(11, 40), partial, emptyList(), strip, standing,
)

private val previewGlance = Glance(
    today = DAY,
    sleep = GlanceSleep(
        localDate = DAY, sourceId = "watch", startMs = at(23, 30, "2026-08-19"), endMs = at(7, 0),
        startOffsetMinutes = 120, endOffsetMinutes = 120,
        segments = listOf(
            "LIGHT" to (0 to 40), "DEEP" to (40 to 110), "LIGHT" to (110 to 200), "REM" to (200 to 260),
            "AWAKE" to (260 to 270), "LIGHT" to (270 to 370), "REM" to (370 to 450),
        ).map { (stage, span) -> GlanceNightSegment(stage, at(23, 30, "2026-08-19") + span.first * 60_000L, at(23, 30, "2026-08-19") + span.second * 60_000L) },
        asleep = figure("sleep_asleep_minutes", 420.0, 400.0, 460.0, strip(listOf(410.0, 450.0, 380.0, 430.0, null, 470.0, 420.0), 400.0, 460.0, setOf(5))),
        efficiency = figure("sleep_efficiency", 93.0, 88.0, 95.0),
        bedtime = figure("sleep_bedtime_minutes", 30.0, -40.0, 10.0, standing = GlanceStanding.ABOVE),
        waketime = figure("sleep_waketime_minutes", 420.0, 400.0, 440.0),
    ),
    recovery = GlanceRecovery(
        index = figure("recovery_index", 64.0, 50.0, 70.0),
        band = RecoveryBand.USUAL,
        missing = null,
        restingHeartRate = figure("resting_heart_rate", 54.0, 52.0, 58.0),
        hrv = figure("daily_hrv", 38.0, 42.0, 55.0, standing = GlanceStanding.BELOW),
        respiratoryRate = null,
    ),
    day = GlanceDay(
        steps = figure("steps", 6200.0, 7000.0, 11000.0, strip(listOf(9000.0, 7500.0, 12000.0, 8000.0, 9500.0, 8800.0, 6200.0), 7000.0, 11000.0, setOf(2)), partial = true),
        stepsPace = GlanceStepsPace(5000.0, 4000.0, 6000.0, thin = false, value = 6200.0, atMs = at(11, 40), standing = PaceStanding.AHEAD),
        activeMinutes = figure("active_minutes", 35.0, 20.0, 60.0, partial = true),
        heartRate = GlanceHeartRate(
            points = (0 until 140).map { i ->
                val mean = 60.0 + (i % 20) + if (i in 90..100) 60.0 else 0.0
                IntradayPoint("watch", at(0) + i * 5 * 60_000L, mean - 4, mean, mean + 4, 5, excluded = false)
            },
            asOfMs = at(11, 40),
            staleSources = emptyList(),
        ),
        workouts = listOf(
            WorkoutSession(
                "preview-run", "watch", at(7, 30), at(8, 20), 120, 120, DAY,
                WorkoutSummary("RUNNING", 520.0, 152.0, 8000.0, 375.0, 40.0), excluded = false, excludeReason = null,
                sources = listOf("watch"), alternateIds = emptyList(),
            ),
        ),
    ),
    week = GlanceWeek(
        steps = GlanceWeekFigure(perDay = 9133.0, days = 6, total = 61000.0),
        activeMinutes = GlanceWeekFigure(perDay = 45.0, days = 6, total = 305.0),
        asleep = GlanceWeekFigure(perDay = 427.0, days = 6, total = 2560.0),
    ),
    finished = false,
    nav = GlanceNav(previous = "2026-08-19", next = null),
    log = null,
)

private fun state(glance: Glance?, problem: GlanceUiState.Problem? = null) =
    GlanceUiState(shownDay = null, glance = glance, fetchedAtMs = at(11, 42), reachable = true, loading = false, problem = problem)

@Preview(name = "Today", heightDp = 2000)
@Composable
private fun TodayPreview() {
    GlanceTheme {
        GlanceScreen(state(previewGlance), rememberCardText(zone), at(11, 45), onOpenSync = {}, onOpenDay = {}, onOpenPage = {})
    }
}

@Preview(name = "A finished day, no night", heightDp = 1600, locale = "nl")
@Composable
private fun PastDayPreview() {
    val past = previewGlance.copy(sleep = null, finished = true, day = previewGlance.day.copy(stepsPace = null))
    GlanceTheme {
        GlanceScreen(state(past).copy(shownDay = DAY), rememberCardText(zone), at(11, 45), onOpenSync = {}, onOpenDay = {}, onOpenPage = {})
    }
}

@Preview(name = "First run")
@Composable
private fun EmptyPreview() {
    GlanceTheme {
        GlanceScreen(state(previewGlance, GlanceUiState.Problem.FirstRun), rememberCardText(zone), at(11, 45), onOpenSync = {}, onOpenDay = {}, onOpenPage = {})
    }
}
