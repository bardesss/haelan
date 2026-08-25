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

function seedSource(h: Harness, personId: string, sourceId: string): void {
  h.app.haelan.instance.db.insert(schema.sources).values({
    id: sourceId, personId, externalId: sourceId, displayName: sourceId, kind: 'device', createdAtMs: 0,
  }).run()
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
// sourceId straight through to the response, which is what the table's markers ride on. The id is
// derived from personId and kind rather than a module level counter, since personId already makes
// an owner's row and a leak target's row distinct within one test.
function seedSession(h: Harness, input: { personId: string, sourceId: string, kind: 'sleep' | 'exercise' }): void {
  seedSource(h, input.personId, input.sourceId)
  const id = `${input.personId}-${input.kind}-session`
  const startMs = Date.parse('2026-08-01T09:00:00Z') - OFFSET_MINUTES * 60_000
  h.app.haelan.instance.db.insert(schema.sessions).values({
    id, personId: input.personId, sourceId: input.sourceId, kind: input.kind, externalId: id,
    startMs, startOffsetMinutes: OFFSET_MINUTES, endMs: startMs + 3_600_000, endOffsetMinutes: OFFSET_MINUTES,
    localDate: '2026-08-01', attrs: JSON.stringify({}), rawPayloadId: null,
  }).run()
}

interface RouteCase {
  name: string
  // The literal path pattern fastify registers, prefix included: what the route-coverage guard
  // below compares against what onRouteForTest actually observes. Not derived from `path`, which
  // carries a concrete personId and a query string, neither of which fastify's router sees.
  template: string
  path: (personId: string) => string
  // Seeds the session's own person (always 'p1') with an ordinary value.
  seedOwn: (h: Harness) => void
  // Seeds a second person with a value that would be unmistakable if it ever leaked into the
  // first person's answer.
  seedOther: (h: Harness, personId: string) => void
  ownNeedle: string
  otherNeedle: string
  // Extra assertions for a route whose answer is a computed statistic rather than a copy of the
  // seeded rows: a leaked row can move a mean so far from either seed that the response contains
  // neither needle literally, and the shape of the leak (an extra row contributing) is what a
  // count catches directly instead of leaving the failure to whichever needle assertion happens
  // to also fail. Unset for a route whose answer already carries the seeded values verbatim.
  extraOwnAssertions?: (body: unknown) => void
}

// Driven from a list rather than written per route, because the failure this guards against is a
// route added without a test, and a hand written suite cannot notice that. One entry per route
// registerV1 wires up (apps/server/src/routes/v1/index.ts): the four daily backed reads, the
// three tier 2 reads, /changes and /export (json and csv, since csv has its own serialiser).
const ROUTES: readonly RouteCase[] = [
  {
    name: 'series',
    template: '/api/v1/p/:personId/series',
    path: (p) => `/api/v1/p/${p}/series?metric=steps&agg=sum&from=2026-08-01&to=2026-08-01`,
    seedOwn: (h) => seedDaily(h, { personId: 'p1', localDate: '2026-08-01', value: 4242 }),
    seedOther: (h, personId) => seedDaily(h, { personId, localDate: '2026-08-01', value: 999_999 }),
    ownNeedle: '4242',
    otherNeedle: '999999',
  },
  {
    name: 'baselines',
    template: '/api/v1/p/:personId/baselines',
    // windowDays=5 reads back exactly 2026-08-01..2026-08-05 (the window ends the day before `on`).
    path: (p) => `/api/v1/p/${p}/baselines?metric=steps&agg=sum&on=2026-08-06&windowDays=5`,
    seedOwn: (h) => { for (let day = 1; day <= 5; day += 1) seedDaily(h, { personId: 'p1', localDate: dateOf(day), value: 4200 }) },
    seedOther: (h, personId) => { for (let day = 1; day <= 5; day += 1) seedDaily(h, { personId, localDate: dateOf(day), value: 999_999 }) },
    ownNeedle: '4200',
    otherNeedle: '999999',
    // A mean blending five 4200s with a leaked five 999999s reads 502099.5, containing neither
    // needle: the count of contributing days is what names an extra row directly.
    extraOwnAssertions: (body) => expect((body as { n: number }).n).toBe(5),
  },
  {
    name: 'insights',
    template: '/api/v1/p/:personId/insights',
    // The current range is 08-08..08-14; comparePeriods derives the previous range (08-01..08-07)
    // itself, so both fourteen days need a row for neither period to be refused as too thin.
    path: (p) => `/api/v1/p/${p}/insights?metric=steps&agg=sum&from=2026-08-08&to=2026-08-14`,
    seedOwn: (h) => { for (let day = 1; day <= 14; day += 1) seedDaily(h, { personId: 'p1', localDate: dateOf(day), value: 6500 }) },
    seedOther: (h, personId) => { for (let day = 1; day <= 14; day += 1) seedDaily(h, { personId, localDate: dateOf(day), value: 999_999 }) },
    ownNeedle: '6500',
    otherNeedle: '999999',
    extraOwnAssertions: (body) => expect((body as { currentDays: number }).currentDays).toBe(7),
  },
  {
    name: 'trend',
    template: '/api/v1/p/:personId/trend',
    // A constant series smooths to the same constant, so the marker survives the EWMA untouched.
    path: (p) => `/api/v1/p/${p}/trend?metric=steps&agg=sum&from=2026-08-01&to=2026-08-05`,
    seedOwn: (h) => { for (let day = 1; day <= 5; day += 1) seedDaily(h, { personId: 'p1', localDate: dateOf(day), value: 7100 }) },
    seedOther: (h, personId) => { for (let day = 1; day <= 5; day += 1) seedDaily(h, { personId, localDate: dateOf(day), value: 999_999 }) },
    ownNeedle: '7100',
    otherNeedle: '999999',
    extraOwnAssertions: (body) => expect(body).toHaveLength(5),
  },
  {
    name: 'intraday',
    template: '/api/v1/p/:personId/intraday',
    path: (p) => `/api/v1/p/${p}/intraday?metric=heart_rate&date=2026-08-22`,
    seedOwn: (h) => seedSample(h, { personId: 'p1', sourceId: 'own-source-ok', value: 61 }),
    seedOther: (h, personId) => seedSample(h, { personId, sourceId: 'leaked-source-999999', value: 62 }),
    ownNeedle: 'own-source-ok',
    otherNeedle: 'leaked-source-999999',
  },
  {
    name: 'sleep/nights',
    template: '/api/v1/p/:personId/sleep/nights',
    path: (p) => `/api/v1/p/${p}/sleep/nights?from=2026-08-01&to=2026-08-01`,
    seedOwn: (h) => seedSession(h, { personId: 'p1', sourceId: 'own-source-ok', kind: 'sleep' }),
    seedOther: (h, personId) => seedSession(h, { personId, sourceId: 'leaked-source-999999', kind: 'sleep' }),
    ownNeedle: 'own-source-ok',
    otherNeedle: 'leaked-source-999999',
  },
  {
    name: 'sessions',
    template: '/api/v1/p/:personId/sessions',
    path: (p) => `/api/v1/p/${p}/sessions?kind=exercise&from=2026-08-01&to=2026-08-01`,
    seedOwn: (h) => seedSession(h, { personId: 'p1', sourceId: 'own-source-ok', kind: 'exercise' }),
    seedOther: (h, personId) => seedSession(h, { personId, sourceId: 'leaked-source-999999', kind: 'exercise' }),
    ownNeedle: 'own-source-ok',
    otherNeedle: 'leaked-source-999999',
  },
  {
    name: 'changes',
    template: '/api/v1/p/:personId/changes',
    // changes has no metric parameter; the metric name written to the row is the marker instead.
    path: (p) => `/api/v1/p/${p}/changes?since=0`,
    seedOwn: (h) => seedDaily(h, { personId: 'p1', localDate: '2026-08-01', metric: 'floors', value: 1, updatedAtMs: 1_000 }),
    seedOther: (h, personId) => seedDaily(h, { personId, localDate: '2026-08-01', metric: 'leaked-metric-999999', value: 1, updatedAtMs: 1_000 }),
    ownNeedle: 'floors',
    otherNeedle: 'leaked-metric-999999',
  },
  {
    name: 'export (json)',
    template: '/api/v1/p/:personId/export',
    path: (p) => `/api/v1/p/${p}/export?format=json&metric=steps&agg=sum&from=2026-08-01&to=2026-08-01`,
    seedOwn: (h) => seedDaily(h, { personId: 'p1', localDate: '2026-08-01', value: 8080 }),
    seedOther: (h, personId) => seedDaily(h, { personId, localDate: '2026-08-01', value: 999_999 }),
    ownNeedle: '8080',
    otherNeedle: '999999',
  },
  {
    name: 'export (csv)',
    // Same route as the json case above; the csv branch has its own serialiser in export.ts and
    // the gate never reaches it if only format=json is ever exercised.
    template: '/api/v1/p/:personId/export',
    path: (p) => `/api/v1/p/${p}/export?format=csv&metric=steps&agg=sum&from=2026-08-01&to=2026-08-01`,
    seedOwn: (h) => seedDaily(h, { personId: 'p1', localDate: '2026-08-01', value: 8090 }),
    seedOther: (h, personId) => seedDaily(h, { personId, localDate: '2026-08-01', value: 888_888 }),
    ownNeedle: '8090',
    otherNeedle: '888888',
  },
]

describe.each(ROUTES)('the versioned surface is isolated per person: $name', (route) => {
  it('answers 401 with no session at all', async () => {
    harness = await withServer()
    await harness.signIn()
    const response = await harness.app.inject({ method: 'GET', url: route.path('p1') })
    expect(response.statusCode).toBe(401)
  })

  // The tautology guard: an account owns exactly one person today, so this proves the path
  // segment is actually checked rather than decorative. The envelope's code, not just the status,
  // is what tells this apart from any other reason a route might answer 403.
  it('answers 403 for a person the session does not own', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    const other = await harness.addPerson({ id: 'p2', displayName: 'Wilma', username: 'wilma' })
    const response = await harness.app.inject({
      method: 'GET', url: route.path(other.personId),
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { kind: 'forbidden', code: 'not_your_person' } })
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
    route.extraOwnAssertions?.(response.json())
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

  // Every per-route 401 case above uses 'p1', a real person, so none of them can tell a correct
  // guard apart from one that checks the person before the session: both orderings answer 401 for
  // a real id. If requirePerson were ever reordered that way, an unauthenticated request would
  // become a person id enumeration oracle, 404 for a real id and 401 for an unknown one, and every
  // per-route 401 case above would stay green regardless. Only an unknown id, with no session,
  // actually exercises that ordering.
  it('answers 401 for an unknown person with no session, not 404', async () => {
    harness = await withServer()
    await harness.signIn()
    const response = await harness.app.inject({
      method: 'GET', url: '/api/v1/p/nobody/series?metric=steps&agg=sum&from=2026-08-01&to=2026-08-02',
    })
    expect(response.statusCode).toBe(401)
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

  // Routes under /api/v1 that are deliberately not person scoped, and so carry no isolation case
  // in the table above. Adding one here is a conscious edit to this list; filtering the guard
  // below to only '/api/v1/p/' would instead let such a route slip past it with nobody noticing.
  // Empty today: every route registerV1 wires up is under /p/.
  const NOT_PERSON_SCOPED: readonly string[] = []

  // R19: its own harness, not the outer describe's shared variable, since this test has to run on
  // its own regardless of which per-route case ran last.
  //
  // Not printRoutes: it merges several methods on one path onto a single line, so a second method
  // added to an existing path is invisible to a line count, and it nests a route whose path
  // extends another registered route's path under that route's line instead of printing it in
  // full, so a route added under an existing one is invisible too. Both were confirmed against
  // this exact route set before ruling printRoutes out. onRouteForTest instead observes fastify's
  // own onRoute hook, wired in by app.ts before any route is registered, which fires once per
  // (method, url) pair exactly as fastify's router sees it: no merging, no nesting. HEAD is
  // dropped because fastify re-enters route registration to add it for every GET as its own call,
  // so it would otherwise show up as an entry nobody in this table declared.
  //
  // Compared as a set in both directions, not a count, so a mismatch names the offending route
  // rather than failing with an opaque "expected 10 to be 9" that means nothing to whoever trips
  // it next.
  it('covers every route the versioned surface registers', async () => {
    const registered = new Set<string>()
    const isolatedHarness = await withServer({
      onRouteForTest: (route) => {
        if (route.method === 'HEAD') return
        if (route.url.startsWith('/api/v1')) registered.add(`${route.method} ${route.url}`)
      },
    })
    try {
      const covered = new Set([...ROUTES.map((route) => `GET ${route.template}`), ...NOT_PERSON_SCOPED])
      const missing = [...registered].filter((entry) => !covered.has(entry))
      const stale = [...covered].filter((entry) => !registered.has(entry))
      expect({ missing, stale }).toEqual({ missing: [], stale: [] })
    } finally {
      await isolatedHarness.cleanup()
    }
  })
})
