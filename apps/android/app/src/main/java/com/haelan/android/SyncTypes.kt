package com.haelan.android

/**
 * Every type this app may send, and where each one is read from.
 *
 * The table exists because the app once shipped five daily types that no sensor produced
 * (A-03). A type travels only when a real path produced it, and [declared] is the tripwire
 * every upload passes through, so adding a request for a type means declaring its source
 * first. Nothing here touches Android, because the rule has to be provable by a JVM test.
 */
object SyncTypes {

    const val HEALTH_CONNECT = "health_connect"

    data class Type(val key: String, val dataTypeId: String, val source: String)

    val ALL: List<Type> = listOf(
        Type("steps", "steps", HEALTH_CONNECT),
        Type("distance", "distance", HEALTH_CONNECT),
        Type("elevation", "altitude", HEALTH_CONNECT),
        Type("active_energy", "active-energy-burned", HEALTH_CONNECT),
        // A rate the device measured rather than a day this app added up: Health Connect keeps
        // one BasalMetabolicRateRecord per day and the record is a reading. See BasalMetabolicRate.
        Type("basal", "basal-energy-burned", HEALTH_CONNECT),
        Type("exercise", "exercise", HEALTH_CONNECT),
        Type("sleep", "sleep", HEALTH_CONNECT),
        Type("weight", "weight", HEALTH_CONNECT),
        Type("height", "height", HEALTH_CONNECT),
        Type("body_fat", "body-fat", HEALTH_CONNECT),
        Type("body_temp", "core-body-temperature", HEALTH_CONNECT),
        Type("glucose", "blood-glucose", HEALTH_CONNECT),
        Type("hydration", "hydration-log", HEALTH_CONNECT),
        Type("heart_rate", "heart-rate", HEALTH_CONNECT),
        // The device computes one resting heart rate per day, so this is a reading rather
        // than an average of readings: see DailyRestingHeartRate.
        Type("resting", "daily-resting-heart-rate", HEALTH_CONNECT),
        Type("hrv", "heart-rate-variability", HEALTH_CONNECT),
        Type("spo2", "oxygen-saturation", HEALTH_CONNECT),
        // The catalogue holds no intraday respiratory rate, so a breathing reading reaches
        // haelan as the night's own summary and never as an average this app computed.
        Type("breathing", "respiratory-rate-sleep-summary", HEALTH_CONNECT),
        Type("vo2", "vo2-max", HEALTH_CONNECT),
    )

    val ACTIVITY_KEYS: List<String> =
        listOf("steps", "distance", "elevation", "active_energy", "basal", "exercise", "sleep")

    val BODY_KEYS: List<String> =
        listOf("weight", "height", "body_fat", "body_temp", "glucose", "hydration")

    val HEART_KEYS: List<String> =
        listOf("heart_rate", "resting", "hrv", "spo2", "breathing", "vo2")

    /** The toggles the screen draws, in the order it draws them. */
    val KEYS: List<String> = ACTIVITY_KEYS + BODY_KEYS + HEART_KEYS

    fun typesFor(key: String): List<Type> = ALL.filter { it.key == key }

    /** The one type a toggle names, which is what a sync line and its group both need. */
    fun forKey(key: String): Type = typesFor(key).singleOrNull()
        ?: throw IllegalStateException("toggle $key does not name exactly one declared type")

    fun isDeclared(dataTypeId: String): Boolean = ALL.any { it.dataTypeId == dataTypeId }

    /** The declared type a request names, or a refusal to send it. */
    fun declared(dataTypeId: String): Type =
        ALL.firstOrNull { it.dataTypeId == dataTypeId }
            ?: throw IllegalStateException("$dataTypeId has no declared source")
}
