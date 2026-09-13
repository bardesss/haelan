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
  // 2026-08-05 to 08 rather than the 01-04 every other tool here uses: comparePeriods answers the
  // equal-length period immediately before its own range, which for 01-04 is 07-28 to 07-31 -
  // outside what seedToolData writes, so both periods used to answer zero days, the whole answer
  // was suppressed, and every number was null. A leak of bart's 8800 into a mean that never gets
  // computed is invisible, and this tool was not in ALICE_FINGERPRINTS either. 05-08's previous
  // period is 01-04, which seedToolData does write, so both sides now carry real data.
  compare_periods: { metric: 'steps', agg: 'sum', from: '2026-08-05', to: '2026-08-08' },
  trend: { metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-04' },
  get_intraday: { metric: 'heart_rate', localDate: '2026-08-01' },
  get_sleep: { from: '2026-08-01', to: '2026-08-02' },
  search_notes: { from: '2026-08-01', to: '2026-08-01' },
  get_events: { from: '2026-08-01', to: '2026-08-01' },
  get_workouts: { kind: 'exercise', from: '2026-08-01', to: '2026-08-01' },
  get_workout: { sessionId: 'alice-run' },
  // A query that would return bart's rows if the projection carried any. `daily` has no person
  // column, so this is every daily row the bound person can see - which is exactly what the
  // isolation suites then check for a second person's fingerprints.
  sql_query: { sql: 'SELECT local_date, metric, value FROM daily ORDER BY local_date' },
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
export const BART_TEXT_FINGERPRINTS = [
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
export const BART_NUMBER_FINGERPRINTS = ['8800', '176']

/**
 * Where one of bart's numbers leaked, with enough of the answer around it to see what leaked, or
 * null. Returning the context rather than a boolean is what keeps a real failure readable.
 */
export function numberLeak(json: string, fingerprint: string): string | null {
  const match = new RegExp(`(?<![0-9A-Za-z])${fingerprint}(?![0-9A-Za-z])`).exec(json)
  return match === null ? null : json.slice(Math.max(0, match.index - 40), match.index + 40)
}

/**
 * The other half of the guarantee. `BART_TEXT_FINGERPRINTS` and `BART_NUMBER_FINGERPRINTS` prove
 * a tool bound to alice does not answer with bart's rows; without this, a surface that answered
 * *nobody* anything would satisfy that perfectly - thirteen empty results contain no
 * fingerprints - and both isolation suites would stay green while proving nothing at all.
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
  sql_query: '1200',
  // Both the 08-05..08 period and its computed previous period (08-01..04) carry alice's own
  // 1200, so a suppressed answer (every field null) fails this the same way a missing tool would.
  compare_periods: '1200',
}

const NINE_AM = Date.UTC(2026, 7, 1, 9, 0)
const H = 3_600_000
const BEDTIME = Date.UTC(2026, 7, 1, 22, 0)

/**
 * One session, with zero offsets and empty attrs by default. Shared by `seedToolData` below and
 * by any other fixture that just needs a session to exist at a given span and local date -
 * `attrs` is the one thing worth varying, for a case that needs zones, splits or laps on it.
 */
export function insertSession(
  db: DbOrTx, id: string, personId: string, sourceId: string, kind: 'sleep' | 'exercise',
  startMs: number, endMs: number, localDate: string, attrs: Record<string, unknown> = {},
): void {
  db.insert(schema.sessions).values({
    id, personId, sourceId, kind, externalId: id, startMs, startOffsetMinutes: 0,
    endMs, endOffsetMinutes: 0, localDate, attrs: JSON.stringify(attrs), rawPayloadId: null,
  }).run()
}

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

  // 1 through 8, not 1 through 4: compare_periods needs a second, equal-length window with real
  // data behind it (see the comment on TOOL_INPUTS.compare_periods above) - 05 through 08 is
  // exactly that second window, alongside the 01-04 every other tool's TOOL_INPUTS entry reads.
  //
  // Alice is still inserted before bart on every date, unchanged from before this fix. The
  // reviewer noted that get_baselines, get_daily and trend catch a dropped person-id filter only
  // because personQuery.ts's preferMerged keeps whichever row of a tied pair arrived last, which
  // today is bart's - so the isolation guarantee for those three tools rests on this insertion
  // order rather than on anything the fixture states on purpose. This change does not make that
  // explicit: the order is exactly as accidental after it as before. Fixing it - seeding so a
  // dropped filter is caught regardless of insertion order - is real work of its own and out of
  // scope here; this comment exists so the next person touching this loop does not reorder it
  // without knowing three tools' isolation coverage quietly rides on the current order.
  for (const [personId, value] of [['alice', 1200], ['bart', 8800]] as const) {
    for (let day = 1; day <= 8; day += 1) {
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

  insertSession(db, 'alice-run', 'alice', 'alice-watch', 'exercise', NINE_AM, NINE_AM + H, '2026-08-01')
  insertSession(db, 'bart-run', 'bart', 'bart-watch', 'exercise', NINE_AM, NINE_AM + H, '2026-08-01')
  insertSession(db, 'alice-night', 'alice', 'alice-watch', 'sleep', BEDTIME, BEDTIME + 8 * H, '2026-08-02')
  insertSession(db, 'bart-night', 'bart', 'bart-watch', 'sleep', BEDTIME, BEDTIME + 8 * H, '2026-08-02')

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
