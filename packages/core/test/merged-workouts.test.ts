import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { overrides as overridesTable, sessionRoutes, sessions, sourcePriority, sources } from '../src/db/schema/index.ts'
import { sessionTarget } from '../src/derive/targetKey.ts'
import { priorityFrom } from '../src/derive/priority.ts'
import { DEFAULT_OVERLAP_RATIO } from '../src/derive/sessionOverlap.ts'
import { enrichAttrs, mergeWorkouts } from '../src/query/mergedWorkouts.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import type { WorkoutSession } from '../src/query/sessions.ts'

/**
 * The fifteen keys mapSessions.ts writes into every session's attrs, null where the payload did
 * not carry the field. A fixture built from a hand-picked subset would let the merge pass on a
 * shape production never stores: every key is present on both sides, and the merge has to tell a
 * stored null from a value, not a missing key from a present one.
 */
function attrsOf(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    type: null, mainSleep: null, stagesStatus: null, summary: null, metricsSummary: null,
    shortAwakenings: null, exerciseType: null, splits: null, splitSummaries: null,
    exerciseEvents: null, activeDuration: null, displayName: null, notes: null,
    exerciseMetadata: null, routeConsentRequired: null,
    ...fields,
  }
}

// What the Google Health API stores for a run: the provider's mixed JSON types inside
// metricsSummary (numbers for kcal and distance, strings for heart rate and steps), a protobuf
// Duration for activeDuration, and exerciseMetadata.hasGps always present.
const GOOGLE_RUN = attrsOf({
  exerciseType: 'RUNNING',
  displayName: 'Morning Run',
  activeDuration: '1740s',
  metricsSummary: {
    caloriesKcal: 412,
    distanceMillimeters: 5_210_000,
    averageHeartRateBeatsPerMinute: '151',
    heartRateZoneDurations: { lightTime: '300s', moderateTime: '900s' },
  },
  exerciseMetadata: { hasGps: false },
  splits: [{ splitType: 'DISTANCE', activeDuration: '330s' }],
})

// What the companion app stores for the same run: SyncEngine.toExercisePoints sends the interval,
// the exercise type and, when Health Connect released one, a route. Nothing else.
const PHONE_RUN = attrsOf({ exerciseType: 'RUNNING' })

const START = Date.parse('2026-09-20T07:00:00Z')
const MINUTE = 60_000

function session(o: Partial<WorkoutSession> & { id: string, sourceId: string }): WorkoutSession {
  return {
    kind: 'exercise',
    startMs: START,
    endMs: START + 30 * MINUTE,
    startOffsetMinutes: 120,
    endOffsetMinutes: 120,
    localDate: '2026-09-20',
    attrs: attrsOf({}),
    excluded: false,
    excludeReason: null,
    sources: [o.sourceId],
    alternateIds: [],
    ...o,
  }
}

// google ranked above phone, the way a person's exercise list would say it.
const priority = priorityFrom({
  lists: new Map([['exercise', ['google', 'phone']]]),
  sources: [{ id: 'google', kind: 'app' }, { id: 'phone', kind: 'app' }],
})

const merge = (list: WorkoutSession[]) => mergeWorkouts(list, { priority, overlapRatio: DEFAULT_OVERLAP_RATIO })

