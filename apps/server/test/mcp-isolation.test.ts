import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  PersonQuery, createTestDatabase, seedPerson, schema, DERIVATION_VERSION, insertSample,
  NoteStore, EventStore, ConfigError,
} from '@haelan/core'
import type { TestDatabase } from '@haelan/core'
import { CATALOGUE } from '../src/mcp/catalogue.ts'

/**
 * This is the file that proves M4a-2's security property: every tool in CATALOGUE, called with a
 * PersonQuery bound to one person, never answers with a second person's data.
 *
 * It is driven from CATALOGUE rather than a hand-written list of tool names, so a tool added
 * later is covered without anyone remembering to add it here. See INPUTS below for what happens
 * to a tool CATALOGUE grows that this file was never told how to call.
 *
 * `sql_query` in M4b inherits exactly the binding this file tests: PersonQuery binds a person in
 * its constructor and the module-level readers behind it are deliberately unexported, so a tool
 * (or a query) that forgets a WHERE clause cannot leak another member's data. This file is what
 * makes that a fact about the tool surface rather than a claim about PersonQuery alone.
 */

/**
 * Representative arguments for every tool in CATALOGUE, keyed by name.
 *
 * A tool with no entry here fails its own isolation case with a clear message rather than being
 * silently skipped (see the loop below): CATALOGUE is a live list a later milestone adds to, and
 * a skipped tool is a tool silently outside the guarantee this file exists to pin. Every input
 * below names one of alice's own ids (her session ids, never bart's), because the point of this
 * file is what a tool bound to alice answers, not what it refuses.
 */
