import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { EventStore } from '../src/store/events.ts'
import { NoteStore } from '../src/store/notes.ts'
import { MoodStore } from '../src/store/moods.ts'
import { readDayLog } from '../src/query/quickLog.ts'
import { SEED_KINDS } from '../src/api/eventKinds.ts'

let test: ReturnType<typeof createTestDatabase>
let stores: { notes: NoteStore, events: EventStore, moods: MoodStore }
beforeEach(() => {
  test = createTestDatabase(); seedPerson(test.db, 'p1'); seedPerson(test.db, 'p2')
  stores = { notes: new NoteStore(test.db), events: new EventStore(test.db), moods: new MoodStore(test.db) }
})
afterEach(() => test.cleanup())
const noon = (date: string) => Date.parse(`${date}T10:00:00Z`)

describe('readDayLog', () => {
  it('reads the seed chips, no mood, no counts and no note on an empty day', () => {
    expect(readDayLog(stores, { id: 'p1', quickLogPresets: null }, '2026-09-20'))
      .toEqual({ presets: [...SEED_KINDS], mood: null, counts: {}, note: null })
  })
  it('counts the day’s events per kind by local start date, and reads its mood and note', () => {
    stores.events.add({ personId: 'p1', kind: 'caffeine', startedAtMs: noon('2026-09-20'), startedAtOffsetMinutes: 120 })
    stores.events.add({ personId: 'p1', kind: 'caffeine', startedAtMs: noon('2026-09-20') + 3_600_000, startedAtOffsetMinutes: 120 })
    stores.events.add({ personId: 'p1', kind: 'sauna', startedAtMs: noon('2026-09-20'), startedAtOffsetMinutes: 120 })
    stores.events.add({ personId: 'p1', kind: 'caffeine', startedAtMs: noon('2026-09-21'), startedAtOffsetMinutes: 120 })
    stores.events.add({ personId: 'p2', kind: 'caffeine', startedAtMs: noon('2026-09-20'), startedAtOffsetMinutes: 120 })
    stores.moods.put({ personId: 'p1', localDate: '2026-09-20', score: 4, nowMs: 1 })
    stores.notes.put({ personId: 'p1', localDate: '2026-09-20', body: 'late dinner', nowMs: 1 })
    expect(readDayLog(stores, { id: 'p1', quickLogPresets: ['caffeine'] }, '2026-09-20'))
      .toEqual({ presets: ['caffeine'], mood: 4, counts: { caffeine: 2, sauna: 1 }, note: 'late dinner' })
  })
})
