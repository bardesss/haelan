import { describe, it, expect, afterEach } from 'vitest'
import { DERIVATION_VERSION, schema } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

// August in Europe/Amsterdam, the timezone every harness person carries (both the default and
// anyone addPerson creates), matching the constant v1-tier2.test.ts already established.
const OFFSET_MINUTES = 120

function dateOf(day: number): string {
  return `2026-08-${String(day).padStart(2, '0')}`
}

// The `daily` seed every daily backed route in the table below draws on. updatedAtMs defaults to
// null, which is fine for every route here except /changes, which filters on it and has to pass
// one explicitly.
function seedDaily(h: Harness, input: {
  personId: string
  localDate: string
  value: number
  metric?: string
  updatedAtMs?: number | null
}): void {
  h.app.haelan.instance.db.insert(schema.daily).values({
    personId: input.personId,
    localDate: input.localDate,
    metric: input.metric ?? 'steps',
    agg: 'sum',
    source: 'merged',
    value: input.value,
    coverage: null,
    sourceMix: null,
    derivationVersion: DERIVATION_VERSION,
    updatedAtMs: input.updatedAtMs ?? null,
  }).run()
}

// sources.id is a global primary key, not scoped per person, but the table below only ever seeds
// one owner and one leak target per case, so a plain id is enough to keep them apart.
function seedSource(h: Harness, personId: string, sourceId: string): void {
  h.app.haelan.instance.db.insert(schema.sources).values({
    id: sourceId, personId, externalId: sourceId, displayName: sourceId, kind: 'device', createdAtMs: 0,
  }).onConflictDoNothing().run()
}

// The `samples` seed /intraday reads. One minute on one day is enough; the marker this suite
// checks for lives in sourceId, not in the value.
function seedSample(h: Harness, input: { personId: string, sourceId: string, value: number }): void {
  seedSource(h, input.personId, input.sourceId)
  const utcMs = Date.UTC(2026, 7, 22, 9, 0) - OFFSET_MINUTES * 60_000
  h.app.haelan.instance.db.insert(schema.samples).values({
    personId: input.personId, sourceId: input.sourceId, metric: 'heart_rate',
    utcMs, tzOffsetMinutes: OFFSET_MINUTES, agg: 'mean', value: input.value, n: 1, rawPayloadId: null,
  }).run()
}

// The `sessions` seed /sleep/nights and /sessions read, one kind at a time. Both readers carry
// sourceId straight through to the response, which is what the table's markers ride on.
let sessionCounter = 0
function seedSession(h: Harness, input: { personId: string, sourceId: string, kind: 'sleep' | 'exercise' }): void {
  seedSource(h, input.personId, input.sourceId)
  sessionCounter += 1
  const id = `session-${sessionCounter}`
  const startMs = Date.parse('2026-08-01T09:00:00Z') - OFFSET_MINUTES * 60_000
  h.app.haelan.instance.db.insert(schema.sessions).values({
    id, personId: input.personId, sourceId: input.sourceId, kind: input.kind, externalId: id,
    startMs, startOffsetMinutes: OFFSET_MINUTES, endMs: startMs + 3_600_000, endOffsetMinutes: OFFSET_MINUTES,
    localDate: '2026-08-01', attrs: JSON.stringify({}), rawPayloadId: null,
  }).run()
}

interface RouteCase {
  name: string
  path: (personId: string) => string
  // Seeds the session's own person (always 'p1') with an ordinary value.
  seedOwn: (h: Harness) => void
  // Seeds a second person with a value that would be unmistakable if it ever leaked into the
  // first person's answer.
  seedOther: (h: Harness, personId: string) => void
  ownNeedle: string
  otherNeedle: string
}

