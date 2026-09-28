package com.haelan.android.glance.format

import com.haelan.android.glance.GlanceHeartRate
import com.haelan.android.glance.GlanceStanding
import com.haelan.android.glance.RecoveryBand
import com.haelan.android.glance.baseline
import com.haelan.android.glance.figure
import com.haelan.android.glance.recovery
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant
import java.time.ZoneId
import java.util.Locale

/** The cards' own sentences and choices, whole, in the web's English and Dutch. */
class CardWordsTest {

    private val amsterdam = ZoneId.of("Europe/Amsterdam")
    private val english = GlanceWords(MapStrings(ENGLISH_TEXT), Locale.ENGLISH, amsterdam)
    private val dutch = GlanceWords(MapStrings(DUTCH_TEXT), Locale.forLanguageTag("nl"), amsterdam)
    private val today = "2026-08-20"

    private val rhr = figure("resting_heart_rate", 54.0, baseline(52.0, 58.0), GlanceStanding.WITHIN, asOfDate = today)
    private val index = figure("recovery_index", 64.0, asOfDate = today)

    @Test
    fun `a gauge on the index's day says its name, value, unit and usual, and no as-of`() {
        val dial = english.gaugeDial(GaugeKind.RESTING_HEART_RATE, recovery(index = index).copy(restingHeartRate = rhr), today, finished = false)!!
        assertEquals(54.0, dial.value, 0.0)
        assertEquals(baseline(52.0, 58.0), dial.baseline)
        assertEquals("Resting HR", dial.name)
        assertEquals("bpm", dial.unit)
        assertNull(dial.asOf)
        assertEquals("Resting HR 54 bpm, within your usual 52 – 58", dial.description)
    }

    @Test
    fun `a gauge from another day says which, and a thin usual is not drawn`() {
        val hrv = figure("daily_hrv", 38.0, baseline(40.0, 50.0, thin = true), asOfDate = "2026-08-19")
        val dial = dutch.gaugeDial(GaugeKind.HRV, recovery(index = index).copy(hrv = hrv), today, finished = false)!!
        assertEquals("gisteren", dial.asOf)
        assertNull(dial.baseline)
        assertEquals("ms", dial.unit)
        assertEquals("HRV 38 ms, nog te weinig geschiedenis voor een gebruikelijke waarde", dial.description)
        assertEquals("de dag ervoor", dutch.gaugeDial(GaugeKind.HRV, recovery(index = index).copy(hrv = hrv), today, finished = true)!!.asOf)
    }

    @Test
    fun `a gauge with no reading is left to the card's no-reading line`() {
        assertNull(english.gaugeDial(GaugeKind.HRV, recovery().copy(hrv = figure("daily_hrv", null)), today, finished = false))
    }

    @Test
    fun `the ring is described by the index and its band, or as unscored`() {
        assertEquals("Recovery index 64, Around your usual", english.ringDescription(recovery(index = index, band = RecoveryBand.USUAL)))
        assertEquals("Recovery index 64", english.ringDescription(recovery(index = index, band = null)))
        assertEquals("Score, niet gescoord", dutch.ringDescription(recovery(index = figure("recovery_index", null), band = null)))
    }

    @Test
    fun `under the dials the band in words, or why the day went unscored`() {
        assertEquals("Well above your usual", english.recoveryLine(recovery(band = RecoveryBand.HIGH), finished = false))
        val unscored = recovery(index = figure("recovery_index", null), band = null)
        assertEquals("Not enough readings to score yet.", english.recoveryLine(unscored, finished = false))
        assertEquals("Not enough readings to score.", english.recoveryLine(unscored, finished = true))
        assertNull(english.recoveryLine(recovery(band = null), finished = false))
    }

    @Test
    fun `a strip is described by its usual line, or its caption with nothing to say`() {
        val steps = figure("steps", 6200.0, baseline(7000.0, 11000.0), GlanceStanding.BELOW)
        assertEquals(
            StripText("Steps, last 7 days", "last 7 days", "below your usual 7,000 – 11,000"),
            english.stripText(StripKind.STEPS, steps, finished = false),
        )
        assertEquals(
            StripText("Tijd geslapen, de 7 nachten tot en met die dag", "de 7 nachten tot en met die dag", "de 7 nachten tot en met die dag"),
            dutch.stripText(StripKind.NIGHT, figure("sleep_asleep_minutes", 420.0), finished = true),
        )
    }

    @Test
    fun `the recovery strip is described by its caption alone`() {
        val withUsual = figure("recovery_index", 64.0, baseline(50.0, 70.0), GlanceStanding.WITHIN)
        assertEquals(
            StripText("Recovery index, last 7 days", "last 7 days", "last 7 days"),
            english.stripText(StripKind.RECOVERY, withUsual, finished = false),
        )
    }

    @Test
    fun `the heart rate trace says what it is current to`() {
        val at = Instant.parse("2026-08-20T09:40:00Z").toEpochMilli()
        assertEquals("Heart rate today, as of 11:40", english.traceDescription(GlanceHeartRate(emptyList(), at, emptyList()), finished = false))
        assertEquals("Heart rate today, today", english.traceDescription(GlanceHeartRate(emptyList(), null, emptyList()), finished = false))
        assertEquals("Hartslag die dag, die dag", dutch.traceDescription(GlanceHeartRate(emptyList(), at, emptyList()), finished = true))
    }
}