const INPUTS: Record<string, Record<string, unknown>> = {
  describe_person: {},
  list_metrics: {},
  query_series: { metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-04' },
  get_daily: { localDate: '2026-08-01', metrics: ['steps'], agg: 'sum' },
  get_baselines: { metric: 'steps', agg: 'sum', on: '2026-08-10' },
  compare_periods: { metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-04' },
  trend: { metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-04' },
  get_intraday: { metric: 'heart_rate', localDate: '2026-08-01' },
  get_sleep: { from: '2026-08-01', to: '2026-08-02' },
  search_notes: { from: '2026-08-01', to: '2026-08-01' },
  get_events: { from: '2026-08-01', to: '2026-08-01' },
  get_workouts: { kind: 'exercise', from: '2026-08-01', to: '2026-08-01' },
  get_workout: { sessionId: 'alice-run' },
}

/**
 * Bart's fingerprints in text. Anything a tool bound to alice answers that contains one of these
 * has leaked bart's data: his person id, his source id, his session ids and the two sentinels he
 * wrote himself. 'bart' alone already covers the person id and every id built from it
 * ('bart-watch', 'bart-run', 'bart-night'); the rest are named separately because they do not
 * contain the substring 'bart'.
 *
 * These stay substring matches, and safely: every one of them carries a letter outside a-f, so
 * none can appear inside a generated id the way the numbers below can.
 */
const BART_TEXT_FINGERPRINTS = [
  'bart',
  'bart-note-sentinel',
  'bart-event-sentinel',
]

/**
 * The two numbers that identify bart's rows, matched as whole numbers rather than as substrings.
 *
 * They are chosen with no shared digits against alice's own (1200 vs 8800, 58 vs 176), so a
 * coincidental overlap in a summary statistic cannot pass this file by accident. What that
 * reasoning missed is the other haystack in the answer: a UUID is hex, so it carries decimal
 * digits of its own, and '176' lands inside one about once in every 215 ids. Every answer here
 * serializes at least one generated id, so as a substring check this reported a leak that had not
 * happened -- it turned CI red on Node 26 while 22 and 24 passed the very same commit, which is
 * the signature of a coincidence and not of a defect.
 *
 * Anchoring to non-alphanumeric boundaries cannot match inside a UUID, whose groups are 8, 4, 4,
 * 4 and 12 characters long and so never equal a bare '176', while a real leak still matches in
 * every JSON position a number can occupy: `:176`, `,176`, `[176`, `"176"` and `176.0`.
 */
const BART_NUMBER_FINGERPRINTS = ['8800', '176']

/**
 * Where one of bart's numbers leaked, with enough of the answer around it to see what leaked, or
 * null. Returning the context rather than a boolean is what keeps a real failure readable.
 */
function numberLeak(json: string, fingerprint: string): string | null {
  const match = new RegExp(`(?<![0-9A-Za-z])${fingerprint}(?![0-9A-Za-z])`).exec(json)
  return match === null ? null : json.slice(Math.max(0, match.index - 40), match.index + 40)
}

const NINE_AM = Date.UTC(2026, 7, 1, 9, 0)
const H = 3_600_000
const BEDTIME = Date.UTC(2026, 7, 1, 22, 0)

/**
 * Seeds alice and bart with a source, daily rows, a sample, a session of each kind, a note and an
 * event apiece — every shape the five tool families in CATALOGUE read from — with values that
 * identify whose they are, so a leak is visible in the JSON rather than merely possible.
 */
function seedTwoPeople(db: TestDatabase['db']): void {
  seedPerson(db, 'alice')
  seedPerson(db, 'bart')

  const insertSource = (id: string, personId: string) =>
    db.insert(schema.sources).values({
      id, personId, externalId: id, displayName: id, kind: 'device', createdAtMs: 0,
    }).run()
  insertSource('alice-watch', 'alice')
  insertSource('bart-watch', 'bart')

  for (const [personId, value] of [['alice', 1200], ['bart', 8800]] as const) {
    for (let day = 1; day <= 4; day += 1) {
      db.insert(schema.daily).values({
        personId, localDate: `2026-08-0${day}`, metric: 'steps', agg: 'sum', source: 'merged',
        value, coverage: 0.9, sourceMix: null, derivationVersion: DERIVATION_VERSION,
      }).run()
    }
  }

  insertSample(db, {
    personId: 'alice', sourceId: 'alice-watch', metric: 'heart_rate', utcMs: NINE_AM,
    agg: 'mean', value: 58,
  })
  insertSample(db, {
    personId: 'bart', sourceId: 'bart-watch', metric: 'heart_rate', utcMs: NINE_AM,
    agg: 'mean', value: 176,
  })

  const insertSession = (
    id: string, personId: string, sourceId: string, kind: 'sleep' | 'exercise',
    startMs: number, endMs: number, localDate: string,
  ) =>
    db.insert(schema.sessions).values({
      id, personId, sourceId, kind, externalId: id, startMs, startOffsetMinutes: 0,
      endMs, endOffsetMinutes: 0, localDate, attrs: '{}', rawPayloadId: null,
    }).run()
  insertSession('alice-run', 'alice', 'alice-watch', 'exercise', NINE_AM, NINE_AM + H, '2026-08-01')
  insertSession('bart-run', 'bart', 'bart-watch', 'exercise', NINE_AM, NINE_AM + H, '2026-08-01')
  insertSession('alice-night', 'alice', 'alice-watch', 'sleep', BEDTIME, BEDTIME + 8 * H, '2026-08-02')
  insertSession('bart-night', 'bart', 'bart-watch', 'sleep', BEDTIME, BEDTIME + 8 * H, '2026-08-02')

  new NoteStore(db).put({ personId: 'alice', localDate: '2026-08-01', body: 'alice-note-sentinel', nowMs: 0 })
  new NoteStore(db).put({ personId: 'bart', localDate: '2026-08-01', body: 'bart-note-sentinel', nowMs: 0 })

  new EventStore(db).add({
    personId: 'alice', kind: 'illness', startedAtMs: NINE_AM, startedAtOffsetMinutes: 0,
    note: 'alice-event-sentinel',
  })
  new EventStore(db).add({
    personId: 'bart', kind: 'illness', startedAtMs: NINE_AM, startedAtOffsetMinutes: 0,
    note: 'bart-event-sentinel',
  })
}

let test: TestDatabase
let alice: PersonQuery
beforeEach(() => {
  test = createTestDatabase()
  seedTwoPeople(test.db)
  alice = new PersonQuery(test.db, 'alice')
})
afterEach(() => test.cleanup())

describe('every tool, bound to one person, proved against a second', () => {
  for (const t of CATALOGUE) {
    it(`${t.name} never answers with another person's data`, () => {
      const input = INPUTS[t.name]
      if (input === undefined) {
        throw new Error(
          `no representative input for tool '${t.name}' in INPUTS in mcp-isolation.test.ts — `
          + "add one rather than letting a tool go uncovered by this file's guarantee",
        )
      }

      const result = t.run(alice, input)
      const json = JSON.stringify(result)
      for (const fingerprint of BART_TEXT_FINGERPRINTS) {
        expect(json).not.toContain(fingerprint)
      }
      for (const fingerprint of BART_NUMBER_FINGERPRINTS) {
        expect(numberLeak(json, fingerprint)).toBeNull()
      }
    })
  }

  // Guards the matcher rather than the tools, the way the fingerprints themselves guard the
  // binding: a matcher relaxed back to includes() would resume reporting leaks that never
  // happened, and a matcher too strict to see a real one would report nothing ever again. The
  // first case below is the exact answer that failed CI, on a commit that leaked nothing.
  it('reads a leaked number without reading the digits inside a generated id', () => {
    const innocent = '{"notes":[{"id":"1162ccd1-58d0-453f-9599-17671dc0c77c",'
      + '"body":{"untrustedText":"alice-note-sentinel"}}]}'
    expect(innocent).toContain('176')
    expect(numberLeak(innocent, '176')).toBeNull()

    // Every JSON position a leaked number can occupy still reads as the leak it is.
    expect(numberLeak('{"heightCm":176}', '176')).not.toBeNull()
    expect(numberLeak('{"v":[176,2]}', '176')).not.toBeNull()
    expect(numberLeak('{"v":"176"}', '176')).not.toBeNull()
    expect(numberLeak('{"v":176.0}', '176')).not.toBeNull()
    expect(numberLeak('{"steps":8800}', '8800')).not.toBeNull()

    // A longer number that merely contains it is a different number, not bart's.
    expect(numberLeak('{"v":21760}', '176')).toBeNull()
  })

  // The catalogue loop above only ever hands a tool one of alice's own ids, which proves what a
  // tool bound to alice answers, never what it refuses. `get_workout` takes a sessionId as a bare
  // string argument rather than something a query narrows by, and ids appear in other tools'
  // output (get_workouts lists them) — a model that has seen bart's session id from somewhere
  // else in a shared household and hands it back is the single most plausible route into another
  // member's data on this surface. This is the file whose job is to make that refusal visible
  // rather than assumed.
  it("get_workout refuses bart's session id under alice's binding, rather than answering with it", () => {
    const getWorkout = CATALOGUE.find((t) => t.name === 'get_workout')
    if (getWorkout === undefined) throw new Error('no tool named get_workout')

    let caught: unknown
    try {
      getWorkout.run(alice, { sessionId: 'bart-run' })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ConfigError)
    // The refusal is allowed to echo the id alice herself supplied — she already had it — but
    // must carry nothing else that identifies bart: not his source, not his other session, not
    // either sentinel, not either of his numbers.
    const detail = (caught as ConfigError).detail
    for (const fingerprint of ['bart-watch', 'bart-night', 'bart-note-sentinel', 'bart-event-sentinel', '8800', '176']) {
      expect(detail).not.toContain(fingerprint)
    }
  })
})
