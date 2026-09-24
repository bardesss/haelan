package com.haelan.android

import androidx.health.connect.client.records.ExerciseRoute
import androidx.health.connect.client.records.ExerciseRouteResult
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.metadata.Metadata
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

/**
 * The rules that decide which withheld routes the screen offers, and which routeless copies a
 * sync must not post over a route the instance already holds.
 *
 * The second rule is the one with a real cost behind it. Health Connect answers every background
 * read of another app's route with ConsentRequired, so the two-hourly worker sees a withheld route
 * for every GPS workout in its overlap window - including the ones the screen already delivered -
 * and mapSessions.ts replaces a session's route with whatever the newest copy carries. A worker that
 * posted those copies would erase each released route within two hours of its release.
 */
class RouteLedgerTest {

    private val empty = RouteLedger.State(emptySet(), emptySet())

    @Test
    fun `a withheld route is offered, and a delivered one leaves the offer`() {
        val withheld = RouteLedger.after(empty, mapOf("a" to RouteLedger.Seen.WITHHELD))
        assertEquals(setOf("a"), withheld.withheld)
        val delivered = RouteLedger.after(withheld, mapOf("a" to RouteLedger.Seen.SENT))
        assertEquals(emptySet<String>(), delivered.withheld)
        assertEquals(setOf("a"), delivered.sent)
    }

    @Test
    fun `a delivered route withheld again is neither offered again nor posted over`() {
        val delivered = RouteLedger.after(empty, mapOf("a" to RouteLedger.Seen.SENT))
        // What the worker sees two hours later: the same workout, route withheld.
        assertFalse(
            "a routeless copy of a delivered workout would wipe the instance's route",
            RouteLedger.shouldPost("a", RouteLedger.Seen.WITHHELD, delivered.sent),
        )
        val after = RouteLedger.after(delivered, mapOf("a" to RouteLedger.Seen.WITHHELD))
        assertEquals(emptySet<String>(), after.withheld)
        assertEquals(setOf("a"), after.sent)
    }

    @Test
    fun `everything else still travels`() {
        val sent = setOf("a")
        // Withheld but never delivered: posted, so the instance can say a route exists.
        assertTrue(RouteLedger.shouldPost("b", RouteLedger.Seen.WITHHELD, sent))
        // A delivered workout read with its route in hand goes again, so an edit at the source lands.
        assertTrue(RouteLedger.shouldPost("a", RouteLedger.Seen.SENT, sent))
        // A route deleted at the source must reach the instance as a workout with none.
        assertTrue(RouteLedger.shouldPost("a", RouteLedger.Seen.NONE, sent))
        // A record Health Connect never named cannot be in the ledger at all.
        assertTrue(RouteLedger.shouldPost("", RouteLedger.Seen.WITHHELD, setOf("")))
    }

    @Test
    fun `a route gone at the source forgets both the offer and the delivery`() {
        val state = RouteLedger.State(withheld = setOf("w"), sent = setOf("s"))
        val after = RouteLedger.after(state, mapOf("w" to RouteLedger.Seen.NONE, "s" to RouteLedger.Seen.NONE))
        assertEquals(emptySet<String>(), after.withheld)
        // Forgotten, so a route that reappears is sent rather than refused as already delivered.
        assertEquals(emptySet<String>(), after.sent)
    }

    @Test
    fun `seenOf reads the three results, and an empty route as none`() {
        val point = ExerciseRoute.Location(time = Instant.parse("2026-09-20T08:30:00Z"), latitude = 52.1, longitude = 4.3)
        assertEquals(RouteLedger.Seen.SENT, RouteLedger.seenOf(ExerciseRouteResult.Data(ExerciseRoute(listOf(point)))))
        assertEquals(RouteLedger.Seen.NONE, RouteLedger.seenOf(ExerciseRouteResult.Data(ExerciseRoute(emptyList()))))
        assertEquals(RouteLedger.Seen.WITHHELD, RouteLedger.seenOf(ExerciseRouteResult.ConsentRequired()))
        assertEquals(RouteLedger.Seen.NONE, RouteLedger.seenOf(ExerciseRouteResult.NoData()))
    }

    @Test
    fun `the request set never carries the route permission, which only the route screen grants`() {
        // Health Connect drops READ_EXERCISE_ROUTES from every request, so it is never in the answer:
        // in this set it would be counted as missing for ever, and with everything else granted the
        // permission button returns at once and looks dead.
        assertFalse(SyncEngine.readPermissions().contains(SyncEngine.READ_EXERCISE_ROUTES))
        assertTrue(SyncEngine.declaredOnlyPermissions().contains(SyncEngine.READ_EXERCISE_ROUTES))
    }

    @Test
    fun `a released route travels on the point, and a withheld one carries the flag instead`() {
        // exercisePoint takes the result apart from the record, which is what makes the withheld
        // branch reachable here at all: the record constructor that carries ConsentRequired is
        // Kotlin-internal to connect-client.
        val record = ExerciseSessionRecord(
            startTime = Instant.parse("2026-09-20T08:00:00Z"),
            startZoneOffset = ZoneOffset.ofHours(1),
            endTime = Instant.parse("2026-09-20T09:00:00Z"),
            endZoneOffset = ZoneOffset.ofHours(1),
            metadata = Metadata.unknownRecordingMethodWithId("released-id"),
            exerciseType = ExerciseSessionRecord.EXERCISE_TYPE_RUNNING,
        )
        val route = ExerciseRoute(
            listOf(ExerciseRoute.Location(time = Instant.parse("2026-09-20T08:30:00Z"), latitude = 52.1, longitude = 4.3)),
        )
        val released = SyncEngine.exercisePoint(record, ExerciseRouteResult.Data(route))
        assertEquals("released-id", released.getString("name"))
        val exercise = released.getJSONObject("exercise")
        assertEquals(1, exercise.getJSONArray("route").length())
        assertFalse(exercise.has("routeConsentRequired"))

        val withheld = SyncEngine.exercisePoint(record, ExerciseRouteResult.ConsentRequired()).getJSONObject("exercise")
        assertFalse(withheld.has("route"))
        assertTrue(withheld.getBoolean("routeConsentRequired"))
    }
}
