import {
  schema, DERIVATION_VERSION, insertSample, NoteStore, EventStore,
} from '@haelan/core'
import type { DbOrTx } from '@haelan/core'

/**
 * Representative arguments for every tool in CATALOGUE, keyed by name.
 *
 * Shared by both isolation suites - `mcp-isolation.test.ts`, which calls a tool directly against a
 * PersonQuery, and `mcp-http-isolation.test.ts`, which calls the same tool through POST /mcp - so
 * a tool added later is covered on both surfaces from one edit rather than two. A tool with no
 * entry here fails its own case in both files with a clear message rather than being silently
 * skipped: CATALOGUE is a live list a later milestone adds to, and a skipped tool is a tool
 * silently outside the guarantee these files exist to pin.
 *
 * Every input names one of alice's own ids, never bart's, because the point is what a tool bound
 * to alice answers rather than what it refuses. The one refusal worth its own case -
 * `get_workout` handed bart's session id - is written out in each file.
 */
export const TOOL_INPUTS: Record<string, Record<string, unknown>> = {
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
 * Bart's fingerprints. Anything a tool bound to alice answers that contains one of these has
 * leaked bart's data: his person id, his source id, his session ids, the two sentinels he wrote
 * himself, and the two numbers that identify his rows. 'bart' alone already covers the person id
 * and every id built from it ('bart-watch', 'bart-run', 'bart-night'); the rest are named
 * separately because they do not contain the substring 'bart'.
 *
 * The two numbers are chosen with no shared digits against alice's own (1200 vs 8800, 58 vs 176),
 * so a coincidental overlap in a summary statistic cannot pass this file by accident.
 */
export const BART_FINGERPRINTS = [
  'bart',
  'bart-note-sentinel',
  'bart-event-sentinel',
  '8800',
  '176',
]

/**
 * The other half of the guarantee. `BART_FINGERPRINTS` proves a tool bound to alice does not
 * answer with bart's rows; without this, a surface that answered *nobody* anything would satisfy
 * that perfectly - thirteen empty results contain no fingerprints - and both isolation suites
 * would stay green while proving nothing at all.
 *
 * A map rather than a list, and six tools rather than thirteen, because not every tool answers
 * with a person's own data: `list_metrics` returns the metric catalogue, which is identical for
 * every member. Each value below is a string `seedToolData` wrote for alice, so a tool that
 * stopped reaching her rows fails here rather than passing quietly.
 */
export const ALICE_FINGERPRINTS: Record<string, string> = {
  describe_person: 'alice-watch',
  query_series: '1200',
  get_intraday: '58',
  search_notes: 'alice-note-sentinel',
  get_events: 'alice-event-sentinel',
  get_workouts: 'alice-run',
}

const NINE_AM = Date.UTC(2026, 7, 1, 9, 0)
const H = 3_600_000
const BEDTIME = Date.UTC(2026, 7, 1, 22, 0)

/**
 * Seeds alice and bart with a source, daily rows, a sample, a session of each kind, a note and an
 * event apiece — every shape the five tool families in CATALOGUE read from — with values that
 * identify whose they are, so a leak is visible in the JSON rather than merely possible.
 *
 * Takes the two people as already existing: `mcp-isolation.test.ts` wants bare person rows
 * (`seedPerson`), `mcp-http-isolation.test.ts` wants people with accounts (`h.addPerson`), and
 * that is the one thing the two suites genuinely differ on.
 */
export function seedToolData(db: DbOrTx): void {
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