describe('enrichAttrs', () => {
  it('takes each field from the first member that has it, down into nested records', () => {
    const merged = enrichAttrs([PHONE_RUN, GOOGLE_RUN]) as Record<string, unknown>
    expect(merged.exerciseType).toBe('RUNNING')
    expect(merged.displayName).toBe('Morning Run')
    expect(merged.activeDuration).toBe('1740s')
    expect(merged.exerciseMetadata).toEqual({ hasGps: false })
    expect(merged.splits).toEqual([{ splitType: 'DISTANCE', activeDuration: '330s' }])
    expect(merged.routeConsentRequired).toBeNull()
  })

  it('fills one missing field inside a record the first member does have', () => {
    const first = attrsOf({ metricsSummary: { caloriesKcal: 400 } })
    const second = attrsOf({ metricsSummary: { caloriesKcal: 999, distanceMillimeters: 5_000_000 } })
    expect((enrichAttrs([first, second]) as Record<string, unknown>).metricsSummary)
      .toEqual({ caloriesKcal: 400, distanceMillimeters: 5_000_000 })
  })

  it('never mixes heart rate zones from two members', () => {
    // proto3 JSON omits a zero duration, so a zone missing from the first member's breakdown is a
    // zero rather than unknown; filling it from the second would add minutes that never happened.
    const first = attrsOf({ metricsSummary: { heartRateZoneDurations: { lightTime: '300s' } } })
    const second = attrsOf({ metricsSummary: { heartRateZoneDurations: { lightTime: '10s', peakTime: '600s' } } })
    const merged = enrichAttrs([first, second]) as { metricsSummary: Record<string, unknown> }
    expect(merged.metricsSummary.heartRateZoneDurations).toEqual({ lightTime: '300s' })
  })

  it('keeps a recorded zero and a recorded false rather than treating them as missing', () => {
    const first = attrsOf({ metricsSummary: { steps: '0' }, exerciseMetadata: { hasGps: false } })
    const second = attrsOf({ metricsSummary: { steps: '4200' }, exerciseMetadata: { hasGps: true } })
    const merged = enrichAttrs([first, second]) as Record<string, Record<string, unknown>>
    expect(merged.metricsSummary!.steps).toBe('0')
    expect(merged.exerciseMetadata!.hasGps).toBe(false)
  })
})

