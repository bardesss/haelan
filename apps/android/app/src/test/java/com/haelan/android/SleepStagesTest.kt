package com.haelan.android

import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.metadata.Metadata
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Duration
import java.time.Instant
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneOffset

/**
 * The two things `T4.5` asks to be proven rather than declared: what a night that crosses a change
 * of hour is written as, and what becomes of a stage v4 has no name for.
 *
 * The night below is synthetic and says so. Europe/Rome falls back on 2026-10-25 at 01:00Z, when
 * 03:00 CEST becomes 02:00 CET; the session, its six stages and every instant here are invented for
 * this file, and no value in it was read off a phone.
 *
 * The assertions go through `WireTime`, which is the writer the mappers themselves call, and then
 * back through the parse the instance does (`packages/core/src/api/parse.ts` reads the absolute
 * instant out of the ISO string and the wall clock out of the offset beside it). A test that
 * formatted its own strings would prove what the test does, not what the app sends.
 */
class SleepStagesTest {

    private val cest = ZoneOffset.ofHours(2)
    private val cet = ZoneOffset.ofHours(1)

    private fun at(text: String): Instant = Instant.parse(text)

    /**
     * A night whose two halves happened at different offsets, with one stage lying across the
     * change (00:45Z to 01:30Z, which reads 02:45 CEST to 02:30 CET) and one stage of the type
     * Health Connect uses when the provider stated none.
     */
    private val dstNight = SleepSessionRecord(
        startTime = at("2026-10-25T21:30:00Z"),
        startZoneOffset = cest,
        endTime = at("2026-10-26T06:00:00Z"),
        endZoneOffset = cet,
        metadata = Metadata.unknownRecordingMethod(),
        stages = listOf(
            stage("2026-10-25T21:30:00Z", "2026-10-25T21:45:00Z", SleepSessionRecord.STAGE_TYPE_AWAKE),
            stage("2026-10-25T21:45:00Z", "2026-10-26T00:45:00Z", SleepSessionRecord.STAGE_TYPE_LIGHT),
            stage("2026-10-26T00:45:00Z", "2026-10-26T01:30:00Z", SleepSessionRecord.STAGE_TYPE_REM),
            stage("2026-10-26T01:30:00Z", "2026-10-26T01:40:00Z", SleepSessionRecord.STAGE_TYPE_UNKNOWN),
            stage("2026-10-26T01:40:00Z", "2026-10-26T04:00:00Z", SleepSessionRecord.STAGE_TYPE_DEEP),
            stage("2026-10-26T04:00:00Z", "2026-10-26T06:00:00Z", SleepSessionRecord.STAGE_TYPE_LIGHT),
        ),
    )

    private fun stage(from: String, to: String, type: Int) =
        SleepSessionRecord.Stage(at(from), at(to), type)

    private val night = SleepStages.nights(listOf(dstNight)).single()

    @Test
    fun `the session crosses at the two offsets its two ends happened at`() {
        assertEquals("2026-10-25T23:30+02:00", WireTime.atOffset(night.startTime, night.startZoneOffset))
        assertEquals("2026-10-26T07:00+01:00", WireTime.atOffset(night.endTime, night.endZoneOffset))
        assertEquals("7200s", WireTime.offsetSeconds(night.startZoneOffset))
        assertEquals("3600s", WireTime.offsetSeconds(night.endZoneOffset))
    }

    @Test
    fun `the night is the eight and a half hours it lasted, not the seven and a half its clocks read`() {
        assertEquals(510L, Duration.between(night.startTime, night.endTime).toMinutes())
        // The case the offsets exist to prevent. Read as two wall clocks and nothing else, the same
        // night is 23:30 to 07:00, which is 450 minutes: the hour the person slept twice would be
        // missing from every night figure the instance derives.
        val asWallClocks = Duration.between(
            LocalDateTime.parse("2026-10-25T23:30"),
            LocalDateTime.parse("2026-10-26T07:00"),
        ).toMinutes()
        assertEquals(450L, asWallClocks)
    }

