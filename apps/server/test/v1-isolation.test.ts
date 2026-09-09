import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { DERIVATION_VERSION, dayMetricTarget, insertSample, schema } from '@haelan/core'
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
  insertSample(h.app.haelan.instance.db, {
    personId: input.personId, sourceId: input.sourceId, metric: 'heart_rate',
    utcMs, tzOffsetMinutes: OFFSET_MINUTES, agg: 'mean', value: input.value,
  })
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
    // The range runs one day past what the owner seeds. series() runs its rows through
    // preferMerged (personQuery.ts), a Map keyed on localDate alone: a leak target seeded on the
    // same date as the owner would not add a row, it would overwrite one, and whether the
    // needles fire would then depend on SQLite's row order rather than on isolation actually
    // holding. Seeding the leak target on a date the owner has no row for makes a leak add a row
    // instead, so the assertions below hold regardless of row order.
    path: (p) => `/api/v1/p/${p}/series?metric=steps&agg=sum&from=2026-08-01&to=2026-08-02`,
    seedOwn: (h) => seedDaily(h, { personId: 'p1', localDate: '2026-08-01', value: 4242 }),
    seedOther: (h, personId) => seedDaily(h, { personId, localDate: '2026-08-02', value: 999_999 }),
    ownNeedle: '4242',
    otherNeedle: '999999',
  },
  {
    name: 'baselines',
    template: '/api/v1/p/:personId/baselines',
    // windowDays=6 reads back 2026-08-01..2026-08-06 (the window ends the day before `on`). The
    // owner seeds only the first five of those six days; the leak target seeds only the sixth, a
    // date the owner has no row for. baseline() calls series(), which dedupes by localDate alone
    // (preferMerged, personQuery.ts): a leak seeded on a date the owner already has would
    // overwrite rather than add, leaving n at 5 whichever row SQLite happened to keep. Seeded on
    // its own date, a leak adds a sixth contributing day and n moves to 6.
    path: (p) => `/api/v1/p/${p}/baselines?metric=steps&agg=sum&on=2026-08-07&windowDays=6`,
    seedOwn: (h) => { for (let day = 1; day <= 5; day += 1) seedDaily(h, { personId: 'p1', localDate: dateOf(day), value: 4200 }) },
    seedOther: (h, personId) => seedDaily(h, { personId, localDate: dateOf(6), value: 999_999 }),
    ownNeedle: '4200',
    otherNeedle: '999999',
    // thin is true here on purpose: baselineOf's floor is min(BASELINE_MIN_DAYS, windowDays), and
    // widening the window to six days while the owner still has five drops n below that floor.
    // The gap date the leak needs (see the comment above) costs this control a non-thin baseline;
    // asserted rather than left silent, so a reader sees that trade rather than rediscovering it.
    extraOwnAssertions: (body) => {
      const { baseline } = body as { baseline: { n: number, thin: boolean } }
      expect(baseline.n).toBe(5)
      expect(baseline.thin).toBe(true)
    },
  },
  {
    name: 'insights',
    template: '/api/v1/p/:personId/insights',
    // The current range is 08-08..08-15, one day past the fourteen the owner seeds; the leak
    // target seeds only that fifteenth day. comparePeriods calls series() for the current range,
    // which dedupes by localDate alone (preferMerged, personQuery.ts): a leak on a date the owner
    // already has would overwrite rather than add, leaving currentDays at 7 either way. Seeded on
    // its own date, a leak adds an eighth contributing day and currentDays moves to 8.
    path: (p) => `/api/v1/p/${p}/insights?metric=steps&agg=sum&from=2026-08-08&to=2026-08-15`,
    seedOwn: (h) => { for (let day = 1; day <= 14; day += 1) seedDaily(h, { personId: 'p1', localDate: dateOf(day), value: 6500 }) },
    seedOther: (h, personId) => seedDaily(h, { personId, localDate: dateOf(15), value: 999_999 }),
    ownNeedle: '6500',
    otherNeedle: '999999',
    extraOwnAssertions: (body) => expect((body as { currentDays: number }).currentDays).toBe(7),
  },
  {
    name: 'trend',
    template: '/api/v1/p/:personId/trend',
    // The range runs to 08-06, one day past the five the owner seeds; the leak target seeds only
    // that sixth day. trend() calls series(), which dedupes by localDate alone (preferMerged,
    // personQuery.ts): a leak on a date the owner already has would overwrite rather than add,
    // leaving the trend at five points either way. Seeded on its own date, a leak adds a sixth
    // point. A constant series smooths to the same constant, so the owner's marker survives the
    // EWMA untouched.
    path: (p) => `/api/v1/p/${p}/trend?metric=steps&agg=sum&from=2026-08-01&to=2026-08-06`,
    seedOwn: (h) => { for (let day = 1; day <= 5; day += 1) seedDaily(h, { personId: 'p1', localDate: dateOf(day), value: 7100 }) },
    seedOther: (h, personId) => seedDaily(h, { personId, localDate: dateOf(6), value: 999_999 }),
    ownNeedle: '7100',
    otherNeedle: '999999',
    extraOwnAssertions: (body) => expect((body as { points: unknown[] }).points).toHaveLength(5),
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
    // export calls series() too, so the same dedupe-by-localDate risk applies (see the series
    // entry above): the leak target seeds a date the owner does not have, one day past the
    // owner's, rather than the owner's own date.
    path: (p) => `/api/v1/p/${p}/export?format=json&metric=steps&agg=sum&from=2026-08-01&to=2026-08-02`,
    seedOwn: (h) => seedDaily(h, { personId: 'p1', localDate: '2026-08-01', value: 8080 }),
    seedOther: (h, personId) => seedDaily(h, { personId, localDate: '2026-08-02', value: 999_999 }),
    ownNeedle: '8080',
    otherNeedle: '999999',
  },
  {
    name: 'export (csv)',
    // Same route as the json case above; the csv branch has its own serialiser in export.ts and
    // the gate never reaches it if only format=json is ever exercised. Same dedupe-by-localDate
    // risk too, so the same gap-date seeding.
    template: '/api/v1/p/:personId/export',
    path: (p) => `/api/v1/p/${p}/export?format=csv&metric=steps&agg=sum&from=2026-08-01&to=2026-08-02`,
    seedOwn: (h) => seedDaily(h, { personId: 'p1', localDate: '2026-08-01', value: 8090 }),
    seedOther: (h, personId) => seedDaily(h, { personId, localDate: '2026-08-02', value: 888_888 }),
    ownNeedle: '8090',
    otherNeedle: '888888',
  },
  // Task 6's three list reads, promoted from the interim single test that guarded them (a POST
  // and a DELETE test written ahead of this table, both cases described in shared.ts's own commit
  // history). These carry no aggregation, so unlike series/baselines/insights/trend above there is
  // no computed statistic a leaked row could move; the seeded body is what the response echoes
  // back, verbatim, same as intraday/sleep/sessions above.
  {
    name: 'notes',
    template: '/api/v1/p/:personId/notes',
    path: (p) => `/api/v1/p/${p}/notes?from=${dateOf(1)}&to=${dateOf(1)}`,
    seedOwn: (h) => h.app.haelan.instance.notes.put({ personId: 'p1', localDate: dateOf(1), body: 'own-note-ok', nowMs: h.clock.nowMs }),
    seedOther: (h, personId) => h.app.haelan.instance.notes.put({ personId, localDate: dateOf(1), body: 'leaked-note-999999', nowMs: h.clock.nowMs }),
    ownNeedle: 'own-note-ok',
    otherNeedle: 'leaked-note-999999',
  },
  {
    name: 'events',
    template: '/api/v1/p/:personId/events',
    path: (p) => `/api/v1/p/${p}/events?from=${dateOf(1)}&to=${dateOf(1)}`,
    seedOwn: (h) => h.app.haelan.instance.events.add({
      personId: 'p1', kind: 'own-event-ok', startedAtMs: Date.parse('2026-08-01T09:00:00Z'), startedAtOffsetMinutes: 0,
    }),
    seedOther: (h, personId) => h.app.haelan.instance.events.add({
      personId, kind: 'leaked-kind-999999', startedAtMs: Date.parse('2026-08-01T09:00:00Z'), startedAtOffsetMinutes: 0,
    }),
    ownNeedle: 'own-event-ok',
    otherNeedle: 'leaked-kind-999999',
  },
  {
    name: 'overrides',
    template: '/api/v1/p/:personId/overrides',
    // No date range on this route (see the handler's own comment for why), so both people are
    // seeded on the same date without the dedupe-by-localDate risk the aggregate reads above
    // guard against: listFor is a flat scan by personId, not a Map keyed on localDate.
    path: (p) => `/api/v1/p/${p}/overrides`,
    seedOwn: (h) => h.app.haelan.instance.overrides.put({
      personId: 'p1', scope: 'day_metric', targetKey: dayMetricTarget({ localDate: dateOf(2), metric: 'steps' }),
      action: 'exclude', reason: 'own-reason-ok', nowMs: h.clock.nowMs,
    }),
    seedOther: (h, personId) => h.app.haelan.instance.overrides.put({
      personId, scope: 'day_metric', targetKey: dayMetricTarget({ localDate: dateOf(2), metric: 'floors' }),
      action: 'exclude', reason: 'leaked-reason-999999', nowMs: h.clock.nowMs,
    }),
    ownNeedle: 'own-reason-ok',
    otherNeedle: 'leaked-reason-999999',
  },
  {
    name: 'sources',
    template: '/api/v1/p/:personId/sources',
    // No date range on this route either: it lists every source a person has, so the marker rides
    // on the source's own id/externalId/displayName rather than on a seeded day.
    path: (p) => `/api/v1/p/${p}/sources`,
    seedOwn: (h) => seedSource(h, 'p1', 'own-source-ok'),
    seedOther: (h, personId) => seedSource(h, personId, 'leaked-source-999999'),
    ownNeedle: 'own-source-ok',
    otherNeedle: 'leaked-source-999999',
  },
  {
    name: 'data-types',
    template: '/api/v1/p/:personId/data-types',
    // This route's items are the catalogue itself, the same list for every person; the only thing
    // that varies per person is which entries carry excluded: true. So unlike every route above,
    // a leak here would not add or remove an id, it would flip a boolean on an id that is already
    // in both people's answers - which is why the needles below are JSON fragments naming a
    // specific id *and* its excluded value, not just the id on its own (both people's answers
    // contain the literal text "weight", exclusion aside). hydration-log and weight are both real,
    // listable catalogue ids (catalogue.ts), chosen only because they are not steps, which the
    // first GET test in v1-data-types.test.ts already pins at excluded: false by default.
    path: (p) => `/api/v1/p/${p}/data-types`,
    seedOwn: (h) => h.app.haelan.instance.excludedDataTypes.setFor({ personId: 'p1', dataTypeIds: ['hydration-log'], nowMs: h.clock.nowMs }),
    seedOther: (h, personId) => h.app.haelan.instance.excludedDataTypes.setFor({ personId, dataTypeIds: ['weight'], nowMs: h.clock.nowMs }),
    ownNeedle: '"id":"hydration-log","tier":"daily","excluded":true',
    otherNeedle: '"id":"weight","tier":"daily","excluded":true',
    extraOwnAssertions: (body) => {
      const items = (body as { items: { id: string, excluded: boolean }[] }).items
      expect(items.find((i) => i.id === 'weight')?.excluded).toBe(false)
    },
  },
]