// Driven from a list rather than written per route, because the failure this guards against is a
// route added without a test, and a hand written suite cannot notice that. One entry per route
// registerV1 wires up (apps/server/src/routes/v1/index.ts): the four daily backed reads, the
// three tier 2 reads, /changes and /export.
const ROUTES: readonly RouteCase[] = [
  {
    name: 'series',
    path: (p) => `/api/v1/p/${p}/series?metric=steps&agg=sum&from=2026-08-01&to=2026-08-01`,
    seedOwn: (h) => seedDaily(h, { personId: 'p1', localDate: '2026-08-01', value: 4242 }),
    seedOther: (h, personId) => seedDaily(h, { personId, localDate: '2026-08-01', value: 999_999 }),
    ownNeedle: '4242',
    otherNeedle: '999999',
  },
  {
    name: 'baselines',
    // windowDays=5 reads back exactly 2026-08-01..2026-08-05 (the window ends the day before `on`).
    path: (p) => `/api/v1/p/${p}/baselines?metric=steps&agg=sum&on=2026-08-06&windowDays=5`,
    seedOwn: (h) => { for (let day = 1; day <= 5; day += 1) seedDaily(h, { personId: 'p1', localDate: dateOf(day), value: 4200 }) },
    seedOther: (h, personId) => { for (let day = 1; day <= 5; day += 1) seedDaily(h, { personId, localDate: dateOf(day), value: 999_999 }) },
    ownNeedle: '4200',
    otherNeedle: '999999',
  },
  {
    name: 'insights',
    // The current range is 08-08..08-14; comparePeriods derives the previous range (08-01..08-07)
    // itself, so both fourteen days need a row for neither period to be refused as too thin.
    path: (p) => `/api/v1/p/${p}/insights?metric=steps&agg=sum&from=2026-08-08&to=2026-08-14`,
    seedOwn: (h) => { for (let day = 1; day <= 14; day += 1) seedDaily(h, { personId: 'p1', localDate: dateOf(day), value: 6500 }) },
    seedOther: (h, personId) => { for (let day = 1; day <= 14; day += 1) seedDaily(h, { personId, localDate: dateOf(day), value: 999_999 }) },
    ownNeedle: '6500',
    otherNeedle: '999999',
  },
  {
    name: 'trend',
    // A constant series smooths to the same constant, so the marker survives the EWMA untouched.
    path: (p) => `/api/v1/p/${p}/trend?metric=steps&agg=sum&from=2026-08-01&to=2026-08-05`,
    seedOwn: (h) => { for (let day = 1; day <= 5; day += 1) seedDaily(h, { personId: 'p1', localDate: dateOf(day), value: 7100 }) },
    seedOther: (h, personId) => { for (let day = 1; day <= 5; day += 1) seedDaily(h, { personId, localDate: dateOf(day), value: 999_999 }) },
    ownNeedle: '7100',
    otherNeedle: '999999',
  },
  {
    name: 'intraday',
    path: (p) => `/api/v1/p/${p}/intraday?metric=heart_rate&date=2026-08-22`,
    seedOwn: (h) => seedSample(h, { personId: 'p1', sourceId: 'own-source-ok', value: 61 }),
    seedOther: (h, personId) => seedSample(h, { personId, sourceId: 'leaked-source-999999', value: 62 }),
    ownNeedle: 'own-source-ok',
    otherNeedle: 'leaked-source-999999',
  },
  {
    name: 'sleep/nights',
    path: (p) => `/api/v1/p/${p}/sleep/nights?from=2026-08-01&to=2026-08-01`,
    seedOwn: (h) => seedSession(h, { personId: 'p1', sourceId: 'own-source-ok', kind: 'sleep' }),
    seedOther: (h, personId) => seedSession(h, { personId, sourceId: 'leaked-source-999999', kind: 'sleep' }),
    ownNeedle: 'own-source-ok',
    otherNeedle: 'leaked-source-999999',
  },
  {
    name: 'sessions',
    path: (p) => `/api/v1/p/${p}/sessions?kind=exercise&from=2026-08-01&to=2026-08-01`,
    seedOwn: (h) => seedSession(h, { personId: 'p1', sourceId: 'own-source-ok', kind: 'exercise' }),
    seedOther: (h, personId) => seedSession(h, { personId, sourceId: 'leaked-source-999999', kind: 'exercise' }),
    ownNeedle: 'own-source-ok',
    otherNeedle: 'leaked-source-999999',
  },
  {
    name: 'changes',
    // changes has no metric parameter; the metric name written to the row is the marker instead.
    path: (p) => `/api/v1/p/${p}/changes?since=0`,
    seedOwn: (h) => seedDaily(h, { personId: 'p1', localDate: '2026-08-01', metric: 'floors', value: 1, updatedAtMs: 1_000 }),
    seedOther: (h, personId) => seedDaily(h, { personId, localDate: '2026-08-01', metric: 'leaked-metric-999999', value: 1, updatedAtMs: 1_000 }),
    ownNeedle: 'floors',
    otherNeedle: 'leaked-metric-999999',
  },
  {
    name: 'export',
    path: (p) => `/api/v1/p/${p}/export?format=json&metric=steps&agg=sum&from=2026-08-01&to=2026-08-01`,
    seedOwn: (h) => seedDaily(h, { personId: 'p1', localDate: '2026-08-01', value: 8080 }),
    seedOther: (h, personId) => seedDaily(h, { personId, localDate: '2026-08-01', value: 999_999 }),
    ownNeedle: '8080',
    otherNeedle: '999999',
  },
]