    @Test
    fun `a stage lying across the change is written at both of its own ends`() {
        val rem = night.stages[2]
        assertEquals("REM", rem.name)
        assertEquals("2026-10-26T02:45+02:00", WireTime.atOffset(rem.startTime, night.startZoneOffset))
        assertEquals("2026-10-26T02:30+01:00", WireTime.atOffset(rem.endTime, night.endZoneOffset))
        // The pair parses back to the instants the record carried, which is what the instance
        // keeps: the wall clocks going backwards across the change are not an error in the payload.
        assertEquals(rem.startTime, OffsetDateTime.parse("2026-10-26T02:45+02:00").toInstant())
        assertEquals(rem.endTime, OffsetDateTime.parse("2026-10-26T02:30+01:00").toInstant())
    }

    @Test
    fun `a stage inside one half keeps its instant and borrows the other half's wall clock`() {
        // Measured, not wished away: a stage has no offset of its own to use. The end of this one
        // happened at 23:45 CEST and is written as 22:45+01:00, which is the same instant and an
        // hour early as a wall clock.
        val awake = night.stages[0]
        assertEquals("2026-10-25T23:30+02:00", WireTime.atOffset(awake.startTime, night.startZoneOffset))
        assertEquals("2026-10-25T22:45+01:00", WireTime.atOffset(awake.endTime, night.endZoneOffset))
        assertEquals(awake.endTime, OffsetDateTime.parse("2026-10-25T22:45+01:00").toInstant())

        // The mirror case after the change: 02:40 CET, which is written 03:40+02:00.
        val deep = night.stages[3]
        assertEquals("DEEP", deep.name)
        assertEquals("2026-10-26T03:40+02:00", WireTime.atOffset(deep.startTime, night.startZoneOffset))
        assertEquals(deep.startTime, OffsetDateTime.parse("2026-10-26T03:40+02:00").toInstant())
    }

    @Test
    fun `a stage type v4 has no name for is left out of the payload and counted`() {
        assertEquals(listOf("AWAKE", "LIGHT", "REM", "DEEP", "LIGHT"), night.stages.map { it.name })
        assertEquals(1, night.leftOutStages)
        assertNull(SleepStages.nameFor(SleepSessionRecord.STAGE_TYPE_UNKNOWN))
        // And a value this library version does not declare, which is what a newer Health Connect
        // writing a newer number produces: the stage is left out rather than guessed at.
        assertNull(SleepStages.nameFor(99))
    }

    @Test
    fun `the seven stage types Health Connect can write cross into v4's words for them`() {
        assertEquals("DEEP", SleepStages.nameFor(SleepSessionRecord.STAGE_TYPE_DEEP))
        assertEquals("LIGHT", SleepStages.nameFor(SleepSessionRecord.STAGE_TYPE_LIGHT))
        assertEquals("REM", SleepStages.nameFor(SleepSessionRecord.STAGE_TYPE_REM))
        // Health Connect's single sleeping stage is v4's ASLEEP, and its three positions are all
        // v4's AWAKE. RESTLESS, v4's other asleep-side value, is the classic model's, and Health
        // Connect declares no constant for it.
        assertEquals("ASLEEP", SleepStages.nameFor(SleepSessionRecord.STAGE_TYPE_SLEEPING))
        assertEquals("AWAKE", SleepStages.nameFor(SleepSessionRecord.STAGE_TYPE_AWAKE))
        assertEquals("AWAKE", SleepStages.nameFor(SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED))
        assertEquals("AWAKE", SleepStages.nameFor(SleepSessionRecord.STAGE_TYPE_OUT_OF_BED))
    }

    @Test
    fun `a night with no stages is a night, and not a count of what was left out`() {
        val empty = SleepSessionRecord(
            startTime = at("2026-10-25T22:00:00Z"),
            startZoneOffset = cest,
            endTime = at("2026-10-26T05:00:00Z"),
            endZoneOffset = cest,
            metadata = Metadata.unknownRecordingMethod(),
        )

        val bare = SleepStages.nights(listOf(empty)).single()
        assertEquals(emptyList<String>(), bare.stages.map { it.name })
        assertEquals(0, bare.leftOutStages)
    }
}
