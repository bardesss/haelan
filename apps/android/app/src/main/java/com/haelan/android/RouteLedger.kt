package com.haelan.android

import android.content.SharedPreferences
import androidx.health.connect.client.records.ExerciseRouteResult

/**
 * Which workouts have a route Health Connect is holding back, and which have already had theirs
 * delivered. Two sets of Health Connect record ids, kept per instance and person.
 *
 * Why the app has to remember this at all: a route recorded by another app is released on two
 * conditions, and a sync only ever meets one of them. The household has to allow it - once for
 * every route ("Always allow", which is what grants READ_EXERCISE_ROUTES), or one workout at a
 * time - AND the reader has to be in the foreground. Health Connect answers `ConsentRequired` to a
 * background read of another app's route even with "Always allow" granted:
 * https://developer.android.com/health-and-fitness/health-connect/features/exercise-routes
 * ("Your app can't read exercise route data created by other apps when it runs in the
 * background"). So the two-hourly worker never sees a route, the screen's own run does once the
 * permission is granted, and a route released with "Allow this time" is handed over once, to the
 * request that asked, and never again.
 *
 * That makes the instance's copy the only lasting one, and it is fragile: mapSessions.ts clears a
 * session's route whenever a later copy of the session arrives without one, which is right for a
 * route deleted at the source and exactly wrong for a route the phone merely could not see this
 * time. The worker re-reads the trailing overlap every two hours, so without [SENT] every route the
 * screen delivered would be wiped by the next background run. [SENT] is what lets a sync tell
 * "withheld from me now" apart from "never delivered", and leave the first alone.
 *
 * [WITHHELD] is the other half: the workouts the screen offers to release one at a time. Only the
 * id is kept - the route itself is never stored on the phone, since Health Connect is the place it
 * lives and the release asks it again.
 */
object RouteLedger {

    /** What one read of a session said about its route. */
    enum class Seen {
        /** A route came back and is on its way to the instance. */
        SENT,

        /** A route exists and Health Connect would not release it to this read. */
        WITHHELD,

        /** No route: an indoor workout, or one whose route was deleted at the source. */
        NONE,
    }

    data class State(val withheld: Set<String>, val sent: Set<String>)

    // Prefs keys. The owner is what the other two belong to: a different instance or person is a
    // different archive, and a set of "already delivered" ids carried across would stop this
    // phone from ever sending those routes to the archive that never received them.
    private const val KEY_OWNER = "route_ledger_owner"
    private const val KEY_WITHHELD = "route_ledger_withheld"
    private const val KEY_SENT = "route_ledger_sent"

    fun seenOf(result: ExerciseRouteResult): Seen = when (result) {
        // An empty route is no route: routeJson sends nothing for it, so it is not a delivery.
        is ExerciseRouteResult.Data -> if (result.exerciseRoute.route.isEmpty()) Seen.NONE else Seen.SENT
        is ExerciseRouteResult.ConsentRequired -> Seen.WITHHELD
        else -> Seen.NONE
    }

    /**
     * Whether a session read with [seen] should travel to the instance at all.
     *
     * The one refusal: a route that is withheld now and was delivered before. Posting that copy
     * would replace the delivered route with nothing (see the class comment), and the instance
     * already has everything else about the session from the delivery. A foreground read with the
     * route in hand sends it again, so an edit made at the source still arrives, only later.
     * A blank id is never refused: it is a record Health Connect has not named, so nothing here
     * could have been filed under it.
     */
    fun shouldPost(id: String, seen: Seen, sent: Set<String>): Boolean =
        id.isEmpty() || seen != Seen.WITHHELD || id !in sent

    /**
     * The ledger after the instance accepted sessions read as [seen]. Pure, so the rules are
     * pinned by a JVM test; [record] is the only caller that touches prefs.
     */
    fun after(state: State, seen: Map<String, Seen>): State {
        val withheld = state.withheld.toMutableSet()
        val sent = state.sent.toMutableSet()
        for ((id, what) in seen) {
            if (id.isEmpty()) continue
            when (what) {
                Seen.SENT -> {
                    sent += id
                    withheld -= id
                }
                // A delivered route stays delivered: the instance holds it, so there is nothing
                // left to release. shouldPost kept this copy from travelling in the first place,
                // and this keeps the screen from offering it again.
                Seen.WITHHELD -> if (id !in sent) withheld += id
                // The session travelled with no route, so the instance now holds none either:
                // forgetting the delivery is what lets a route that reappears be sent again.
                Seen.NONE -> {
                    sent -= id
                    withheld -= id
                }
            }
        }
        return State(withheld, sent)
    }

    fun ownerOf(session: SyncEngine.Session): String = "${session.server}|${session.personId}"

    // Synchronized because the ledger has two writers in one process - the screen's release and
    // any run, the screen's or the worker's - and every write is a read-modify-write of two sets.
    // Each call re-reads what is stored rather than holding a copy across a sync, so a release
    // that lands mid-run is not overwritten by the run's older picture when the run finishes.
    @Synchronized
    fun load(prefs: SharedPreferences, owner: String): State {
        if (prefs.getString(KEY_OWNER, null) != owner) return State(emptySet(), emptySet())
        // Copied: the set getStringSet hands back belongs to SharedPreferences and must not change.
        return State(
            prefs.getStringSet(KEY_WITHHELD, null)?.toSet() ?: emptySet(),
            prefs.getStringSet(KEY_SENT, null)?.toSet() ?: emptySet(),
        )
    }

    @Synchronized
    fun record(prefs: SharedPreferences, owner: String, seen: Map<String, Seen>) {
        if (seen.isEmpty()) return
        val next = after(load(prefs, owner), seen)
        // commit rather than apply: the next load, possibly on another thread a moment later,
        // has to read this and not the value before it.
        prefs.edit()
            .putString(KEY_OWNER, owner)
            .putStringSet(KEY_WITHHELD, next.withheld)
            .putStringSet(KEY_SENT, next.sent)
            .commit()
    }

    /** A withheld id whose session is gone from Health Connect: nothing is left to release. */
    @Synchronized
    fun forget(prefs: SharedPreferences, owner: String, id: String) {
        val state = load(prefs, owner)
        if (id !in state.withheld) return
        prefs.edit()
            .putString(KEY_OWNER, owner)
            .putStringSet(KEY_WITHHELD, state.withheld - id)
            .putStringSet(KEY_SENT, state.sent)
            .commit()
    }
}
