package com.haelan.android.glance.format

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant
import java.time.ZoneId
import java.util.Locale

/**
 * The locale- and zone-only formatters, each against what the web prints for the same input (its
 * Intl output read off Node for the date shapes, since the JVM has no formatRange to compare with).
 */
class GlanceFormatTest {

    private val en = Locale.ENGLISH
    private val nl = Locale.forLanguageTag("nl")
    private val amsterdam = ZoneId.of("Europe/Amsterdam")
    private val newYork = ZoneId.of("America/New_York")
    private fun ms(iso: String) = Instant.parse(iso).toEpochMilli()

    @Test
    fun `a duration is hours and two-digit minutes, rounded once`() {
        assertEquals("6h 36m", GlanceFormat.duration(396.0))
        assertEquals("7h 07m", GlanceFormat.duration(427.4))
        assertEquals("0h 01m", GlanceFormat.duration(0.5))
        assertEquals("0h 00m", GlanceFormat.duration(0.0))
    }

    @Test
    fun `a clock minute wraps into one day, 24-hour`() {
        assertEquals("23:40", GlanceFormat.clock(-20.0))
        assertEquals("06:30", GlanceFormat.clock(390.0))
        assertEquals("00:05", GlanceFormat.clock(1445.0))
    }

    @Test
    fun `an instant reads in the person's zone, not the phone's`() {
        val at = ms("2026-09-05T22:05:00Z")
        assertEquals("00:05", GlanceFormat.clock(at, amsterdam))
        assertEquals("18:05", GlanceFormat.clock(at, newYork))
    }

    @Test
    fun `numbers group the locale's way`() {
        assertEquals("1,827", GlanceFormat.number(1827.0, en))
        assertEquals("1.827", GlanceFormat.number(1827.0, nl))
        assertEquals("1.234.567", GlanceFormat.number(1234567.0, nl))
        assertEquals("14.2", GlanceFormat.number(14.2, en, precision = 1))
        assertEquals("14,2", GlanceFormat.number(14.2, nl, precision = 1))
    }

    @Test
    fun `a half rounds away from zero, as the web's toLocaleString does`() {
        assertEquals("13", GlanceFormat.number(12.5, en))
        assertEquals("14,3", GlanceFormat.number(14.25, nl, precision = 1))
    }

    @Test
    fun `the long date in both languages`() {
        assertEquals("Wednesday, September 23", GlanceFormat.longDate("2026-09-23", en))
        assertEquals("woensdag 23 september", GlanceFormat.longDate("2026-09-23", nl))
    }

    @Test
    fun `the short date and the phone's header date`() {
        assertEquals("Sep 5", GlanceFormat.shortDate("2026-09-05", en))
        assertEquals("5 sep", GlanceFormat.shortDate("2026-09-05", nl))
        assertEquals("Tue, Sep 22", GlanceFormat.headerDate("2026-09-22", en, short = true))
        assertEquals("di 22 sep", GlanceFormat.headerDate("2026-09-22", nl, short = true))
        assertEquals("Tuesday, September 22", GlanceFormat.headerDate("2026-09-22", en, short = false))
    }

    /**
     * Every month's short name, as the web's Intl writes it (checked against Node's full ICU), so a
     * phone whose own ICU writes "sep." or "Sept" still prints the web's. Pinned month by month,
     * since the one a platform disagrees on is the one a sample date would miss.
     */
    @Test
    fun `every month's short name is the web's in both languages, whatever the platform's ICU says`() {
        val months = (1..12).map { "2026-${it.toString().padStart(2, '0')}-05" }
        assertEquals(
            listOf("Jan 5", "Feb 5", "Mar 5", "Apr 5", "May 5", "Jun 5", "Jul 5", "Aug 5", "Sep 5", "Oct 5", "Nov 5", "Dec 5"),
            months.map { GlanceFormat.shortDate(it, en) },
        )
        assertEquals(
            listOf("5 jan", "5 feb", "5 mrt", "5 apr", "5 mei", "5 jun", "5 jul", "5 aug", "5 sep", "5 okt", "5 nov", "5 dec"),
            months.map { GlanceFormat.shortDate(it, nl) },
        )
        assertEquals("zaterdag 5 december", GlanceFormat.longDate("2026-12-05", nl))
        assertEquals("maart 2026", GlanceFormat.monthTitle("2026-03", nl))
        assertEquals(listOf("ma" to "maandag", "di" to "dinsdag"), GlanceFormat.weekdays(nl).take(2))
        assertEquals("Su" to "Sunday", GlanceFormat.weekdays(en).last())
    }