describe('mergeWorkouts', () => {
  it('answers one workout for two sources recording the same run, named by the primary', () => {
    const out = merge([
      session({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_RUN, startMs: START + MINUTE }),
      session({ id: 'google-run', sourceId: 'google', attrs: GOOGLE_RUN }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe('google-run')
    expect(out[0]!.sourceId).toBe('google')
    expect(out[0]!.startMs).toBe(START)
    expect(out[0]!.sources).toEqual(['google', 'phone'])
    expect(out[0]!.alternateIds).toEqual(['phone-run'])
  })

  it('fills the primary from the alternate where the primary recorded nothing', () => {
    const phoneFirst = priorityFrom({
      lists: new Map([['exercise', ['phone', 'google']]]),
      sources: [{ id: 'google', kind: 'app' }, { id: 'phone', kind: 'app' }],
    })
    const [out] = mergeWorkouts([
      session({ id: 'google-run', sourceId: 'google', attrs: GOOGLE_RUN }),
      session({ id: 'phone-run', sourceId: 'phone', attrs: attrsOf({ exerciseType: 'RUNNING', routeConsentRequired: true }) }),
    ], { priority: phoneFirst, overlapRatio: DEFAULT_OVERLAP_RATIO })
    expect(out!.id).toBe('phone-run')
    const attrs = out!.attrs as Record<string, unknown>
    expect(attrs.routeConsentRequired).toBe(true)
    expect(attrs.displayName).toBe('Morning Run')
    expect(attrs.metricsSummary).toEqual(GOOGLE_RUN.metricsSummary)
  })

  it('leaves two workouts that do not overlap enough as two', () => {
    const out = merge([
      session({ id: 'google-run', sourceId: 'google' }),
      session({ id: 'phone-walk', sourceId: 'phone', startMs: START + 20 * MINUTE, endMs: START + 60 * MINUTE }),
    ])
    expect(out.map((w) => w.id)).toEqual(['google-run', 'phone-walk'])
    expect(out.map((w) => w.alternateIds)).toEqual([[], []])
  })

  it('never merges a night into a workout', () => {
    const out = merge([
      session({ id: 'google-run', sourceId: 'google' }),
      session({ id: 'nap', sourceId: 'phone', kind: 'sleep' }),
    ])
    expect(out.map((w) => w.id)).toEqual(['google-run', 'nap'])
  })

  it('lets a kept member stand for the event when the primary was excluded, as derivation does', () => {
    // deriveDay drops an excluded session before grouping, so the phone's copy is the workout it
    // counts. The list has to name the same one or the count and the rows beneath it disagree.
    const [out] = merge([
      session({ id: 'google-run', sourceId: 'google', attrs: GOOGLE_RUN, excluded: true, excludeReason: 'duplicate' }),
      session({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_RUN }),
    ])
    expect(out!.id).toBe('phone-run')
    expect(out!.excluded).toBe(false)
    expect(out!.excludeReason).toBeNull()
    expect(out!.sources).toEqual(['phone', 'google'])
    expect(out!.alternateIds).toEqual(['google-run'])
    // Excluded is a statement about counting the event, not about the data being wrong: the
    // excluded copy still fills what the kept one never recorded.
    expect((out!.attrs as Record<string, unknown>).displayName).toBe('Morning Run')
  })

  it('is excluded when every member is, carrying the primary\'s reason', () => {
    const [out] = merge([
      session({ id: 'google-run', sourceId: 'google', excluded: true, excludeReason: 'treadmill glitch' }),
      session({ id: 'phone-run', sourceId: 'phone', excluded: true, excludeReason: null }),
    ])
    expect(out!.id).toBe('google-run')
    expect(out!.excluded).toBe(true)
    expect(out!.excludeReason).toBe('treadmill glitch')
  })
})

describe('PersonQuery workouts, merged', () => {
  let t: TestDatabase
  beforeEach(() => {
    t = createTestDatabase()
    seedPerson(t.db, 'p1')
    for (const id of ['google', 'phone']) {
      t.db.insert(sources).values({ id, personId: 'p1', externalId: id, displayName: id, kind: 'app', createdAtMs: 0 }).run()
    }
    t.db.insert(sourcePriority).values([
      { personId: 'p1', metric: 'exercise', sourceId: 'google', rank: 0 },
      { personId: 'p1', metric: 'exercise', sourceId: 'phone', rank: 1 },
    ]).run()
  })
  afterEach(() => t.cleanup())

  const insert = (o: { id: string, sourceId: string, attrs: unknown, startMs?: number, endMs?: number, localDate?: string }) =>
    t.db.insert(sessions).values({
      id: o.id, personId: 'p1', sourceId: o.sourceId, kind: 'exercise', externalId: o.id,
      startMs: o.startMs ?? START, startOffsetMinutes: 120,
      endMs: o.endMs ?? START + 30 * MINUTE, endOffsetMinutes: 120,
      localDate: o.localDate ?? '2026-09-20', attrs: JSON.stringify(o.attrs), rawPayloadId: null,
    }).run()

  const q = () => new PersonQuery(t.db, 'p1')

  it('lists one workout for a run both sources recorded, and each source\'s own when asked for it', () => {
    insert({ id: 'google-run', sourceId: 'google', attrs: GOOGLE_RUN })
    insert({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_RUN, startMs: START + MINUTE })

    const merged = q().sessions({ kind: 'exercise', from: '2026-09-20', to: '2026-09-20' })
    expect(merged.map((w) => [w.id, w.sources, w.alternateIds])).toEqual([['google-run', ['google', 'phone'], ['phone-run']]])

    const phoneOnly = q().sessions({ kind: 'exercise', from: '2026-09-20', to: '2026-09-20', sourceId: 'phone' })
    expect(phoneOnly.map((w) => [w.id, w.sources, w.alternateIds])).toEqual([['phone-run', ['phone'], []]])
  })

  it('follows the person\'s own priority list rather than a fixed order', () => {
    t.db.delete(sourcePriority).run()
    t.db.insert(sourcePriority).values([
      { personId: 'p1', metric: 'exercise', sourceId: 'phone', rank: 0 },
      { personId: 'p1', metric: 'exercise', sourceId: 'google', rank: 1 },
    ]).run()
    insert({ id: 'google-run', sourceId: 'google', attrs: GOOGLE_RUN })
    insert({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_RUN })

    const [out] = q().sessions({ kind: 'exercise', from: '2026-09-20', to: '2026-09-20' })
    expect(out!.id).toBe('phone-run')
  })

  it('filters by type and takes the last N after merging, not before', () => {
    insert({ id: 'google-run', sourceId: 'google', attrs: GOOGLE_RUN })
    insert({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_RUN })
    // Taken on raw rows, the last one is the phone's copy (same start, later id), which would then
    // answer alone as a workout of its own with Google's name and numbers missing.
    const out = q().sessions({ kind: 'exercise', from: '2026-09-20', to: '2026-09-20', type: 'RUNNING', last: 1 })
    expect(out.map((w) => [w.id, w.alternateIds])).toEqual([['google-run', ['phone-run']]])
  })

  it('files a workout under its primary\'s date, even when an alternate falls just outside the range', () => {
    // A run across midnight: the phone closed its copy a minute later and filed it under the next
    // day. The range asked for the first day only, and the event belongs there.
    const late = Date.parse('2026-09-20T21:30:00Z')
    insert({ id: 'google-run', sourceId: 'google', attrs: GOOGLE_RUN, startMs: late, endMs: late + 29 * MINUTE, localDate: '2026-09-20' })
    insert({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_RUN, startMs: late, endMs: late + 31 * MINUTE, localDate: '2026-09-21' })

    expect(q().sessions({ kind: 'exercise', from: '2026-09-20', to: '2026-09-20' }).map((w) => w.id)).toEqual(['google-run'])
    expect(q().sessions({ kind: 'exercise', from: '2026-09-21', to: '2026-09-21' })).toEqual([])
  })

  it('answers the merged workout for an alternate\'s id, so a link to either copy still opens it', () => {
    insert({ id: 'google-run', sourceId: 'google', attrs: GOOGLE_RUN })
    insert({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_RUN })

    const out = q().sessionById({ sessionId: 'phone-run' })
    expect(out!.id).toBe('google-run')
    expect(out!.alternateIds).toEqual(['phone-run'])
    expect((out!.attrs as Record<string, unknown>).displayName).toBe('Morning Run')
  })

  it('marks the workout excluded only once every copy is, the same answer workout_count gives', () => {
    insert({ id: 'google-run', sourceId: 'google', attrs: GOOGLE_RUN })
    insert({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_RUN })
    const exclude = (id: string) => t.db.insert(overridesTable).values({
      id: `o-${id}`, personId: 'p1', scope: 'session', targetKey: sessionTarget(id),
      action: 'exclude', reason: 'duplicate', correctedValue: null, createdAtMs: 0,
    }).run()

    exclude('google-run')
    const [half] = q().sessions({ kind: 'exercise', from: '2026-09-20', to: '2026-09-20' })
    expect([half!.id, half!.excluded]).toEqual(['phone-run', false])

    exclude('phone-run')
    const [whole] = q().sessions({ kind: 'exercise', from: '2026-09-20', to: '2026-09-20' })
    expect([whole!.id, whole!.excluded, whole!.excludeReason]).toEqual(['google-run', true, 'duplicate'])
  })

  it('draws the route from the alternate when the primary carries none', () => {
    insert({ id: 'google-run', sourceId: 'google', attrs: GOOGLE_RUN })
    insert({ id: 'phone-run', sourceId: 'phone', attrs: PHONE_RUN })
    t.db.insert(sessionRoutes).values([0, 1].map((ordinal) => ({
      id: `r${ordinal}`, sessionId: 'phone-run', ordinal, atMs: START + ordinal * MINUTE,
      latitude: 52.1 + ordinal / 1000, longitude: 4.3, altitudeMetres: null,
      horizontalAccuracyMetres: null, verticalAccuracyMetres: null,
    }))).run()

    const route = q().workoutRoute({ sessionId: 'google-run' })
    expect(route!.map((p) => [p.atMs, p.latitude])).toEqual([[START, 52.1], [START + MINUTE, 52.101]])
  })

  it('leaves sleep as every source\'s rows, which the nightly merge already handles', () => {
    for (const [id, sourceId] of [['n1', 'google'], ['n2', 'phone']] as const) {
      t.db.insert(sessions).values({
        id, personId: 'p1', sourceId, kind: 'sleep', externalId: id, startMs: START, startOffsetMinutes: 120,
        endMs: START + 8 * 60 * MINUTE, endOffsetMinutes: 120, localDate: '2026-09-20', attrs: '{}', rawPayloadId: null,
      }).run()
    }
    expect(q().sessions({ kind: 'sleep', from: '2026-09-20', to: '2026-09-20' }).map((s) => s.id)).toEqual(['n1', 'n2'])
  })
})
