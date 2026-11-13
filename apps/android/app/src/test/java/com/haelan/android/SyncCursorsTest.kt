package com.haelan.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.temporal.ChronoUnit

class SyncCursorsTest {

    private val end: Instant = Instant.parse("2026-09-14T12:00:00Z")

    @Test
    fun `a cursor answer is ready to sync from`() {
        val answer = SyncCursors.Answer(mapOf("weight" to 5L))
        assertEquals(SyncCursors.Fetch.Ready(answer), SyncCursors.fetchOf(InstanceClient.Outcome.Ok(answer)))
    }

    @Test
    fun `a 401 on the cursors ends the session`() {
        assertEquals(
            SyncCursors.Fetch.Expired,
            SyncCursors.fetchOf(InstanceClient.Outcome.Failed(InstanceClient.InstanceHttpException(401, ""))),
        )
    }

    @Test
    fun `a 500 on the cursors is unavailable, never a full window`() {
        assertTrue(
            SyncCursors.fetchOf(InstanceClient.Outcome.Failed(InstanceClient.InstanceHttpException(500, "boom"))) is SyncCursors.Fetch.Unavailable,
        )
    }

    @Test
    fun `a dead socket on the cursors is unavailable too`() {
        assertTrue(
            SyncCursors.fetchOf(InstanceClient.Outcome.Failed(java.io.IOException("reset"))) is SyncCursors.Fetch.Unavailable,
        )
    }

    @Test(expected = InstanceClient.UnexpectedAnswerException::class)
    fun `a cursors answer without items is refused`() {
        SyncCursors.answerOf("{}", 0L)
    }

    @Test
    fun `the answer carries each type's identity cutover`() {
        val body = """{"items":[],"historyStartMs":null,"identityCutovers":{"weight":1786356000001,"steps":1786300000000},"googleConnected":false}"""
        assertEquals(mapOf("weight" to 1786356000001L, "steps" to 1786300000000L), SyncCursors.answerOf(body, 0L).cutovers)
    }

    @Test
    fun `an instance that predates cutovers answers none rather than failing`() {
        assertEquals(emptyMap<String, Long>(), SyncCursors.answerOf("""{"items":[]}""", 0L).cutovers)
    }

    @Test
    fun `a cursors answer with empty items is a first sync`() {
        assertEquals(SyncCursors.Answer(emptyMap()), SyncCursors.answerOf("""{"items":[],"historyStartMs":null}""", 0L))
    }

    @Test
    fun `the parse keeps values and drops nulls`() {
        val body = """{"items":[
            {"dataTypeId":"weight","lastWindowEndMs":1787047200001,"lastIngestAtMs":1770000000000},
            {"dataTypeId":"steps","lastWindowEndMs":null,"lastIngestAtMs":null}
            ],"historyStartMs":1787047200000}"""
        val parsed = SyncCursors.parseCursorEnds(body)
        assertEquals(1787047200001L, parsed["weight"])
        assertTrue(!parsed.containsKey("steps"))
    }

    @Test
    fun `the per source parse keeps dataSource apart from the legacy item beside it`() {
        // dataSource sits between dataTypeId and lastWindowEndMs, which is what keeps the
        // legacy pattern from also matching it (companion.ts's own comment says why).
        val body = """{"items":[
            {"dataTypeId":"steps","lastWindowEndMs":1787040000000,"lastIngestAtMs":1770000000000},
            {"dataTypeId":"steps","dataSource":"com.haelan.android","lastWindowEndMs":1787040000000,"lastIngestAtMs":1770000000000},
            {"dataTypeId":"steps","dataSource":"com.samsung.health","lastWindowEndMs":1786953600000,"lastIngestAtMs":1769900000000}
            ],"historyStartMs":1786867200000}"""
        val bySource = SyncCursors.parseSourceCursorEnds(body)
        assertEquals(1787040000000L, bySource["steps"]?.get("com.haelan.android")?.lastWindowEndMs)
        assertEquals(1786953600000L, bySource["steps"]?.get("com.samsung.health")?.lastWindowEndMs)
        // The legacy item's own lastWindowEndMs never leaks into a source's map: it has no
        // dataSource field for the pattern to capture.
        assertEquals(2, bySource["steps"]?.size)
    }

    /**
     * Finding A's own scenario, built directly rather than derived from a buffering fixture: two
     * sources for one type whose cursors are more than an overlap apart, and a reading the
     * laggard has not sent yet, sitting between the laggard's own cursor and the leader's.
     *
     * The watch has not synced in three days; its own cursor, watchCursorMs, is stale. The phone
     * synced moments ago; phoneCursorMs is current. A cursor keyed on whichever source is newest
     * -- .max() -- would tell the phone the type is current up to the phone's own progress, long
     * after the watch's. Keyed on the minimum, the type's cursor stays at the watch's progress.
     *
     * This test calls the production parse and selection directly, the way SyncRun and
     * SyncWorker do.
     */
    @Test
    fun `a laggard holds the type's cursor at its own progress, not the leader's`() {
        val phoneCursorMs = 1_787_040_000_000L
        val watchCursorMs = phoneCursorMs - 3 * SyncCursors.OVERLAP_MS
        val nowMs = phoneCursorMs

        // Both sources ingested at their own cursor, three days apart -- nowhere near
        // STALE_SOURCE_MS, so the watch is merely a laggard here, not aged out. That is
        // what distinguishes this test from the ageing ones below: three days is the kind
        // of gap a real intermittent source produces, and it must still hold the minimum.
        val body = """{"items":[
            {"dataTypeId":"steps","dataSource":"com.haelan.android","lastWindowEndMs":$phoneCursorMs,"lastIngestAtMs":$phoneCursorMs},
            {"dataTypeId":"steps","dataSource":"com.samsung.health","lastWindowEndMs":$watchCursorMs,"lastIngestAtMs":$watchCursorMs}
            ],"historyStartMs":0}"""

        assertEquals(
            "the type's cursor is the watch's own stale progress, not the phone's fresh one",
            watchCursorMs,
            SyncCursors.cursorEndsFor(body, nowMs)["steps"],
        )
    }

