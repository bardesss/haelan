import { ConfigError } from '../errors.ts'
import { localMidnightMs, zoneOffsetMinutes } from '../sync/localDate.ts'
import { shiftLocalDate } from '../derive/localDay.ts'
import { quickLogPresetsOf, type PersonRow } from '../store/people.ts'
import type { EventStore } from '../store/events.ts'
import type { NoteStore } from '../store/notes.ts'
import type { MoodStore } from '../store/moods.ts'

const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000

// The instant a local wall-clock time names on `date`, by reading the offset at the first guess
// and again at the answer, as localMidnightMs does for midnight: on the day the clocks change,
// 21:00 is 21:00 on the wall.
function wallClockMs(date: string, minutesIntoDay: number, timeZone: string): number {
  const naive = Date.parse(`${date}T00:00:00Z`) + minutesIntoDay * MINUTE_MS
  const guess = naive - zoneOffsetMinutes(naive, timeZone) * MINUTE_MS
  return naive - zoneOffsetMinutes(guess, timeZone) * MINUTE_MS
}

/**
 * When a quick-logged event on `day` starts (M9c). Today: now. A finished day: one hour before
 * the bedtime of the night that followed it (the main night filed under day + 1), or 21:00 local
 * without one, and never outside `day` itself, so a night begun after midnight still leaves the
 * event on the day it was logged for. M10 pairs a day's events with the night that follows it;
 * this rule is what keeps a past day's event before that night.
 */
export function quickLogInstant(input: {
  day: string, today: string, nowMs: number, timeZone: string, nightStartMs: number | null,
}): { startedAtMs: number, startedAtOffsetMinutes: number } {
  const { day, today, nowMs, timeZone, nightStartMs } = input
  if (day > today) throw new ConfigError(`day ${day} is after today`)
  let startedAtMs: number
  if (day === today) {
    startedAtMs = nowMs
  } else if (nightStartMs === null) {
    startedAtMs = wallClockMs(day, 21 * 60, timeZone)
  } else {
    const before = nightStartMs - HOUR_MS
    const lastMinute = localMidnightMs(shiftLocalDate(day, 1), timeZone) - MINUTE_MS
    const firstMinute = localMidnightMs(day, timeZone)
    startedAtMs = Math.max(firstMinute, Math.min(before, lastMinute))
  }
  return { startedAtMs, startedAtOffsetMinutes: zoneOffsetMinutes(startedAtMs, timeZone) }
}

/** What the log panel shows for one day. */
export interface DayLog {
  presets: string[]
  mood: number | null
  /** The day's events per kind, by local start date. Kinds that are not presets count too. */
  counts: Record<string, number>
  note: string | null
  /**
   * The person's today as the server computes it, whichever day this log is for. The browser's
   * clock can disagree with it near midnight, and a glance for a past day names only that day, so
   * this is the one place the web app can learn which day a tap may still go to.
   */
  today: string
}

/** `today` comes from the route, which knows the person's zone and the clock; core knows neither. */
export function readDayLog(
  stores: { notes: NoteStore, events: EventStore, moods: MoodStore },
  person: Pick<PersonRow, 'id' | 'quickLogPresets'>,
  localDate: string,
  today: string,
): DayLog {
  const counts: Record<string, number> = {}
  for (const event of stores.events.listFor(person.id, localDate, localDate)) {
    counts[event.kind] = (counts[event.kind] ?? 0) + 1
  }
  const note = stores.notes.listFor(person.id, localDate, localDate)[0]?.body ?? null
  return { presets: quickLogPresetsOf(person), mood: stores.moods.get(person.id, localDate), counts, note, today }
}
