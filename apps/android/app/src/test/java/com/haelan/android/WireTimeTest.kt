package com.haelan.android

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset

/**
 * The pair every mapper writes, pinned on its own because the mappers cannot reach it and because
 * the two fields have to describe the same end of an interval: the string carries the absolute
 * instant, the offset beside it carries the wall clock, and the server reads both
 * (`packages/core/src/api/parse.ts`).
 */
class WireTimeTest {

    @Test
    fun `an instant is written at the offset it happened at`() {
        val at = Instant.parse("2026-10-25T21:30:00Z")

        assertEquals("2026-10-25T23:30+02:00", WireTime.atOffset(at, ZoneOffset.ofHours(2)))
        assertEquals(at, OffsetDateTime.parse("2026-10-25T23:30+02:00").toInstant())
    }

    @Test
    fun `an offset crosses as a protobuf duration, sign included`() {
        assertEquals("7200s", WireTime.offsetSeconds(ZoneOffset.ofHours(2)))
        assertEquals("-18000s", WireTime.offsetSeconds(ZoneOffset.ofHours(-5)))
    }

    @Test
    fun `a record that states no offset is utc and zero seconds`() {
        // What the server's own parser reads an absent or empty offset as, so writing the two
        // halves of the pair explicitly is the form the instance already handles.
        assertEquals("0s", WireTime.offsetSeconds(null))
        assertEquals("2026-10-25T21:30Z", WireTime.atOffset(Instant.parse("2026-10-25T21:30:00Z"), null))
    }
}
