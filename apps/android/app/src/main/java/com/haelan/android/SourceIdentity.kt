package com.haelan.android

import androidx.health.connect.client.records.metadata.Metadata

/**
 * Which source a reading belongs to, as the app tells the instance about it.
 *
 * Every row the instance writes is filed under the identity its request carries: `describe()` in
 * packages/core/src/store/sources.ts takes `device.displayName` when the payload has one and the
 * application package name when it has not, and gives a hand-typed reading an identity of its
 * own so that somebody can exclude it from a trend. The app used to send one constant identity,
 * so a watch's reading was filed as the phone's and nothing typed by hand could be told apart.
 *
 * Health Connect names a device with a manufacturer and a model and no display name at all, so
 * the name v4 wants is the two of them together. That is formatting rather than invention: both
 * strings come off the record, and the guard below only keeps the brand from being written twice.
 */
data class SourceIdentity(val deviceName: String?, val recordingMethod: String?) {

    companion object {

        /**
         * Health Connect's method in the vocabulary v4 was observed to use, four values measured
         * in probe/findings/field-map.md: DERIVED, PASSIVELY_MEASURED, MANUAL and
         * ACTIVELY_MEASURED.
         *
         * An unstated method answers null rather than a value. The writer did not say how the
         * reading was taken, and a payload that makes no claim is the honest one; the instance
         * reads an absent method as any other non-manual value, which is what it is.
         */
        fun recordingMethod(healthConnectMethod: Int): String? = when (healthConnectMethod) {
            Metadata.RECORDING_METHOD_MANUAL_ENTRY -> "MANUAL"
            Metadata.RECORDING_METHOD_ACTIVELY_RECORDED -> "ACTIVELY_MEASURED"
            Metadata.RECORDING_METHOD_AUTOMATICALLY_RECORDED -> "PASSIVELY_MEASURED"
            else -> null
        }

        /** The device as one name, or null when Health Connect recorded no device at all. */
        fun deviceName(manufacturer: String?, model: String?): String? {
            val brand = manufacturer?.trim()?.takeIf { it.isNotEmpty() }
            val name = model?.trim()?.takeIf { it.isNotEmpty() }
            return when {
                name == null -> brand
                brand == null -> name
                name.startsWith(brand, ignoreCase = true) -> name
                else -> "$brand $name"
            }
        }

        fun of(manufacturer: String?, model: String?, healthConnectMethod: Int): SourceIdentity =
            SourceIdentity(deviceName(manufacturer, model), recordingMethod(healthConnectMethod))
    }
}