    /**
     * Finding 1 from the follow-up review: nothing aged a source out of the minimum, so a
     * retired watch's frozen cursor pinned the whole type's read start open forever. These two
     * cases are the proof STALE_SOURCE_MS closes that: a source silent longer than the threshold
     * stops holding the minimum back, and one silent for less than it still does -- otherwise a
     * watch worn only a couple of times a week would lose its next late reading exactly the way
     * Finding A's laggard, tested above, must not.
     */
    @Test
    fun `a source silent longer than STALE_SOURCE_MS stops holding the type's minimum back`() {
        val phoneCursorMs = 1_787_040_000_000L
        val watchCursorMs = phoneCursorMs - 60 * SyncCursors.OVERLAP_MS // two months stale
        val nowMs = phoneCursorMs

        val body = """{"items":[
            {"dataTypeId":"steps","dataSource":"com.haelan.android","lastWindowEndMs":$phoneCursorMs,"lastIngestAtMs":$phoneCursorMs},
            {"dataTypeId":"steps","dataSource":"com.samsung.health","lastWindowEndMs":$watchCursorMs,"lastIngestAtMs":$watchCursorMs}
            ],"historyStartMs":0}"""

        assertEquals(
            "the retired watch no longer pins the type back once it has been silent past the threshold",
            phoneCursorMs,
            SyncCursors.cursorEndsFor(body, nowMs)["steps"],
        )
    }

    @Test
    fun `a source silent for just under STALE_SOURCE_MS still holds the type's minimum back`() {
        val phoneCursorMs = 1_787_040_000_000L
        val watchCursorMs = phoneCursorMs - (SyncCursors.STALE_SOURCE_MS - SyncCursors.OVERLAP_MS)
        val nowMs = phoneCursorMs

        val body = """{"items":[
            {"dataTypeId":"steps","dataSource":"com.haelan.android","lastWindowEndMs":$phoneCursorMs,"lastIngestAtMs":$phoneCursorMs},
            {"dataTypeId":"steps","dataSource":"com.samsung.health","lastWindowEndMs":$watchCursorMs,"lastIngestAtMs":$watchCursorMs}
            ],"historyStartMs":0}"""

        assertEquals(
            "a source just inside the threshold is an intermittent one, not a dead one, and still pulls the minimum back to it",
            watchCursorMs,
            SyncCursors.cursorEndsFor(body, nowMs)["steps"],
        )
    }

    /**
     * The re-review's finding: ageing every source of a type out answered null for it, and
     * a type without a cursor reads as "never sent" -- EPOCH with the history permission
     * granted, so the app would read its entire history every sync, forever, and never recover
     * (a deduplicated re-upload never refreshes lastIngestAtMs). Ageing exists to stop a DEAD
     * source holding a type back while LIVE ones carry it; when none are live there is no one
     * left to hold back, so the answer is the newest cursor this instance has ever seen, not
     * nothing and not the oldest one either -- a wrong answer here could land on either.
     */
    @Test
    fun `cursorEndsFor answers the newest known cursor when every source of a type has gone stale, not the oldest`() {
        val newerCursorMs = 1_787_040_000_000L
        val olderCursorMs = newerCursorMs - 4 * SyncCursors.OVERLAP_MS
        val nowMs = newerCursorMs + SyncCursors.STALE_SOURCE_MS + SyncCursors.OVERLAP_MS

        val body = """{"items":[
            {"dataTypeId":"steps","dataSource":"com.haelan.android","lastWindowEndMs":$newerCursorMs,"lastIngestAtMs":$newerCursorMs},
            {"dataTypeId":"steps","dataSource":"com.samsung.health","lastWindowEndMs":$olderCursorMs,"lastIngestAtMs":$olderCursorMs}
            ],"historyStartMs":0}"""

        assertEquals(
            "both sources are stale, so the answer is the newest cursor this instance has seen, not null and not the older one",
            newerCursorMs,
            SyncCursors.cursorEndsFor(body, nowMs)["steps"],
        )
    }

    @Test
    fun `the thirty days never reach past what the permission answers`() {
        val noHistory = end.minus(30, ChronoUnit.DAYS)
        assertEquals(noHistory, SyncCursors.bootstrapStartFor(5L, noHistory, end))
    }
}
