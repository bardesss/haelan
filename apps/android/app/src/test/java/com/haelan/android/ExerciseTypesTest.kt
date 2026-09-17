package com.haelan.android

import androidx.health.connect.client.records.ExerciseSessionRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.reflect.Modifier

/**
 * The rule T4.1 exists to keep: the app never invents a value v4 does not define, and it never
 * loses an activity it could have named.
 *
 * Every constant is walked out of the library rather than listed here, so a connect-client upgrade
 * that adds an exercise type fails this file instead of silently filing the new activity under
 * WORKOUT. That is the difference between a table and a promise.
 */
class ExerciseTypesTest {

    /**
     * The constants of the library this app compiles against, read from the class itself.
     *
     * The class and not its `Companion`: the companion declares none of them, because a Kotlin
     * `const val` inside one compiles to a static field on the outer class, which is also where
     * Kotlin resolves the name from. Measured on connect-client 1.1.0, the outer class carries 63
     * fields whose name starts with `EXERCISE_TYPE_`, of which 61 are the `int` constants and two
     * are maps this filter has to leave out: `EXERCISE_TYPE_STRING_TO_INT_MAP` and
     * `EXERCISE_TYPE_INT_TO_STRING_MAP`. A filter on the name alone would count 63 and a filter
     * that read them as ints would throw on the maps.
     */
    private val libraryConstants: Map<String, Int> = ExerciseSessionRecord::class.java.fields
        .filter { it.name.startsWith("EXERCISE_TYPE_") }
        .filter { Modifier.isStatic(it.modifiers) && it.type == Int::class.javaPrimitiveType }
        .associate { it.name to it.getInt(null) }

    /** The 181 values v4 defines, from the file T0.5 step 3 wrote out of the reference. */
    private val v4Values: Set<String> =
        checkNotNull(javaClass.getResourceAsStream("/v4-exercise-types.txt")) {
            "v4-exercise-types.txt is not on the test classpath"
        }.bufferedReader().readLines()
            .map { it.trim() }
            .filter { it.isNotEmpty() && !it.startsWith("#") }
            .toSet()

    /**
     * The twelve rows that are decisions rather than a shared spelling, with the v4 name this
     * table chose. Asserted by name so that changing one is a deliberate act rather than a diff
     * nobody reads, which is what "a destination that is not in the enum" cannot catch on its own:
     * every one of these twelve lands on a real v4 value, and the question is whether it is the
     * right one.
     */
    private val decided: Map<String, String> = mapOf(
        "EXERCISE_TYPE_OTHER_WORKOUT" to "WORKOUT",
        "EXERCISE_TYPE_BIKING_STATIONARY" to "STATIONARY_BIKE",
        "EXERCISE_TYPE_BOOT_CAMP" to "BOOTCAMP",
        "EXERCISE_TYPE_FRISBEE_DISC" to "FRISBEE_PLAYING_GENERAL",
        "EXERCISE_TYPE_GUIDED_BREATHING" to "MEDITATE",
        "EXERCISE_TYPE_HIGH_INTENSITY_INTERVAL_TRAINING" to "HIIT",
        "EXERCISE_TYPE_ICE_HOCKEY" to "HOCKEY",
        "EXERCISE_TYPE_PADDLING" to "PADDLEBOARDING",
        "EXERCISE_TYPE_ROLLER_HOCKEY" to "ROLLER_SKATING",
        "EXERCISE_TYPE_RUNNING_TREADMILL" to "TREADMILL",
        "EXERCISE_TYPE_STAIR_CLIMBING" to "STAIRCLIMBER",
        "EXERCISE_TYPE_STAIR_CLIMBING_MACHINE" to "STAIRCLIMBER",
    )

    @Test
    fun everyConstantTheLibraryDeclaresIsMapped() {
        // 61 in connect-client 1.1.0, measured 2026-09-14. The number is asserted rather than the
        // set: the set is whatever the library holds today, and the count is what makes a silent
        // upgrade visible in a diff.
        assertEquals(61, libraryConstants.size)

        val fallbacks = libraryConstants.filter { ExerciseTypes.nameFor(it.value) == "WORKOUT" }
        // Exactly one constant reaches the fallback, and it is the one v4 calls WORKOUT. A second
        // one arriving here is the failure this test is for.
        assertEquals(listOf("EXERCISE_TYPE_OTHER_WORKOUT"), fallbacks.keys.toList())
    }

    @Test
    fun everyDestinationIsAValueV4Defines() {
        assertEquals(181, v4Values.size)

        for ((name, value) in libraryConstants) {
            val destination = ExerciseTypes.nameFor(value)
            assertTrue("$name maps to '$destination', which v4 does not define", destination in v4Values)
        }
    }

    @Test
    fun theTwelveNamesThatAreNotASharedSpellingGoWhereTheyWereDecidedTo() {
        for ((constant, expected) in decided) {
            val value = checkNotNull(libraryConstants[constant]) { "$constant is not in the library" }
            assertEquals(constant, expected, ExerciseTypes.nameFor(value))
        }
    }

    @Test
    fun everyOtherConstantKeepsItsOwnName() {
        // The 49 that need no decision, asserted as a set rather than one by one: if one of them
        // ever needs a different name, the failure says so here instead of in a chart.
        val mechanical = libraryConstants.filterKeys { it !in decided.keys }
        val renamed = mechanical.filter { (name, value) ->
            ExerciseTypes.nameFor(value) != name.removePrefix("EXERCISE_TYPE_")
        }
        assertEquals(emptySet<String>(), renamed.keys)
    }

    @Test
    fun aTypeThisLibraryVersionDoesNotDeclareStillGetsAName() {
        // A newer Health Connect writing a number this build has never seen: the workout is
        // filed as a workout rather than refusing the whole sync for one unnameable session.
        assertFalse(ExerciseSessionRecord.EXERCISE_TYPE_WALKING == 999)
        assertEquals("WORKOUT", ExerciseTypes.nameFor(999))
    }
}
