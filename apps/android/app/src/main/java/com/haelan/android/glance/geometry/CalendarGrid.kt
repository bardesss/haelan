package com.haelan.android.glance.geometry

import com.haelan.android.glance.CalendarDay
import com.haelan.android.glance.CalendarSleep
import com.haelan.android.glance.CalendarSteps
import java.time.LocalDate
import java.time.YearMonth

// The month calendar's grid (apps/web/src/pages/dashboard/GlanceCalendar.tsx): Monday-first weeks,
// blank cells for the neighbouring months' days, and each day with data carrying the server's two
// verdicts as dots. Dates are the payload's local dates read as calendar days, so no zone moves one.

/** Last night's sleep against its usual, as a calendar dot. */
enum class SleepDot { WITHIN, OUTSIDE, NOT_JUDGED }

/** The day's steps against their usual, as a calendar dot. */
enum class StepsDot { REACHED, BELOW, NOT_JUDGED }

/**
 * One day of the month. Only an [enabled] day carries dots and can be picked; every other day is
 * grey, its dots null.
 */
data class CalendarCell(
    val localDate: String,
    val dayOfMonth: Int,
    val enabled: Boolean,
    val isToday: Boolean,
    val sleep: SleepDot?,
    val steps: StepsDot?,
)

/**
 * The weeks of [month] (YYYY-MM), seven cells each, null for a day of the month before or after.
 *
 * A day is enabled only when the server listed it in [days], it is not after [today] and not before
 * [firstDay] (when there is one): a listing that ever strayed past either edge still cannot open a
 * day the glance route would refuse. The dots are the listed verdicts, never judged here.
 */
fun calendarGrid(month: String, days: List<CalendarDay>, today: String, firstDay: String?): List<List<CalendarCell?>> {
    val yearMonth = YearMonth.parse(month)
    val todayDate = LocalDate.parse(today)
    val first = firstDay?.let(LocalDate::parse)
    val listed = days.associateBy { it.localDate }
    val cells = mutableListOf<CalendarCell?>()
    // Monday is 1 in java.time, so a month opening on a Sunday is preceded by six blanks.
    repeat(yearMonth.atDay(1).dayOfWeek.value - 1) { cells += null }
    for (dayOfMonth in 1..yearMonth.lengthOfMonth()) {
        val date = yearMonth.atDay(dayOfMonth)
        val key = date.toString()
        val entry = listed[key]?.takeIf { !date.isAfter(todayDate) && (first == null || !date.isBefore(first)) }
        cells += CalendarCell(
            localDate = key,
            dayOfMonth = dayOfMonth,
            enabled = entry != null,
            isToday = date == todayDate,
            sleep = entry?.let {
                when (it.sleep) {
                    CalendarSleep.WITHIN -> SleepDot.WITHIN
                    CalendarSleep.OUTSIDE -> SleepDot.OUTSIDE
                    null -> SleepDot.NOT_JUDGED
                }
            },
            steps = entry?.let {
                when (it.steps) {
                    CalendarSteps.REACHED -> StepsDot.REACHED
                    CalendarSteps.BELOW -> StepsDot.BELOW
                    null -> StepsDot.NOT_JUDGED
                }
            },
        )
    }
    while (cells.size % 7 != 0) cells += null
    return cells.chunked(7)
}

/**
 * The month [by] months from [month] (YYYY-MM), for the calendar's month arrows. Paging a month of a
 * picker the payload bounds, not a day to request: the month is only read when [monthReachable]
 * says it lies between the archive's first day and today, both the server's.
 */
fun shiftMonth(month: String, by: Long): String = YearMonth.parse(month).plusMonths(by).toString()

/**
 * Whether the month arrows may reach [month]: from [firstDay]'s month to [today]'s. None at all
 * before the archive's first day is known.
 */
fun monthReachable(month: String, firstDay: String?, today: String): Boolean {
    val first = firstDay ?: return false
    val target = YearMonth.parse(month)
    return !target.isBefore(YearMonth.parse(first.substring(0, 7))) && !target.isAfter(YearMonth.parse(today.substring(0, 7)))
}
