package com.haelan.android

import androidx.health.connect.client.records.SleepSessionRecord
import java.time.Instant
import java.time.ZoneOffset

/**
 * One Health Connect sleep session as a v4 payload describes it, with the details
 * proven rather than declared and held where a JVM test can reach them.
 *
 * A stage carries no offset of its own: `SleepSessionRecord.Stage` is a start, an end and a type,
 * read out of connect-client 1.1.0's source rather than remembered. So each end of a stage borrows
 * the session's offset for that end. A stage that straddles a change of hour is the case that comes
 * out right at both ends; a stage wholly inside one half of the night is written at an instant that
 * is right and at the other half's wall clock, and nothing downstream reads that wall clock:
 * `mapSessions` keeps `stageStart.utcMs` and `stageEnd.utcMs` and stores no offset for a segment.
 */
object SleepStages {

    /**
     * v4's word for a Health Connect stage, or null when v4 has none for it.
     *
     * `STAGE_TYPE_UNKNOWN` is the sentinel for a field the provider never set, and any value a
     * later Health Connect adds lands here too. Neither is a stage a person was in, so neither is
     * named: the derivation counts a name outside its six toward neither asleep nor awake
     * (`packages/core/src/derive/sleep.ts`), and a figure invented on the phone would be worse than
     * the gap. The caller counts what this refuses and says so in logcat.
     */
    fun nameFor(stageType: Int): String? = when (stageType) {
        SleepSessionRecord.STAGE_TYPE_DEEP -> "DEEP"
        SleepSessionRecord.STAGE_TYPE_LIGHT -> "LIGHT"
        SleepSessionRecord.STAGE_TYPE_REM -> "REM"
        // Health Connect's one "asleep" is v4's ASLEEP, and its three body positions are all AWAKE.
        SleepSessionRecord.STAGE_TYPE_SLEEPING -> "ASLEEP"
        SleepSessionRecord.STAGE_TYPE_AWAKE,
        SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED,
        SleepSessionRecord.STAGE_TYPE_OUT_OF_BED -> "AWAKE"
        else -> null
    }

    data class Stage(val name: String, val startTime: Instant, val endTime: Instant)

    data class Night(
        val startTime: Instant,
        val startZoneOffset: ZoneOffset?,
        val endTime: Instant,
        val endZoneOffset: ZoneOffset?,
        val stages: List<Stage>,
        /** How many stages the provider offered that [stages] had to leave out. */
        val leftOutStages: Int,
    )

    fun nights(records: List<SleepSessionRecord>): List<Night> = records.map { record ->
        Night(
            startTime = record.startTime,
            startZoneOffset = record.startZoneOffset,
            endTime = record.endTime,
            endZoneOffset = record.endZoneOffset,
            stages = record.stages.mapNotNull { stage ->
                val name = nameFor(stage.stage) ?: return@mapNotNull null
                Stage(name, stage.startTime, stage.endTime)
            },
            leftOutStages = record.stages.count { nameFor(it.stage) == null },
        )
    }
}
