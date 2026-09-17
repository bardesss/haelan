package com.haelan.android

import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset

/**
 * How a time crosses to the instance, which is two fields and not one.
 *
 * The pair is the contract, not a formatting choice: the server reads the absolute instant out of
 * the string (`Date.parse` on the offset-carrying ISO form) and the local wall clock out of the
 * offset beside it, and `parse.ts` is explicit that the two must come from the same end of an
 * interval, because pairing an end with the other end's offset yields the wrong wall clock exactly
 * when the two straddle a change of hour. A missing offset is written as UTC and zero seconds,
 * which is what the server's own parser reads an absent or empty one as.
 *
 * A file of its own rather than four lines inside the activity, because a sleepy night is not the
 * only thing that crosses: every mapper here formats the same pair, and a test that wants to prove
 * what the app writes has to call the writer the app calls.
 */
object WireTime {

    /** The instant at the offset it happened at: absolute instant, local wall clock, one string. */
    fun atOffset(at: Instant, offset: ZoneOffset?): String =
        OffsetDateTime.ofInstant(at, offset ?: ZoneOffset.UTC).toString()

    /** The offset as a protobuf duration, which is the form the API carries it in. */
    fun offsetSeconds(offset: ZoneOffset?): String = "${offset?.totalSeconds ?: 0}s"
}
