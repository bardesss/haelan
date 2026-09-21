package com.haelan.android

import androidx.health.connect.client.records.ExerciseRoute
import androidx.health.connect.client.records.ExerciseRouteResult
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.units.Length
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

/**
 * Where a route lands in one exercise point, and where a refusal leaves no trace at all.
 *
 * This calls SyncEngine.toExercisePoints itself and reads the JSONObject it returns, rather than
 * comparing against a literal string built by this file - literals were how the branch's earlier
 * defect survived three reviews, because a fixture and a mapper written from the same wrong
 * assumption agree with each other and prove nothing. wire-shape.txt is the only definition of the
 * shape asserted below: "route" is a key on the exercise payload object, beside interval and
 * exerciseType, never a sibling of "exercise" on the point and never nested one level deeper. This
 * mirrors mapSessions.ts (packages/core/src/sync/mapSessions.ts) and must move with it.
 *
 * ExerciseSessionRecord's own constructor that takes an ExerciseRouteResult directly is
 * Kotlin-internal to connect-client (confirmed by trying it: kotlinc refuses this file access to
 * it), so a session below is built through the public constructor's plain ExerciseRoute? param,
 * and the ConsentRequired branch - which that public constructor cannot express - is proven
 * straight through SyncEngine.routeJson instead, using the sealed result type's own public,
 * zero-arg constructors.
 */
class ExerciseRouteTest {

    private val offset = ZoneOffset.ofHours(1)

    private fun at(text: String): Instant = Instant.parse(text)

    private fun session(route: ExerciseRoute?) = ExerciseSessionRecord(
        startTime = at("2026-09-20T08:00:00Z"),
        startZoneOffset = offset,
        endTime = at("2026-09-20T09:00:00Z"),
        endZoneOffset = offset,
        metadata = Metadata.unknownRecordingMethodWithId("exercise-record-id"),
        exerciseType = ExerciseSessionRecord.EXERCISE_TYPE_RUNNING,
        exerciseRoute = route,
    )

    @Test
    fun `a granted route lands on the exercise payload, beside interval and exerciseType`() {
        val route = ExerciseRoute(
            listOf(
                ExerciseRoute.Location(
                    // Inside (startTime, endTime), not on either boundary: connect-client
                    // itself refuses a route point outside the session's own interval.
                    time = at("2026-09-20T08:30:00Z"),
                    latitude = 52.1,
                    longitude = 4.3,
                    altitude = Length.meters(3.2),
                ),
            ),
        )
        val point = SyncEngine.toExercisePoints(listOf(session(route))).single()
        // Not a sibling of "exercise" on the point, and not nested under "interval": one level
        // inside the exercise object, exactly as wire-shape.txt draws it.
        val exercise = point.getJSONObject("exercise")
        assertTrue(exercise.has("interval"))
        assertTrue(exercise.has("exerciseType"))
        val entries = exercise.getJSONArray("route")
        assertEquals(1, entries.length())
        val entry = entries.getJSONObject(0)
        assertEquals("2026-09-20T08:30:00Z", entry.getString("time"))
        assertEquals(52.1, entry.getDouble("latitude"), 0.0)
        assertEquals(4.3, entry.getDouble("longitude"), 0.0)
        assertEquals(3.2, entry.getDouble("altitudeMetres"), 0.0)
        // Independently optional, and absent rather than defaulted to a fabricated 0 when Health
        // Connect's own Location did not carry them.
        assertFalse(entry.has("horizontalAccuracyMetres"))
        assertFalse(entry.has("verticalAccuracyMetres"))
    }

    @Test
    fun `accuracy fields ride beside altitude when Health Connect carried them`() {
        val route = ExerciseRoute(
            listOf(
                ExerciseRoute.Location(
                    time = at("2026-09-20T08:30:00Z"),
                    latitude = 52.1,
                    longitude = 4.3,
                    horizontalAccuracy = Length.meters(5.0),
                    verticalAccuracy = Length.meters(2.5),
                ),
            ),
        )
        val entry = SyncEngine.toExercisePoints(listOf(session(route)))
            .single().getJSONObject("exercise").getJSONArray("route").getJSONObject(0)
        assertEquals(5.0, entry.getDouble("horizontalAccuracyMetres"), 0.0)
        assertEquals(2.5, entry.getDouble("verticalAccuracyMetres"), 0.0)
        assertFalse("altitude was never given, so it is absent and not a fabricated 0", entry.has("altitudeMetres"))
    }

    @Test
    fun `no route granted leaves the exercise payload exactly as a type with none sent`() {
        val exercise = SyncEngine.toExercisePoints(listOf(session(null))).single().getJSONObject("exercise")
        // A workout whose route is refused is still a workout: the absence of a route is a
        // normal state and costs the point nothing else it would otherwise carry.
        assertFalse("no route granted is not a key on the payload, not an error", exercise.has("route"))
        assertTrue(exercise.has("interval"))
        assertTrue(exercise.has("exerciseType"))
    }

    @Test
    fun `an empty route reads the same as no route at all`() {
        val exercise = SyncEngine.toExercisePoints(listOf(session(ExerciseRoute(emptyList()))))
            .single().getJSONObject("exercise")
        assertFalse(exercise.has("route"))
    }

    @Test
    fun `routeJson answers null for every shape that is not granted data`() {
        // NoData is the ordinary case (nobody has granted this session's route yet); ConsentRequired
        // is the one the public ExerciseSessionRecord constructor cannot build at all, because
        // reaching it needs a session-scoped system consent this headless sync never triggers (see
        // task-3-report.md, Step 1). Both read as no route to send, the same as any other type this
        // file finds nothing for.
        assertNull(SyncEngine.routeJson(ExerciseRouteResult.NoData()))
        assertNull(SyncEngine.routeJson(ExerciseRouteResult.ConsentRequired()))
    }

    @Test
    fun `routeConsentRequired separates a withheld route from a workout that has none`() {
        // The reason the field exists: routeJson answers null for both of these, and to somebody
        // looking at a workout with no map they mean opposite things. NoData is a session with no
        // track. ConsentRequired is a track that exists and was not released.
        assertTrue(SyncEngine.routeConsentRequired(ExerciseRouteResult.ConsentRequired()))
        assertFalse(SyncEngine.routeConsentRequired(ExerciseRouteResult.NoData()))
    }

    @Test
    fun `a workout with no route sends neither the route nor the flag`() {
        // The ordinary case, and the one that has to stay silent: this is what every indoor session
        // sends, and the absence of both keys must keep meaning "nothing to say" rather than
        // turning into a sentence under every workout synced from a phone.
        //
        // The other half of this pair - a ConsentRequired session putting the flag ON the exercise
        // payload - cannot be written here at all: the ExerciseSessionRecord constructor that
        // carries an ExerciseRouteResult is Kotlin-internal to connect-client, so no test in this
        // file can build that record. The placement is guarded instead by reading the real Kotlin
        // in scripts/test/android-session-name-placement.test.ts, the same way the session `name`
        // beside it is.
        val point = SyncEngine.toExercisePoints(listOf(session(null))).single()
        val exercise = point.getJSONObject("exercise")
        assertFalse(exercise.has("route"))
        assertFalse(exercise.has("routeConsentRequired"))
    }
}