describe.each(ROUTES)('the versioned surface is isolated per person: $name', (route) => {
  // One harness for all three cases below: none of them writes, they only read the same seeded
  // rows back through a different session (none, someone else's, the owner's), so a fresh
  // database per case buys nothing but boot time. beforeAll/afterAll rather than the per test
  // withServer + afterEach every other describe.each block used, since the seeding below has to
  // run once, before any of the three requests, not once per request.
  let routeHarness: Harness
  let token: string
  let otherPersonId: string

  beforeAll(async () => {
    routeHarness = await withServer()
    token = await routeHarness.signIn()
    const other = await routeHarness.addPerson({ id: 'p2', displayName: 'Wilma', username: 'wilma' })
    otherPersonId = other.personId
    route.seedOwn(routeHarness)
    route.seedOther(routeHarness, otherPersonId)
  })

  afterAll(async () => {
    await routeHarness.cleanup()
  })

  // The body, not only the status: an expired session is the most common error any client of this
  // surface will ever see, and the one shape a client narrowing on body.error.kind has to be able
  // to read. A status-only assertion here is what let ten route entries agree on 401 while
  // answering the older families' flat { error: 'no_session' } instead of the envelope.
  it('answers 401 with no session at all, in the envelope shape', async () => {
    const response = await routeHarness.app.inject({ method: 'GET', url: route.path('p1') })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: { kind: 'unauthorized', code: 'no_session' } })
  })

  // The tautology guard: an account owns exactly one person today, so this proves the path
  // segment is actually checked rather than decorative. The envelope's code, not just the status,
  // is what tells this apart from any other reason a route might answer 403.
  it('answers 403 for a person the session does not own', async () => {
    const response = await routeHarness.app.inject({
      method: 'GET', url: route.path(otherPersonId),
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
    const response = await routeHarness.app.inject({
      method: 'GET', url: route.path('p1'),
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    // Ahead of the two needle checks: on an aggregate route a leak can fail this without ever
    // touching either needle (see the baselines, insights and trend entries above), and a failure
    // here should name the count that actually moved rather than be masked by a needle expect
    // that happens to run first and reports a less specific reason.
    route.extraOwnAssertions?.(response.json())
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

  // The mutations, which the GET shaped table above cannot express: a write has no needle to look
  // for in a body, it has a row that must not exist afterwards. Listed so the coverage guard sees
  // them; the three cases every read above gets, plus the write specific proof, are exercised by
  // the describe blocks below rather than merely declared.
  const WRITE_ROUTES: readonly string[] = [
    'POST /api/v1/p/:personId/overrides',
    'DELETE /api/v1/p/:personId/overrides/:overrideId',
    'PUT /api/v1/p/:personId/notes/:localDate',
    'DELETE /api/v1/p/:personId/notes/:localDate',
    'POST /api/v1/p/:personId/events',
    'DELETE /api/v1/p/:personId/events/:eventId',
    'PUT /api/v1/p/:personId/sources/:sourceId/alias',
    'DELETE /api/v1/p/:personId/sources/:sourceId/alias',
    'PUT /api/v1/p/:personId/data-types',
  ]

  // A mutating request is refused by the origin hook unless these two agree, so a write test that
  // sent neither would pass on a 403 that has nothing to do with whose data it touched. The 401
  // cases below send neither, deliberately: they run before a session is even looked at, the same
  // ordering the "401 for an unknown person" case above proves for reads, and no Origin header at
  // all passes the hook unconditionally (see auth.ts), so omitting it does not manufacture the 401.
  const ORIGIN = { origin: 'http://localhost:4235', host: 'localhost:4235' }

  // Every write case below follows the same shape the brief asks for: 401 with no session, 403 for
  // a person the session does not own, and 200 for its own person. The 403 case is the one that
  // matters most, and on a write "matters" means more than the status: a route could act and then
  // answer 403, and every status-only assertion here would still pass. So every case reads a row
  // back afterwards through the store rather than the route it just called, and checks it still
  // says what it said before the request.
  //
  // The row read back differs by case, on purpose. The 401 cases aim the request at p1's own path
  // (there is no session to resolve it against, so the path segment is otherwise arbitrary) and
  // read p1's own row afterwards: a guard removed there would let the write through against p1, not
  // p2, so p2's row was never the one at risk and asserting it proves nothing. The 403 cases aim at
  // p2's path from a p1 session and read p2's row, the one the request actually named. See
  // task-7-report.md for what these assertions do and do not reach architecturally in this
  // codebase, and for the canaries that prove each one fires when it should.
  describe('override writes', () => {
    it('answers 401 with no session at all, before touching anything', async () => {
      harness = await withServer()
      await harness.signIn()
      await harness.addPerson({ id: 'p2', displayName: 'Someone else', username: 'other' })
      const overrides = harness.app.haelan.instance.overrides
      const theirs = overrides.put({
        personId: 'p2', scope: 'day_metric', targetKey: dayMetricTarget({ localDate: dateOf(1), metric: 'steps' }),
        action: 'exclude', reason: 'theirs', nowMs: harness.clock.nowMs,
      })

      const written = await harness.app.inject({
        method: 'POST', url: '/api/v1/p/p1/overrides',
        payload: {
          scope: 'day_metric', targetKey: dayMetricTarget({ localDate: dateOf(2), metric: 'steps' }),
          action: 'exclude', reason: 'no session to write with',
        },
      })
      expect(written.statusCode).toBe(401)
      expect(written.json()).toMatchObject({ error: { kind: 'unauthorized', code: 'no_session' } })

      const removed = await harness.app.inject({ method: 'DELETE', url: `/api/v1/p/p1/overrides/${theirs}` })
      expect(removed.statusCode).toBe(401)
      // p1, not p2: both requests above name p1 in the path, so a guard that failed open would
      // create or delete p1's own row, never p2's. p2's row is read too, for the symmetry, but it
      // was never the one a broken guard here would touch.
      expect(overrides.listFor('p1')).toEqual([])
      expect(overrides.listFor('p2').map((row) => row.id)).toEqual([theirs])
    })

    // Both directions of the first write path in the project: writing into somebody else's
    // record, and deleting out of it with an id that is not a secret. The surviving row is the
    // assertion that matters; a 403 alone would also be answered by a route that refused after
    // acting.
    it('refuses both writes against another person, and leaves their rows alone', async () => {
      harness = await withServer()
      const token = await harness.signIn()
      await harness.addPerson({ id: 'p2', displayName: 'Someone else', username: 'other' })
      const overrides = harness.app.haelan.instance.overrides
      const theirs = overrides.put({
        personId: 'p2', scope: 'day_metric', targetKey: dayMetricTarget({ localDate: dateOf(1), metric: 'steps' }),
        action: 'exclude', reason: 'theirs', nowMs: harness.clock.nowMs,
      })

      const written = await harness.app.inject({
        method: 'POST', url: '/api/v1/p/p2/overrides',
        headers: { authorization: `Bearer ${token}`, ...ORIGIN },
        payload: {
          scope: 'day_metric', targetKey: dayMetricTarget({ localDate: dateOf(2), metric: 'steps' }),
          action: 'exclude', reason: 'not mine to write',
        },
      })
      expect(written.statusCode).toBe(403)
      // The envelope, not only the status: auth.ts's origin hook also answers a bare 403 (a flat
      // { error: 'bad_origin' }), on any mutating request whose Origin and Host disagree. Dropping
      // ORIGIN's `host` by accident would make this case a same-status, wrong-reason pass; the
      // code below is what tells the two apart.
      expect(written.json()).toMatchObject({ error: { kind: 'forbidden', code: 'not_your_person' } })

      const removed = await harness.app.inject({
        method: 'DELETE', url: `/api/v1/p/p2/overrides/${theirs}`,
        headers: { authorization: `Bearer ${token}`, ...ORIGIN },
      })
      expect(removed.statusCode).toBe(403)
      expect(removed.json()).toMatchObject({ error: { kind: 'forbidden', code: 'not_your_person' } })
      expect(overrides.listFor('p2').map((row) => row.id)).toEqual([theirs])
    })

    it("writes and removes an override for the session's own person", async () => {
      harness = await withServer()
      const token = await harness.signIn()
      const overrides = harness.app.haelan.instance.overrides

      const written = await harness.app.inject({
        method: 'POST', url: '/api/v1/p/p1/overrides',
        headers: { authorization: `Bearer ${token}`, ...ORIGIN },
        payload: {
          scope: 'day_metric', targetKey: dayMetricTarget({ localDate: dateOf(3), metric: 'steps' }),
          action: 'exclude', reason: 'own write',
        },
      })
      expect(written.statusCode).toBe(200)
      const id = (written.json() as { id: string }).id
      expect(overrides.listFor('p1')).toMatchObject([{ id, reason: 'own write' }])

      const removed = await harness.app.inject({
        method: 'DELETE', url: `/api/v1/p/p1/overrides/${id}`,
        headers: { authorization: `Bearer ${token}`, ...ORIGIN },
      })
      expect(removed.statusCode).toBe(200)
      expect(overrides.listFor('p1')).toEqual([])
    })

    // Not the 403 case above: this path segment is the caller's own, which is what lets the
    // request reach the handler at all, and the risk is the id in the URL rather than the path.
    // OverrideStore.get scopes its existence check by person as well as id (see overrides.ts), so
    // the handler answers 404 before remove() is ever called, the same 404 a made up id gets.
    //
    // The 404 with its code is the load bearing assertion here, not the surviving row: remove() is
    // separately scoped by personId (see overrides.ts), so theirs survives regardless of whether
    // get()'s scoping holds. An unscoped get would turn the 404 into a 200 (the existence check
    // would find someone else's row and let the delete proceed) while the row would still be
    // deleted, since remove()'s own scoping is a different line of code entirely. Only unscoping
    // both would move the row; this case pins the first of the two independently.
    it("refuses to delete an override by an id that belongs to another person, and leaves it alone", async () => {
      harness = await withServer()
      const token = await harness.signIn()
      await harness.addPerson({ id: 'p2', displayName: 'Someone else', username: 'other' })
      const overrides = harness.app.haelan.instance.overrides
      const theirs = overrides.put({
        personId: 'p2', scope: 'day_metric', targetKey: dayMetricTarget({ localDate: dateOf(1), metric: 'steps' }),
        action: 'exclude', reason: 'theirs', nowMs: harness.clock.nowMs,
      })

      const removed = await harness.app.inject({
        method: 'DELETE', url: `/api/v1/p/p1/overrides/${theirs}`,
        headers: { authorization: `Bearer ${token}`, ...ORIGIN },
      })
      expect(removed.statusCode).toBe(404)
      // The code, not only the status: an unregistered route also answers a bare 404, and that is
      // not what this case is proving.
      expect(removed.json()).toMatchObject({ error: { kind: 'not_found', code: 'no_such_override' } })
      expect(overrides.listFor('p2').map((row) => row.id)).toEqual([theirs])
    })
  })

  describe('note writes', () => {
    it('answers 401 with no session at all, before touching anything', async () => {
      harness = await withServer()
      await harness.signIn()
      await harness.addPerson({ id: 'p2', displayName: 'Someone else', username: 'other' })
      const notes = harness.app.haelan.instance.notes
      notes.put({ personId: 'p2', localDate: dateOf(1), body: 'theirs', nowMs: harness.clock.nowMs })

      const written = await harness.app.inject({
        method: 'PUT', url: `/api/v1/p/p1/notes/${dateOf(1)}`,
        payload: { body: 'no session to write with' },
      })
      expect(written.statusCode).toBe(401)
      expect(written.json()).toMatchObject({ error: { kind: 'unauthorized', code: 'no_session' } })

      const removed = await harness.app.inject({ method: 'DELETE', url: `/api/v1/p/p1/notes/${dateOf(1)}` })
      expect(removed.statusCode).toBe(401)
      expect(removed.json()).toMatchObject({ error: { kind: 'unauthorized', code: 'no_session' } })
      // p1, not p2: both requests above name p1 in the path, so a guard that failed open would
      // write or remove p1's note, never p2's. p2's note is read too, for the symmetry, but it
      // was never at risk.
      expect(notes.listFor('p1', dateOf(1), dateOf(1))).toEqual([])
      expect(notes.listFor('p2', dateOf(1), dateOf(1))).toMatchObject([{ body: 'theirs' }])
    })

    // Both directions of the note write routes, the same pairing the override and event cases
    // above use: writing into somebody else's day, and deleting out of it. The surviving row
    // after the DELETE attempt is the assertion that matters, since a 403 alone is also the
    // answer a route that acted first and refused after would give.
    it('refuses both writes against another person, and leaves their note unchanged', async () => {
      harness = await withServer()
      const token = await harness.signIn()
      await harness.addPerson({ id: 'p2', displayName: 'Someone else', username: 'other' })
      const notes = harness.app.haelan.instance.notes
      notes.put({ personId: 'p2', localDate: dateOf(1), body: 'theirs', nowMs: harness.clock.nowMs })

      const written = await harness.app.inject({
        method: 'PUT', url: `/api/v1/p/p2/notes/${dateOf(1)}`,
        headers: { authorization: `Bearer ${token}`, ...ORIGIN },
        payload: { body: 'not mine to write' },
      })
      expect(written.statusCode).toBe(403)
      // The envelope, not only the status: see the comment on the override 403 case above for why
      // a status-only assertion here can pass for the wrong reason.
      expect(written.json()).toMatchObject({ error: { kind: 'forbidden', code: 'not_your_person' } })

      const removed = await harness.app.inject({
        method: 'DELETE', url: `/api/v1/p/p2/notes/${dateOf(1)}`,
        headers: { authorization: `Bearer ${token}`, ...ORIGIN },
      })
      expect(removed.statusCode).toBe(403)
      expect(removed.json()).toMatchObject({ error: { kind: 'forbidden', code: 'not_your_person' } })
      expect(notes.listFor('p2', dateOf(1), dateOf(1))).toMatchObject([{ body: 'theirs' }])
    })

    it("writes and removes a note for the session's own person", async () => {
      harness = await withServer()
      const token = await harness.signIn()
      const notes = harness.app.haelan.instance.notes

      const written = await harness.app.inject({
        method: 'PUT', url: `/api/v1/p/p1/notes/${dateOf(1)}`,
        headers: { authorization: `Bearer ${token}`, ...ORIGIN },
        payload: { body: 'own write' },
      })
      expect(written.statusCode).toBe(200)
      expect(notes.listFor('p1', dateOf(1), dateOf(1))).toMatchObject([{ body: 'own write' }])

      const removed = await harness.app.inject({
        method: 'DELETE', url: `/api/v1/p/p1/notes/${dateOf(1)}`,
        headers: { authorization: `Bearer ${token}`, ...ORIGIN },
      })
      expect(removed.statusCode).toBe(200)
      expect(notes.listFor('p1', dateOf(1), dateOf(1))).toEqual([])
    })

    // No route in this file supplies a note id: notes carry no id-bearing write route the way
    // overrides and events do, so the note family has no equivalent of the two "own path, foreign
    // id" cases above. It has two date-shaped collisions instead, one for each write route below.
    //
    // NoteStore.put upserts on onConflictDoUpdate({ target: [notes.personId, notes.localDate] })
    // (see notes.ts), so a p1 write for a date p2 also has a note for is only safe because
    // personId is part of that conflict target. Dropping personId from it would make p1's write
    // for a shared date update p2's row instead of inserting p1's own, and the case right below
    // is the only one in the file that would notice: p1's write would still answer 200 and even
    // read back correctly through p1's own listFor if p2's row now carried p1's body, so p2's row
    // is what has to be checked directly.
    it("a write for a date another person also has a note for leaves their note alone", async () => {
      harness = await withServer()
      const token = await harness.signIn()
      await harness.addPerson({ id: 'p2', displayName: 'Someone else', username: 'other' })
      const notes = harness.app.haelan.instance.notes
      notes.put({ personId: 'p2', localDate: dateOf(1), body: 'theirs', nowMs: harness.clock.nowMs })

      const written = await harness.app.inject({
        method: 'PUT', url: `/api/v1/p/p1/notes/${dateOf(1)}`,
        headers: { authorization: `Bearer ${token}`, ...ORIGIN },
        payload: { body: 'own write on a shared date' },
      })
      expect(written.statusCode).toBe(200)
      expect(notes.listFor('p1', dateOf(1), dateOf(1))).toMatchObject([{ body: 'own write on a shared date' }])
      expect(notes.listFor('p2', dateOf(1), dateOf(1))).toMatchObject([{ body: 'theirs' }])
    })

    // The DELETE half's own version of the same collision, and the load bearing one: unlike the
    // write above, nothing here is a route guard's job to catch. requirePerson already refused a
    // DELETE aimed at p2's own path in the case above; this one is aimed at p1's own path, fully
    // authorised, and the only thing standing between it and every person's note for this date is
    // eq(notes.personId, ...) inside NoteStore.remove's own WHERE (see notes.ts). Drop that clause
    // and this case is the only one in the file that would notice: p1's own listFor would still
    // read back empty either way, so p2's row is what has to be checked directly, the same reason
    // the write case above reads p2's row rather than p1's.
    it("a delete for a date another person also has a note for leaves their note alone", async () => {
      harness = await withServer()
      const token = await harness.signIn()
      await harness.addPerson({ id: 'p2', displayName: 'Someone else', username: 'other' })
      const notes = harness.app.haelan.instance.notes
      notes.put({ personId: 'p1', localDate: dateOf(1), body: 'mine', nowMs: harness.clock.nowMs })
      notes.put({ personId: 'p2', localDate: dateOf(1), body: 'theirs', nowMs: harness.clock.nowMs })

      const removed = await harness.app.inject({
        method: 'DELETE', url: `/api/v1/p/p1/notes/${dateOf(1)}`,
        headers: { authorization: `Bearer ${token}`, ...ORIGIN },
      })
      expect(removed.statusCode).toBe(200)
      expect(notes.listFor('p1', dateOf(1), dateOf(1))).toEqual([])
      expect(notes.listFor('p2', dateOf(1), dateOf(1))).toMatchObject([{ body: 'theirs' }])
    })
  })

  describe('event writes', () => {
    it('answers 401 with no session at all, before touching anything', async () => {
      harness = await withServer()
      await harness.signIn()
      await harness.addPerson({ id: 'p2', displayName: 'Someone else', username: 'other' })
      const events = harness.app.haelan.instance.events
      const startedAtMs = Date.parse('2026-08-01T09:00:00Z')
      const theirs = events.add({ personId: 'p2', kind: 'travel', startedAtMs, startedAtOffsetMinutes: 0 })

      const written = await harness.app.inject({
        method: 'POST', url: '/api/v1/p/p1/events',
        payload: { kind: 'illness', startedAtMs: startedAtMs + 60_000 },
      })
      expect(written.statusCode).toBe(401)
      expect(written.json()).toMatchObject({ error: { kind: 'unauthorized', code: 'no_session' } })

      const removed = await harness.app.inject({ method: 'DELETE', url: `/api/v1/p/p1/events/${theirs}` })
      expect(removed.statusCode).toBe(401)
      // p1, not p2: both requests above name p1 in the path, so a guard that failed open would
      // create or delete p1's own event, never p2's. p2's event is read too, for the symmetry, but
      // it was never the one a broken guard here would touch.
      expect(events.listFor('p1', '2026-08-01', '2026-08-01')).toEqual([])
      expect(events.listFor('p2', '2026-08-01', '2026-08-01').map((e) => e.id)).toEqual([theirs])
    })

    // Both directions of the event write routes, the same pairing the override case above uses:
    // creating into somebody else's list, and deleting out of it with an id that is not a secret.
    it('refuses both writes against another person, and leaves their events unchanged', async () => {
      harness = await withServer()
      const token = await harness.signIn()
      await harness.addPerson({ id: 'p2', displayName: 'Someone else', username: 'other' })
      const events = harness.app.haelan.instance.events
      const startedAtMs = Date.parse('2026-08-01T09:00:00Z')
      const theirs = events.add({ personId: 'p2', kind: 'travel', startedAtMs, startedAtOffsetMinutes: 0 })

      const written = await harness.app.inject({
        method: 'POST', url: '/api/v1/p/p2/events',
        headers: { authorization: `Bearer ${token}`, ...ORIGIN },
        payload: { kind: 'illness', startedAtMs: startedAtMs + 60_000 },
      })
      expect(written.statusCode).toBe(403)
      // The envelope, not only the status: see the comment on the override 403 case above for why
      // a status-only assertion here can pass for the wrong reason.
      expect(written.json()).toMatchObject({ error: { kind: 'forbidden', code: 'not_your_person' } })

      const removed = await harness.app.inject({
        method: 'DELETE', url: `/api/v1/p/p2/events/${theirs}`,
        headers: { authorization: `Bearer ${token}`, ...ORIGIN },
      })
      expect(removed.statusCode).toBe(403)
      expect(removed.json()).toMatchObject({ error: { kind: 'forbidden', code: 'not_your_person' } })
      expect(events.listFor('p2', '2026-08-01', '2026-08-01').map((e) => e.id)).toEqual([theirs])
    })

    it("creates and removes an event for the session's own person", async () => {
      harness = await withServer()
      const token = await harness.signIn()
      const events = harness.app.haelan.instance.events
      const startedAtMs = Date.parse('2026-08-01T09:00:00Z')

      const written = await harness.app.inject({
        method: 'POST', url: '/api/v1/p/p1/events',
        headers: { authorization: `Bearer ${token}`, ...ORIGIN },
        payload: { kind: 'own write', startedAtMs, startedAtOffsetMinutes: 0 },
      })
      expect(written.statusCode).toBe(200)
      const id = (written.json() as { id: string }).id
      expect(events.listFor('p1', '2026-08-01', '2026-08-01')).toMatchObject([{ id, kind: 'own write' }])

      const removed = await harness.app.inject({
        method: 'DELETE', url: `/api/v1/p/p1/events/${id}`,
        headers: { authorization: `Bearer ${token}`, ...ORIGIN },
      })
      expect(removed.statusCode).toBe(200)
      expect(events.listFor('p1', '2026-08-01', '2026-08-01')).toEqual([])
    })

    // Not the 403 case above: this path segment is the caller's own, which is what lets the
    // request reach the handler at all, and the risk is the id in the URL rather than the path.
    // EventStore carries no get() to check an id's owner before deleting (see events.ts's own
    // comment on why), so this route answers 200 whether or not the id was ever the caller's,
    // which makes the status assertion alone worthless here: only the surviving row proves the
    // delete did not run. This is the case the removed-scoping canary in task-7-report.md targets.
    it('a delete by an id that belongs to another person removes nothing, though it still answers 200', async () => {
      harness = await withServer()
      const token = await harness.signIn()
      await harness.addPerson({ id: 'p2', displayName: 'Someone else', username: 'other' })
      const events = harness.app.haelan.instance.events
      const startedAtMs = Date.parse('2026-08-01T09:00:00Z')
      const theirs = events.add({ personId: 'p2', kind: 'travel', startedAtMs, startedAtOffsetMinutes: 0 })

      const removed = await harness.app.inject({
        method: 'DELETE', url: `/api/v1/p/p1/events/${theirs}`,
        headers: { authorization: `Bearer ${token}`, ...ORIGIN },
      })
      expect(removed.statusCode).toBe(200)
      expect(events.listFor('p2', '2026-08-01', '2026-08-01').map((e) => e.id)).toEqual([theirs])
    })
  })

  // The rename and clear routes: no needle-in-a-body case fits, same as the three write families
  // above, so this checks the alias a store read reports afterwards rather than a response body.
  describe('source alias writes', () => {
    it('answers 401 with no session at all, before touching anything', async () => {
      harness = await withServer()
      await harness.signIn()
      await harness.addPerson({ id: 'p2', displayName: 'Someone else', username: 'other' })
      seedSource(harness, 'p1', 'mine')
      seedSource(harness, 'p2', 'theirs')
      const aliases = harness.app.haelan.instance.sourceAliases
      aliases.put({ personId: 'p2', sourceId: 'theirs', alias: 'Theirs', nowMs: harness.clock.nowMs })

      const written = await harness.app.inject({
        method: 'PUT', url: '/api/v1/p/p1/sources/mine/alias',
        payload: { alias: 'no session to write with' },
      })
      expect(written.statusCode).toBe(401)
      expect(written.json()).toMatchObject({ error: { kind: 'unauthorized', code: 'no_session' } })

      const removed = await harness.app.inject({ method: 'DELETE', url: '/api/v1/p/p1/sources/mine/alias' })
      expect(removed.statusCode).toBe(401)
      expect(removed.json()).toMatchObject({ error: { kind: 'unauthorized', code: 'no_session' } })

      // p1, not p2: both requests above name p1 in the path, so a guard that failed open would
      // touch p1's own alias, never p2's. p2's alias is read too, for the symmetry, but it was
      // never the one a broken guard here would touch.
      expect(aliases.listNamed('p1').find((s) => s.id === 'mine')?.alias).toBeNull()
      expect(aliases.listNamed('p2').find((s) => s.id === 'theirs')?.alias).toBe('Theirs')
    })

    // Both directions of the alias write routes, the same pairing the note and event cases above
    // use: writing into somebody else's source, and deleting out of it.
    it('refuses both writes against another person, and leaves their alias unchanged', async () => {
      harness = await withServer()
      const token = await harness.signIn()
      await harness.addPerson({ id: 'p2', displayName: 'Someone else', username: 'other' })
      seedSource(harness, 'p2', 'theirs')
      const aliases = harness.app.haelan.instance.sourceAliases
      aliases.put({ personId: 'p2', sourceId: 'theirs', alias: 'Theirs', nowMs: harness.clock.nowMs })

      const written = await harness.app.inject({
        method: 'PUT', url: '/api/v1/p/p2/sources/theirs/alias',
        headers: { authorization: `Bearer ${token}`, ...ORIGIN },
        payload: { alias: 'not mine to write' },
      })
      expect(written.statusCode).toBe(403)
      // The envelope, not only the status: see the comment on the override 403 case above for why
      // a status-only assertion here can pass for the wrong reason.
      expect(written.json()).toMatchObject({ error: { kind: 'forbidden', code: 'not_your_person' } })

      const removed = await harness.app.inject({
        method: 'DELETE', url: '/api/v1/p/p2/sources/theirs/alias',
        headers: { authorization: `Bearer ${token}`, ...ORIGIN },
      })
      expect(removed.statusCode).toBe(403)
      expect(removed.json()).toMatchObject({ error: { kind: 'forbidden', code: 'not_your_person' } })
      expect(aliases.listNamed('p2').find((s) => s.id === 'theirs')?.alias).toBe('Theirs')
    })

    it("sets and clears a name for the session's own person", async () => {
      harness = await withServer()
      const token = await harness.signIn()
      seedSource(harness, 'p1', 'mine')
      const aliases = harness.app.haelan.instance.sourceAliases

      const written = await harness.app.inject({
        method: 'PUT', url: '/api/v1/p/p1/sources/mine/alias',
        headers: { authorization: `Bearer ${token}`, ...ORIGIN },
        payload: { alias: 'own write' },
      })
      expect(written.statusCode).toBe(200)
      expect(aliases.listNamed('p1').find((s) => s.id === 'mine')).toMatchObject({ alias: 'own write' })

      const removed = await harness.app.inject({
        method: 'DELETE', url: '/api/v1/p/p1/sources/mine/alias',
        headers: { authorization: `Bearer ${token}`, ...ORIGIN },
      })
      expect(removed.statusCode).toBe(200)
      expect(aliases.listNamed('p1').find((s) => s.id === 'mine')?.alias).toBeNull()
    })

    // Not the 403 case above: this path segment is the caller's own, which is what lets the
    // request reach the handler at all, and the risk is the source id in the URL rather than the
    // path. getSource scopes its existence check by person as well as id (see sources.ts's own
    // comment), so the handler answers 404 before the store is ever called, matching the not_found
    // case v1-sources.test.ts pins directly. Checked here too, and against the surviving row, so a
    // scoping regression on either route is caught by store state rather than by status alone.
    it("refuses to touch a source id that belongs to another person, and leaves its alias alone", async () => {
      harness = await withServer()
      const token = await harness.signIn()
      await harness.addPerson({ id: 'p2', displayName: 'Someone else', username: 'other' })
      seedSource(harness, 'p2', 'theirs')
      const aliases = harness.app.haelan.instance.sourceAliases
      aliases.put({ personId: 'p2', sourceId: 'theirs', alias: 'Theirs', nowMs: harness.clock.nowMs })

      const written = await harness.app.inject({
        method: 'PUT', url: '/api/v1/p/p1/sources/theirs/alias',
        headers: { authorization: `Bearer ${token}`, ...ORIGIN },
        payload: { alias: 'mine now' },
      })
      expect(written.statusCode).toBe(404)
      expect(written.json()).toMatchObject({ error: { kind: 'not_found', code: 'no_such_source' } })

      const removed = await harness.app.inject({
        method: 'DELETE', url: '/api/v1/p/p1/sources/theirs/alias',
        headers: { authorization: `Bearer ${token}`, ...ORIGIN },
      })
      expect(removed.statusCode).toBe(404)
      expect(removed.json()).toMatchObject({ error: { kind: 'not_found', code: 'no_such_source' } })
      expect(aliases.listNamed('p2').find((s) => s.id === 'theirs')?.alias).toBe('Theirs')
    })
  })

  // The one write route on this surface with no id in its path at all: it replaces a person's
  // whole exclusion set in one call, so there is no equivalent of the "foreign id, own path" case
  // the override/event/source families above each carry. What could leak here is the same as in
  // the data-types table entry above: not a row appearing where it should not, but this person's
  // set silently including or excluding an id that only the other person's request named.
  describe('data-types writes', () => {
    it('answers 401 with no session at all, before touching anything', async () => {
      harness = await withServer()
      await harness.signIn()
      await harness.addPerson({ id: 'p2', displayName: 'Someone else', username: 'other' })
      const excludedDataTypes = harness.app.haelan.instance.excludedDataTypes
      excludedDataTypes.setFor({ personId: 'p2', dataTypeIds: ['weight'], nowMs: harness.clock.nowMs })

      const written = await harness.app.inject({
        method: 'PUT', url: '/api/v1/p/p1/data-types',
        payload: { excluded: ['steps'] },
      })
      expect(written.statusCode).toBe(401)
      expect(written.json()).toMatchObject({ error: { kind: 'unauthorized', code: 'no_session' } })

      // p1, not p2: the request above names p1 in the path, so a guard that failed open would set
      // p1's own exclusions, never p2's. p2's are read too, for the symmetry, but they were never
      // the ones a broken guard here would touch.
      expect(excludedDataTypes.listFor('p1')).toEqual([])
      expect(excludedDataTypes.listFor('p2')).toEqual(['weight'])
    })

    // The one direction this write has, unlike the create-and-delete pairs above: setFor always
    // replaces the whole set, so there is nothing separate to call "removing" it.
    it('refuses the write against another person, and leaves their exclusions unchanged', async () => {
      harness = await withServer()
      const token = await harness.signIn()
      await harness.addPerson({ id: 'p2', displayName: 'Someone else', username: 'other' })
      const excludedDataTypes = harness.app.haelan.instance.excludedDataTypes
      excludedDataTypes.setFor({ personId: 'p2', dataTypeIds: ['weight'], nowMs: harness.clock.nowMs })

      const written = await harness.app.inject({
        method: 'PUT', url: '/api/v1/p/p2/data-types',
        headers: { authorization: `Bearer ${token}`, ...ORIGIN },
        payload: { excluded: ['steps'] },
      })
      expect(written.statusCode).toBe(403)
      // The envelope, not only the status: see the comment on the override 403 case above for why
      // a status-only assertion here can pass for the wrong reason.
      expect(written.json()).toMatchObject({ error: { kind: 'forbidden', code: 'not_your_person' } })
      expect(excludedDataTypes.listFor('p2')).toEqual(['weight'])
    })

    it("replaces the set for the session's own person", async () => {
      harness = await withServer()
      const token = await harness.signIn()
      const excludedDataTypes = harness.app.haelan.instance.excludedDataTypes

      const written = await harness.app.inject({
        method: 'PUT', url: '/api/v1/p/p1/data-types',
        headers: { authorization: `Bearer ${token}`, ...ORIGIN },
        payload: { excluded: ['steps', 'weight'] },
      })
      expect(written.statusCode).toBe(200)
      expect(written.json()).toEqual({ excluded: ['steps', 'weight'] })
      expect(excludedDataTypes.listFor('p1')).toEqual(['steps', 'weight'])
    })
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
  // (method, url) pair exactly as fastify's router sees it: no merging, no nesting. Every HEAD
  // event is dropped, not only fastify's own auto-added ones (it re-enters route registration to
  // add one for every GET, which is what would otherwise show up as an entry nobody in this table
  // declared): no route under /api/v1 is HEAD only today, but a deliberately HEAD only route
  // would be invisible to this guard the same way, and this filter does not tell the two apart.
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
      // Safe today only because `covered` below is hand written from three separate lists; if it
      // and `registered` were ever both built from one source, both could be empty at once and the
      // set comparison below would pass on nothing. Asserted directly rather than left to that
      // coincidence, since this project has shipped a vacuous guard once already.
      expect(registered.size).toBeGreaterThan(0)

      const covered = new Set([
        ...ROUTES.map((route) => `GET ${route.template}`), ...WRITE_ROUTES, ...NOT_PERSON_SCOPED,
      ])
      const missing = [...registered].filter((entry) => !covered.has(entry))
      const stale = [...covered].filter((entry) => !registered.has(entry))
      expect({ missing, stale }).toEqual({ missing: [], stale: [] })
    } finally {
      await isolatedHarness.cleanup()
    }
  })
})

// Every case above proves isolation against a person the harness put into the stores directly,
// through addPerson - a shortcut no real account ever takes. M5b built the routes a household
// actually uses to add a second person: an admin invites them through POST /api/members and the
// invited person redeems that invite through POST /api/invite/:token, picking their own username
// and password and getting a session cookie back the same way a login would. The milestone after
// this one puts a sql_query tool over this same data, so the guard that tool will lean on has to
// be proven against an account that came into being exactly that way, not against a database
// merely shaped like one.
describe('isolation against a member invited and redeemed through the real routes', () => {
  let inviteHarness: Harness
  let adminToken: string
  let memberCookie: string
  let memberPersonId: string
  const inviterPersonId = 'p1'

  beforeAll(async () => {
    inviteHarness = await withServer()
    adminToken = await inviteHarness.signIn()

    // Both requests below omit Origin, the same way the 401-with-no-session cases elsewhere in
    // this file do: auth.ts's origin hook only checks a mutating request that carries one, so
    // leaving it off reaches the handler without needing ORIGIN's host to match this harness.
    const created = await inviteHarness.app.inject({
      method: 'POST', url: '/api/members',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { displayName: 'Wilma', timezone: 'Europe/Amsterdam' },
    })
    if (created.statusCode !== 200) throw new Error(`invite creation failed: ${created.statusCode} ${created.body}`)
    const { token } = created.json() as { token: string }

    const redeemed = await inviteHarness.app.inject({
      method: 'POST', url: `/api/invite/${token}`,
      payload: { username: 'wilma', password: 'a good long password' },
    })
    if (redeemed.statusCode !== 201) throw new Error(`invite redemption failed: ${redeemed.statusCode} ${redeemed.body}`)
    memberPersonId = (redeemed.json() as { personId: string }).personId

    // The harness's own signIn extracts this same cookie out of a login response; a redeem sets
    // an identical one, since both routes end by calling sessions.create and setSessionCookie the
    // same way (see invite.ts and auth.ts), so this follows that recipe rather than inventing a
    // second one for a cookie that is not actually different.
    const cookie = redeemed.cookies.find((c) => c.name === 'haelan_session')
    if (!cookie) throw new Error(`redeem set no session cookie: ${redeemed.statusCode} ${redeemed.body}`)
    memberCookie = `haelan_session=${cookie.value}`
  })

  afterAll(async () => {
    await inviteHarness.cleanup()
  })

  it('an invited member cannot read the person who invited them', async () => {
    const response = await inviteHarness.app.inject({
      method: 'GET',
      url: `/api/v1/p/${inviterPersonId}/series?metric=steps&agg=sum&from=2026-08-01&to=2026-08-02`,
      headers: { cookie: memberCookie },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { kind: 'forbidden', code: 'not_your_person' } })
  })

  it('and reads their own person happily', async () => {
    const response = await inviteHarness.app.inject({
      method: 'GET',
      url: `/api/v1/p/${memberPersonId}/series?metric=steps&agg=sum&from=2026-08-01&to=2026-08-02`,
      headers: { cookie: memberCookie },
    })
    expect(response.statusCode).toBe(200)
    // The whole body, not only the status: a brand new member has no history of their own yet, so
    // the honest answer is an empty series rather than anything a status-only assertion would also
    // pass for.
    expect(response.json()).toEqual({ steps: { points: [], reduction: null } })
  })

  // The one people assume works the other way. Section 15 gives an admin no override over another
  // person's data, and is_admin governs instance settings only - creating this account is not the
  // same thing as owning what it goes on to hold.
  it('the admin who invited them cannot read their data', async () => {
    const response = await inviteHarness.app.inject({
      method: 'GET',
      url: `/api/v1/p/${memberPersonId}/series?metric=steps&agg=sum&from=2026-08-01&to=2026-08-02`,
      headers: { authorization: `Bearer ${adminToken}` },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { kind: 'forbidden', code: 'not_your_person' } })
  })
})