    @Test
    fun `a night's range repeats the month in English and collapses it in Dutch`() {
        val start = ms("2026-09-05T21:30:00Z")
        val end = ms("2026-09-06T05:00:00Z")
        assertEquals("Sat, Sep 5 – Sun, Sep 6", GlanceFormat.nightRange(start, end, amsterdam, en))
        assertEquals("za 5 – zo 6 sep", GlanceFormat.nightRange(start, end, amsterdam, nl))
    }

    @Test
    fun `a night across a month names both months, across a year both years`() {
        val monthStart = ms("2026-09-30T21:30:00Z")
        val monthEnd = ms("2026-10-01T05:00:00Z")
        assertEquals("wo 30 sep – do 1 okt", GlanceFormat.nightRange(monthStart, monthEnd, amsterdam, nl))
        assertEquals("Wed, Sep 30 – Thu, Oct 1", GlanceFormat.nightRange(monthStart, monthEnd, amsterdam, en))
        val yearStart = ms("2026-12-31T21:30:00Z")
        val yearEnd = ms("2027-01-01T05:00:00Z")
        assertEquals("Thu, Dec 31, 2026 – Fri, Jan 1, 2027", GlanceFormat.nightRange(yearStart, yearEnd, amsterdam, en))
        assertEquals("do 31 dec 2026 – vr 1 jan 2027", GlanceFormat.nightRange(yearStart, yearEnd, amsterdam, nl))
    }

    @Test
    fun `a night that starts after midnight is one date, in the person's zone`() {
        val start = ms("2026-09-05T22:30:00Z")
        val end = ms("2026-09-06T05:00:00Z")
        assertEquals("Sun, Sep 6", GlanceFormat.nightRange(start, end, amsterdam, en))
        // In New York the same night runs 18:30 to 01:00: two dates again.
        assertEquals("Sat, Sep 5 – Sun, Sep 6", GlanceFormat.nightRange(start, end, newYork, en))
    }

    @Test
    fun `the greeting turns at five, noon and six`() {
        assertEquals("glance_greeting_evening", GlanceFormat.greetingKey(4))
        assertEquals("glance_greeting_morning", GlanceFormat.greetingKey(5))
        assertEquals("glance_greeting_morning", GlanceFormat.greetingKey(11))
        assertEquals("glance_greeting_afternoon", GlanceFormat.greetingKey(12))
        assertEquals("glance_greeting_afternoon", GlanceFormat.greetingKey(17))
        assertEquals("glance_greeting_evening", GlanceFormat.greetingKey(18))
    }

    @Test
    fun `the calendar's month title is the long month and the year`() {
        assertEquals("September 2026", GlanceFormat.monthTitle("2026-09", en))
        assertEquals("september 2026", GlanceFormat.monthTitle("2026-09", nl))
        assertEquals("January 2027", GlanceFormat.monthTitle("2027-01", en))
    }

    @Test
    fun `the calendar's columns start on Monday, two letters each, the full name for a screen reader`() {
        assertEquals(listOf("Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"), GlanceFormat.weekdays(en).map { it.first })
        assertEquals(listOf("ma", "di", "wo", "do", "vr", "za", "zo"), GlanceFormat.weekdays(nl).map { it.first })
        assertEquals("Monday", GlanceFormat.weekdays(en).first().second)
        assertEquals("zondag", GlanceFormat.weekdays(nl).last().second)
    }
}