describe.each(ROUTES)('$name', (route) => {
  it('answers 401 with no session at all', async () => {
    harness = await withServer()
    await harness.signIn()
    const response = await harness.app.inject({ method: 'GET', url: route.path('p1') })
    expect(response.statusCode).toBe(401)
  })

  it('answers 403 for a person the session does not own', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    const other = await harness.addPerson({ id: 'p2', displayName: 'Wilma', username: 'wilma' })
    const response = await harness.app.inject({
      method: 'GET', url: route.path(other.personId),
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(403)
  })

  // Ruling R20: the positive control. A suite built only from 403s passes in full even if the
  // guard were broken to deny everyone, including the owner, which a 403-only suite cannot tell
  // apart from a working one. Seeding the other person's data first and then reading the owner's
  // own answer is what makes this able to fail two different ways: the other person's marker
  // showing up is a leak, and the owner's own marker missing is over-denial or a forgotten
  // person_id filter in the query underneath. Asserting the sentinel's absence on a 403 response
  // would prove nothing, since a forbidden answer was never going to carry a body worth reading.
  it("answers 200 for the session's own person, carrying only their own data", async () => {
    harness = await withServer()
    const token = await harness.signIn()
    const other = await harness.addPerson({ id: 'p2', displayName: 'Wilma', username: 'wilma' })
    route.seedOwn(harness)
    route.seedOther(harness, other.personId)

    const response = await harness.app.inject({
      method: 'GET', url: route.path('p1'),
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain(route.ownNeedle)
    expect(response.body).not.toContain(route.otherNeedle)
  })
})

describe('the versioned surface, beyond the per-route table', () => {
  // 404 rather than 403 for a person id nobody owns: the guard has to tell "not yours" from
  // "does not exist" for every route alike, which the per-route table does not need to repeat
  // since requirePerson makes this decision once, ahead of any route's own handler.
  it('answers 404 for a person id that does not exist, rather than 403', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    const response = await harness.app.inject({
      method: 'GET', url: '/api/v1/p/nobody/series?metric=steps&agg=sum&from=2026-08-01&to=2026-08-02',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(404)
  })

  // The guard has to be a property of the plugin, not of a list every route remembers to carry.
  // This route is registered with no preHandler of its own; if it answers 200 without a session,
  // the hook is not doing the guarding and the per-route array is back to being load bearing.
  it('guards a route that carries no preHandler of its own, because the hook covers the plugin', async () => {
    harness = await withServer({
      v1TestExtra: (app) => {
        app.get('/canary', async () => ({ ok: true }))
      },
    })
    await harness.signIn()
    const response = await harness.app.inject({ method: 'GET', url: '/api/v1/canary' })
    expect(response.statusCode).toBe(401)
  })

  // R19: its own harness, not the outer describe's shared variable, since this test has to run
  // on its own regardless of which per-route case ran last.
  //
  // printRoutes({ commonPrefix: false }) was checked before relying on it: it does not collapse
  // routes into a radix tree the way the default call does, it prints one line per distinct
  // registered path with that path's methods grouped in parens (e.g. "/hello (GET, HEAD, PUT)").
  // Every route in ROUTES is GET only and no two share a path, so the line count and ROUTES.length
  // line up exactly; there was no need to fall back to the onRoute hook.
  it('covers every route the versioned surface registers', async () => {
    const isolatedHarness = await withServer()
    try {
      const registered = isolatedHarness.app.printRoutes({ commonPrefix: false })
        .split('\n').filter((line) => line.includes('/api/v1/p/'))
      expect(registered.length).toBe(ROUTES.length)
    } finally {
      await isolatedHarness.cleanup()
    }
  })
})
