package com.haelan.android

import androidx.health.connect.client.records.ExerciseSessionRecord

/**
 * The name haelan files a workout under, for every exercise type Health Connect can write.
 *
 * Not a translation of a documented list. The two vocabularies are unrelated: Health Connect holds
 * 61 constants in connect-client 1.1.0, v4 defines 181 values, and only 49 of the 61 share a
 * spelling. The other 12 are decisions, taken one row at a time against the v4 list in
 * `app/src/test/resources/v4-exercise-types.txt`, and each carries the reason it went where it did
 * (T0.5 measured the set on this household's phone, T4.1 built the table).
 *
 * The rule this file exists to keep: **the app never invents a value v4 does not define.** A
 * constant v4 has no word for is filed under the nearest word v4 does have, never under a name
 * invented here, and a test walks every constant in the library and fails on both an unmapped one
 * and a destination that is not in that file. `WORKOUT` is the declared fallback, not the default
 * answer: it is reached by exactly one constant, `OTHER_WORKOUT`, which is what an activity the
 * recorder did not recognize is actually called.
 */
object ExerciseTypes {

    fun nameFor(exerciseType: Int): String = when (exerciseType) {
        // An activity the device could not name, and v4 has a word for exactly that.
        ExerciseSessionRecord.EXERCISE_TYPE_OTHER_WORKOUT -> "WORKOUT"

        // The 49 that share a spelling with v4, in the library's own order.
        ExerciseSessionRecord.EXERCISE_TYPE_BADMINTON -> "BADMINTON"
        ExerciseSessionRecord.EXERCISE_TYPE_BASEBALL -> "BASEBALL"
        ExerciseSessionRecord.EXERCISE_TYPE_BASKETBALL -> "BASKETBALL"
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING -> "BIKING"
        ExerciseSessionRecord.EXERCISE_TYPE_BOXING -> "BOXING"
        ExerciseSessionRecord.EXERCISE_TYPE_CALISTHENICS -> "CALISTHENICS"
        ExerciseSessionRecord.EXERCISE_TYPE_CRICKET -> "CRICKET"
        ExerciseSessionRecord.EXERCISE_TYPE_DANCING -> "DANCING"
        ExerciseSessionRecord.EXERCISE_TYPE_ELLIPTICAL -> "ELLIPTICAL"
        ExerciseSessionRecord.EXERCISE_TYPE_EXERCISE_CLASS -> "EXERCISE_CLASS"
        ExerciseSessionRecord.EXERCISE_TYPE_FENCING -> "FENCING"
        ExerciseSessionRecord.EXERCISE_TYPE_FOOTBALL_AMERICAN -> "FOOTBALL_AMERICAN"
        ExerciseSessionRecord.EXERCISE_TYPE_FOOTBALL_AUSTRALIAN -> "FOOTBALL_AUSTRALIAN"
        ExerciseSessionRecord.EXERCISE_TYPE_GOLF -> "GOLF"
        ExerciseSessionRecord.EXERCISE_TYPE_GYMNASTICS -> "GYMNASTICS"
        ExerciseSessionRecord.EXERCISE_TYPE_HANDBALL -> "HANDBALL"
        ExerciseSessionRecord.EXERCISE_TYPE_HIKING -> "HIKING"
        ExerciseSessionRecord.EXERCISE_TYPE_ICE_SKATING -> "ICE_SKATING"
        ExerciseSessionRecord.EXERCISE_TYPE_MARTIAL_ARTS -> "MARTIAL_ARTS"
        ExerciseSessionRecord.EXERCISE_TYPE_PARAGLIDING -> "PARAGLIDING"
        ExerciseSessionRecord.EXERCISE_TYPE_PILATES -> "PILATES"
        ExerciseSessionRecord.EXERCISE_TYPE_RACQUETBALL -> "RACQUETBALL"
        ExerciseSessionRecord.EXERCISE_TYPE_ROCK_CLIMBING -> "ROCK_CLIMBING"
        ExerciseSessionRecord.EXERCISE_TYPE_ROWING -> "ROWING"
        ExerciseSessionRecord.EXERCISE_TYPE_ROWING_MACHINE -> "ROWING_MACHINE"
        ExerciseSessionRecord.EXERCISE_TYPE_RUGBY -> "RUGBY"
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING -> "RUNNING"
        ExerciseSessionRecord.EXERCISE_TYPE_SAILING -> "SAILING"
        ExerciseSessionRecord.EXERCISE_TYPE_SCUBA_DIVING -> "SCUBA_DIVING"
        ExerciseSessionRecord.EXERCISE_TYPE_SKATING -> "SKATING"
        ExerciseSessionRecord.EXERCISE_TYPE_SKIING -> "SKIING"
        ExerciseSessionRecord.EXERCISE_TYPE_SNOWBOARDING -> "SNOWBOARDING"
        ExerciseSessionRecord.EXERCISE_TYPE_SNOWSHOEING -> "SNOWSHOEING"
        ExerciseSessionRecord.EXERCISE_TYPE_SOCCER -> "SOCCER"
        ExerciseSessionRecord.EXERCISE_TYPE_SOFTBALL -> "SOFTBALL"
        ExerciseSessionRecord.EXERCISE_TYPE_SQUASH -> "SQUASH"
        ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING -> "STRENGTH_TRAINING"
        ExerciseSessionRecord.EXERCISE_TYPE_STRETCHING -> "STRETCHING"
        ExerciseSessionRecord.EXERCISE_TYPE_SURFING -> "SURFING"
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER -> "SWIMMING_OPEN_WATER"
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL -> "SWIMMING_POOL"
        ExerciseSessionRecord.EXERCISE_TYPE_TABLE_TENNIS -> "TABLE_TENNIS"
        ExerciseSessionRecord.EXERCISE_TYPE_TENNIS -> "TENNIS"
        ExerciseSessionRecord.EXERCISE_TYPE_VOLLEYBALL -> "VOLLEYBALL"
        ExerciseSessionRecord.EXERCISE_TYPE_WALKING -> "WALKING"
        ExerciseSessionRecord.EXERCISE_TYPE_WATER_POLO -> "WATER_POLO"
        ExerciseSessionRecord.EXERCISE_TYPE_WEIGHTLIFTING -> "WEIGHTLIFTING"
        ExerciseSessionRecord.EXERCISE_TYPE_WHEELCHAIR -> "WHEELCHAIR"
        ExerciseSessionRecord.EXERCISE_TYPE_YOGA -> "YOGA"

        // A stationary bike is a bike in v4, and the specific word exists: STATIONARY_BIKE.
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY -> "STATIONARY_BIKE"

        // v4 spells the camp as one word.
        ExerciseSessionRecord.EXERCISE_TYPE_BOOT_CAMP -> "BOOTCAMP"

        // Two v4 values both fit; the general one is chosen because HEALTH_CONNECT's own name
        // does not say which game is being played, and ULTIMATE_FRISBEE would be a guess.
        ExerciseSessionRecord.EXERCISE_TYPE_FRISBEE_DISC -> "FRISBEE_PLAYING_GENERAL"

        // v4 calls it MEDITATE, and that is what the record is: a guided breathing session.
        ExerciseSessionRecord.EXERCISE_TYPE_GUIDED_BREATHING -> "MEDITATE"

        // The one name pair T0.5 measured as differing, against both obvious spellings.
        ExerciseSessionRecord.EXERCISE_TYPE_HIGH_INTENSITY_INTERVAL_TRAINING -> "HIIT"

        // v4 has no ice hockey. HOCKEY is its general word, FIELD_HOCKEY its other, so the
        // general one is the honest ceiling: an ice session is not a field game.
        ExerciseSessionRecord.EXERCISE_TYPE_ICE_HOCKEY -> "HOCKEY"

        // v4 has no paddling at all, and PADDLEBOARDING is the nearest thing it does have. The
        // alternative the rule forbids is inventing a broader word v4 would reject.
        ExerciseSessionRecord.EXERCISE_TYPE_PADDLING -> "PADDLEBOARDING"

        // v4 distinguishes inline and roller skating, not roller hockey. Skating is the sport
        // both share, and the stick is what v4 cannot record.
        ExerciseSessionRecord.EXERCISE_TYPE_ROLLER_HOCKEY -> "ROLLER_SKATING"

        // A treadmill run is a run on a treadmill, and v4 names the machine on its own.
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL -> "TREADMILL"

        // The second measured name pair: v4 spells the climber as one word.
        ExerciseSessionRecord.EXERCISE_TYPE_STAIR_CLIMBING -> "STAIRCLIMBER"

        // v4 has the machine word and not the free climbing one, so both Health Connect constants
        // that are about a climbing machine land on it.
        ExerciseSessionRecord.EXERCISE_TYPE_STAIR_CLIMBING_MACHINE -> "STAIRCLIMBER"

        // Reachable only from an exercise type this library version does not declare, which is
        // what a newer Health Connect writing a newer number would produce. It is named rather
        // than thrown, because a workout filed under the wrong name is better than a sync that
        // stops, and the number is in logcat for whoever has to add the row.
        else -> "WORKOUT"
    }
}
