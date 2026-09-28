package com.haelan.android.glance.format

import com.haelan.android.glance.WorkoutSession
import java.util.Locale
import kotlin.math.roundToLong

/**
 * A workout row's words, as the Activity list's SessionRow writes them
 * (apps/web/src/pages/activity/SessionRow.tsx): the type and the duration, then calories and heart
 * rate, then distance, pace and climb, each only when the session recorded it, and the exclusion
 * when there is one.
 */
data class WorkoutLine(
    val type: String,
    val duration: String,
    /** Calories and average heart rate, joined; null when the session recorded neither. */
    val stats: String?,
    /** Distance, pace and elevation gain, joined; null when it recorded none, so no blank line. */
    val detail: String?,
    /** "Excluded: reason", or the bare "Excluded"; null for a counted workout. */
    val excluded: String?,
)

/**
 * The words for the Today card's workout rows. Every field is tested against null, never a
 * zero: the summary already turns an unrecorded field into null and keeps a recorded zero, and the
 * row must not undo that just before a reader sees it.
 */
class WorkoutWords(private val strings: Strings, private val locale: Locale) {

    private fun t(key: String, vararg args: Pair<String, String>): String = strings.get(key, args.toMap())

    fun line(session: WorkoutSession): WorkoutLine {
        val summary = session.summary
        val minutes = ((session.endMs - session.startMs) / 60_000.0).roundToLong()
        val stats = listOfNotNull(
            summary.caloriesKcal?.let { "${GlanceFormat.number(it, locale)} ${t("activity_units_kcal_short")}" },
            summary.averageHeartRateBpm?.let { "${GlanceFormat.number(it, locale)} ${t("activity_units_bpm")}" },
        )
        val detail = listOfNotNull(
            summary.distanceMeters?.let { "${GlanceFormat.number(it / 1000, locale, 1)} ${t("activity_units_km")}" },
            summary.paceSecondsPerKm?.let { "${pace(it)} ${t("activity_units_pace_suffix")}" },
            summary.elevationGainMeters?.let { "${GlanceFormat.number(it, locale)} ${t("activity_units_elevation_gain_short")}" },
        )
        return WorkoutLine(
            type = typeLabel(summary.exerciseType),
            duration = "${GlanceFormat.number(minutes.toDouble(), locale)} ${t("activity_units_min")}",
            stats = stats.takeIf { it.isNotEmpty() }?.joinToString(SEPARATOR),
            detail = detail.takeIf { it.isNotEmpty() }?.joinToString(SEPARATOR),
            excluded = when {
                !session.excluded -> null
                session.excludeReason != null -> t("activity_sessions_excluded", "reason" to session.excludeReason)
                else -> t("activity_sessions_excluded_no_reason")
            },
        )
    }

    /**
     * The web's exerciseTypeLabel: a seeded type in the reader's language, any other humanised
     * ("CROSS_COUNTRY_SKI" as "Cross country ski"), which is not a translation but beats the raw
     * constant, and a session with no type "Unknown".
     */
    fun typeLabel(type: String?): String = when (type) {
        null -> t("activity_exercise_types_unknown")
        in SEEDED_TYPES -> t("activity_exercise_types_${type.lowercase(Locale.ROOT)}")
        else -> type.lowercase(Locale.ROOT).replace('_', ' ').replaceFirstChar { it.uppercaseChar() }
    }

    /** Seconds per kilometre as "6:19", the minutes grouped like any count, the seconds a clock position. */
    private fun pace(secondsPerKm: Double): String {
        val total = Math.round(secondsPerKm)
        return "${GlanceFormat.number((total / 60).toDouble(), locale)}:${(total % 60).toString().padStart(2, '0')}"
    }

    private companion object {
        /** A middot, not a hyphen: a hyphen between two figures reads as a minus. Punctuation, not copy. */
        const val SEPARATOR = " · "

        /** The types with a real translation, the web's SEEDED_EXERCISE_TYPES. */
        val SEEDED_TYPES = setOf(
            "WALKING", "CARDIO_WORKOUT", "RUNNING", "WORKOUT", "SPINNING", "BIKING",
            "TREADMILL", "HIKING", "WEIGHTLIFTING", "STROLLER_WALK", "SWIMMING_POOL", "SPORT",
            "HOUSEHOLD_CHORES",
        )
    }
}
