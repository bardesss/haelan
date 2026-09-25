import { describe, it, expect } from 'vitest'
import { dayMetricTarget, sampleTarget, sessionTarget } from '@haelan/core/target-key'
import { applyOverlay, createOverlay, writeThrough } from '../src/demo/overlay.js'

const PERSON = 'demo'
const notesUrl = `/api/v1/p/${PERSON}/notes?from=2026-09-01&to=2026-09-07`
const seriesUrl = `/api/v1/p/${PERSON}/series?agg=sum&from=2026-09-01&metric=steps&to=2026-09-07`

const CAPTURED_SERIES = {
  series: {
    steps: {
      points: [
        { date: '2026-09-01', value: 8123 },
        { date: '2026-09-02', value: 9111 },
      ],
    },
  },
}

describe('notes', () => {
  it('reads back the note that was just written, on the day it was written', () => {
    const overlay = createOverlay()
    const written = writeThrough('PUT', `/api/v1/p/${PERSON}/notes/2026-09-02`, { body: 'felt awful' }, overlay)
    expect(written).toHaveProperty('id')

    const composed = applyOverlay(notesUrl, { items: [] }, overlay) as { items: { localDate: string, body: string }[] }
    expect(composed.items).toHaveLength(1)
    expect(composed.items[0]).toMatchObject({ localDate: '2026-09-02', body: 'felt awful' })
  })

  it("leaves a note outside the range out of the range's answer", () => {
    const overlay = createOverlay()
    writeThrough('PUT', `/api/v1/p/${PERSON}/notes/2026-08-01`, { body: 'earlier' }, overlay)
    const composed = applyOverlay(notesUrl, { items: [] }, overlay) as { items: unknown[] }
    expect(composed.items).toHaveLength(0)
  })
})

describe('a day-metric exclusion', () => {
  it('answers the write the way the route does, so the chart is invalidated', () => {
    const overlay = createOverlay()
    const result = writeThrough('POST', `/api/v1/p/${PERSON}/overrides`, {
      scope: 'day_metric',
      targetKey: dayMetricTarget({ localDate: '2026-09-02', metric: 'steps' }),
      action: 'exclude',
      reason: 'watch on charger',
    }, overlay) as { id: string, applied: boolean, affected: { from: string, to: string } | null }

    expect(result.applied).toBe(true)
    // Not decoration: invalidateAffected returns early on a null affected or applied false, and
    // the chart then never refetches.
    expect(result.affected).toEqual({ from: '2026-09-02', to: '2026-09-02' })
  })

  it('removes the point from the series rather than marking it', () => {
    // deriveDay deletes the excluded metric's daily rows, so in a real instance the point is gone.
    const overlay = createOverlay()
    writeThrough('POST', `/api/v1/p/${PERSON}/overrides`, {
      scope: 'day_metric',
      targetKey: dayMetricTarget({ localDate: '2026-09-02', metric: 'steps' }),
      action: 'exclude',
      reason: 'watch on charger',
    }, overlay)

    const composed = applyOverlay(seriesUrl, CAPTURED_SERIES, overlay) as typeof CAPTURED_SERIES
    expect(composed.series.steps.points.map((p) => p.date)).toEqual(['2026-09-01'])
  })

  it("leaves a different metric's points alone", () => {
    const overlay = createOverlay()
    writeThrough('POST', `/api/v1/p/${PERSON}/overrides`, {
      scope: 'day_metric',
      targetKey: dayMetricTarget({ localDate: '2026-09-02', metric: 'calories' }),
      action: 'exclude',
      reason: 'x',
    }, overlay)
    const composed = applyOverlay(seriesUrl, CAPTURED_SERIES, overlay) as typeof CAPTURED_SERIES
    expect(composed.series.steps.points).toHaveLength(2)
  })

  it('puts the point back when the override is removed', () => {
    const overlay = createOverlay()
    const written = writeThrough('POST', `/api/v1/p/${PERSON}/overrides`, {
      scope: 'day_metric',
      targetKey: dayMetricTarget({ localDate: '2026-09-02', metric: 'steps' }),
      action: 'exclude',
      reason: 'x',
    }, overlay) as { id: string }
    writeThrough('DELETE', `/api/v1/p/${PERSON}/overrides/${written.id}`, undefined, overlay)

    const composed = applyOverlay(seriesUrl, CAPTURED_SERIES, overlay) as typeof CAPTURED_SERIES
    expect(composed.series.steps.points).toHaveLength(2)
  })

  it('lists the override it wrote', () => {
    const overlay = createOverlay()
    writeThrough('POST', `/api/v1/p/${PERSON}/overrides`, {
      scope: 'day_metric',
      targetKey: dayMetricTarget({ localDate: '2026-09-02', metric: 'steps' }),
      action: 'exclude',
      reason: 'watch on charger',
    }, overlay)
    const composed = applyOverlay(`/api/v1/p/${PERSON}/overrides`, { items: [] }, overlay) as { items: unknown[] }
    expect(composed.items).toHaveLength(1)
  })
})

describe('a source alias', () => {
  it('renames the source in the captured list, and clearing restores the captured name', () => {
    const overlay = createOverlay()
    const captured = { items: [{ sourceId: 'ab12', alias: null, displayName: 'ab12' }] }

    writeThrough('PUT', `/api/v1/p/${PERSON}/sources/ab12/alias`, { alias: 'My watch' }, overlay)
    let composed = applyOverlay(`/api/v1/p/${PERSON}/sources`, captured, overlay) as { items: { alias: string | null }[] }
    expect(composed.items[0]?.alias).toBe('My watch')

    writeThrough('DELETE', `/api/v1/p/${PERSON}/sources/ab12/alias`, undefined, overlay)
    composed = applyOverlay(`/api/v1/p/${PERSON}/sources`, captured, overlay) as { items: { alias: string | null }[] }
    expect(composed.items[0]?.alias).toBeNull()
  })
})

describe('an unrelated read', () => {
  it('passes through untouched when the overlay is empty', () => {
    const overlay = createOverlay()
    const captured = { items: [1, 2, 3] }
    expect(applyOverlay(`/api/v1/p/${PERSON}/data-types`, captured, overlay)).toBe(captured)
  })
})

describe('the status panel', () => {
  // Shaped like composeStatus's own answer (packages/core/src/api/statusPanel.ts), trimmed to the
  // fields this overlay actually reads or rewrites - real fields (sync, lastDeliveryAtMs) carry no
  // signal for these tests, the same trimming the sessions fixture below applies to its own capture.
  const CAPTURED_STATUS = {
    connections: [
      {
        kind: 'google',
        problem: null,
        devices: [
          { sourceId: 'watch-1', name: 'Watch', lastReportedDate: '2026-09-20', stale: false, choice: null, metrics: [] },
          { sourceId: 'watch-2', name: 'Old watch', lastReportedDate: '2026-08-01', stale: true, choice: null, metrics: ['heart_rate', 'steps'] },
        ],
      },
    ],
    sync: null,
    problems: 1,
    hiddenDevices: 3,
  }

  it('answers the captured body untouched when nobody has written a choice', () => {
    const overlay = createOverlay()
    expect(applyOverlay('/api/status', CAPTURED_STATUS, overlay)).toBe(CAPTURED_STATUS)
  })

  it('removes a hidden source from the next /api/status read, and drops its stale count too', () => {
    const overlay = createOverlay()
    writeThrough('PUT', `/api/v1/p/${PERSON}/sources/watch-2/panel`, { visible: false }, overlay)

    const composed = applyOverlay('/api/status', CAPTURED_STATUS, overlay) as typeof CAPTURED_STATUS
    expect(composed.connections[0]?.devices.map((d) => d.sourceId)).toEqual(['watch-1'])
    // watch-2 was the panel's one stale device - removing it leaves nothing to report a problem.
    expect(composed.problems).toBe(0)
    expect(composed.hiddenDevices).toBe(4)
    // The captured object itself is never mutated - a second read of the same fixture must still
    // answer the untouched capture, the way composeSeries' own clone-not-mutate comment explains.
    expect(CAPTURED_STATUS.connections[0]?.devices).toHaveLength(2)
  })

  it('marks a shown source with its choice without hiding an already-visible one', () => {
    const overlay = createOverlay()
    writeThrough('PUT', `/api/v1/p/${PERSON}/sources/watch-1/panel`, { visible: true }, overlay)

    const composed = applyOverlay('/api/status', CAPTURED_STATUS, overlay) as typeof CAPTURED_STATUS
    const devices = composed.connections[0]?.devices ?? []
    expect(devices.map((d) => d.sourceId)).toEqual(['watch-1', 'watch-2'])
    expect(devices[0]?.choice).toBe(true)
    // A recomposed read still says what the quiet device stopped sending: the overlay rewrites
    // `choice` and filters rows, and every other field the capture carried passes through as is.
    expect(devices.map((d) => d.metrics)).toEqual([[], ['heart_rate', 'steps']])
  })

  // The Google connection's failing data types (StatusConnection.failures) are the capture's to
  // carry, not the overlay's to rewrite: a recomposed read keeps them as captured, and a capture
  // older than the field (CAPTURED_STATUS above has none) recomposes without inventing one.
  it('carries a captured failures list through a recomposed read, and adds none where there was none', () => {
    const failures = [{ dataType: 'steps', lastError: '[transient] 503 listing steps', lastErrorAtMs: 1 }]
    const captured = {
      ...CAPTURED_STATUS,
      connections: [{ ...CAPTURED_STATUS.connections[0]!, problem: 'sync_failed', failures }],
    }
    const overlay = createOverlay()
    writeThrough('PUT', `/api/v1/p/${PERSON}/sources/watch-2/panel`, { visible: false }, overlay)

    const composed = applyOverlay('/api/status', captured, overlay) as typeof captured
    expect(composed.connections[0]?.failures).toEqual(failures)
    expect(composed.problems).toBe(1)
    const old = applyOverlay('/api/status', CAPTURED_STATUS, overlay) as { connections: Record<string, unknown>[] }
    expect('failures' in old.connections[0]!).toBe(false)
  })

  it('clearing a choice back to the default answers the captured row again', () => {
    const overlay = createOverlay()
    writeThrough('PUT', `/api/v1/p/${PERSON}/sources/watch-2/panel`, { visible: false }, overlay)
    writeThrough('DELETE', `/api/v1/p/${PERSON}/sources/watch-2/panel`, undefined, overlay)

    const composed = applyOverlay('/api/status', CAPTURED_STATUS, overlay) as typeof CAPTURED_STATUS
    expect(composed.connections[0]?.devices.map((d) => d.sourceId)).toEqual(['watch-1', 'watch-2'])
    expect(composed.connections[0]?.devices[1]?.choice).toBeNull()
  })

  it('folds the same choice into the /sources listing as panelChoice', () => {
    const overlay = createOverlay()
    const captured = { items: [{ id: 'watch-2', displayName: 'Old watch', alias: null }] }
    writeThrough('PUT', `/api/v1/p/${PERSON}/sources/watch-2/panel`, { visible: false }, overlay)

    const composed = applyOverlay(`/api/v1/p/${PERSON}/sources?activity=1`, captured, overlay) as
      { items: { panelChoice: boolean | null }[] }
    expect(composed.items[0]?.panelChoice).toBe(false)
  })
})

// Every fixture below this line is copied verbatim (trimmed of provider-attribute noise that
// carries no signal for these tests) from a real file under demo/capture/out/, not hand built:
// the review that approved this task found every composer's shape tolerance untested against the
// real branch it exists for, with only the brief's own (wrong) fixture shapes covered. See the
// manifest keys named in each block below for exactly which capture each one came from.

describe('a real captured series body', () => {
  // demo/capture/out/manifest.json's
  // "/api/v1/p/demo/series?agg=sum&from=2026-09-01&metric=sleep_asleep_minutes&metric=steps&to=2026-09-30",
  // `steps` only - the real wire shape has no `series` wrapper and spells a point's day
  // `localDate`, not `date`, unlike this task's own brief.
  const REAL_STEPS_SERIES = {
    steps: {
      points: [
        { localDate: '2026-09-01', value: 7199, coverage: 1, source: 'merged', sourceMix: '[{"source":"927acb5da30fb1fd4d844a9e10723c10","hours":24}]', updatedAtMs: 1789321089021 },
        { localDate: '2026-09-02', value: 7218, coverage: 1, source: 'merged', sourceMix: '[{"source":"927acb5da30fb1fd4d844a9e10723c10","hours":24}]', updatedAtMs: 1789321089021 },
        { localDate: '2026-09-03', value: 12989, coverage: 1, source: 'merged', sourceMix: '[{"source":"927acb5da30fb1fd4d844a9e10723c10","hours":24}]', updatedAtMs: 1789321089021 },
        { localDate: '2026-09-04', value: 7378, coverage: 1, source: 'merged', sourceMix: '[{"source":"927acb5da30fb1fd4d844a9e10723c10","hours":24}]', updatedAtMs: 1789321089021 },
        { localDate: '2026-09-05', value: 6999, coverage: 1, source: 'merged', sourceMix: '[{"source":"927acb5da30fb1fd4d844a9e10723c10","hours":24}]', updatedAtMs: 1789321089021 },
        { localDate: '2026-09-06', value: 15031, coverage: 1, source: 'merged', sourceMix: '[{"source":"927acb5da30fb1fd4d844a9e10723c10","hours":24}]', updatedAtMs: 1789321089021 },
      ],
      reduction: null,
    },
  }

  it('drops the excluded day from the real, unwrapped shape', () => {
    const overlay = createOverlay()
    writeThrough('POST', `/api/v1/p/${PERSON}/overrides`, {
      scope: 'day_metric',
      targetKey: dayMetricTarget({ localDate: '2026-09-02', metric: 'steps' }),
      action: 'exclude',
      reason: 'watch on charger',
    }, overlay)

    const composed = applyOverlay(
      `/api/v1/p/${PERSON}/series?agg=sum&from=2026-09-01&metric=steps&to=2026-09-06`,
      REAL_STEPS_SERIES,
      overlay,
    ) as typeof REAL_STEPS_SERIES
    expect(composed.steps.points.map((p) => p.localDate)).toEqual([
      '2026-09-01', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06',
    ])
  })
})

describe('a real captured sources body', () => {
  // demo/capture/out/manifest.json's "/api/v1/p/demo/sources".
  const REAL_SOURCES = {
    items: [
      { id: '927acb5da30fb1fd4d844a9e10723c10', externalId: 'FITBIT', displayName: 'FITBIT', alias: null, name: 'FITBIT', kind: 'app', createdAtMs: 1789321089021 },
      { id: 'a595c27bd1062babb5b7e50ac025fa83', externalId: 'IOS', displayName: 'IOS', alias: null, name: 'IOS', kind: 'app', createdAtMs: 1789321089021 },
    ],
  }

  it("resolves the real `id` field, and clearing falls back to the real displayName, matching nameFor's own output", () => {
    const overlay = createOverlay()
    writeThrough('PUT', `/api/v1/p/${PERSON}/sources/927acb5da30fb1fd4d844a9e10723c10/alias`, { alias: 'My watch' }, overlay)
    let composed = applyOverlay(`/api/v1/p/${PERSON}/sources`, REAL_SOURCES, overlay) as typeof REAL_SOURCES
    expect(composed.items[0]).toMatchObject({ alias: 'My watch', name: 'My watch' })
    // Untouched: only the renamed source's row changes.
    expect(composed.items[1]).toEqual(REAL_SOURCES.items[1])

    writeThrough('DELETE', `/api/v1/p/${PERSON}/sources/927acb5da30fb1fd4d844a9e10723c10/alias`, undefined, overlay)
    composed = applyOverlay(`/api/v1/p/${PERSON}/sources`, REAL_SOURCES, overlay) as typeof REAL_SOURCES
    // nameFor falls back to the real captured displayName ('FITBIT'), not to the id, once the
    // alias clears - the same real branch the brief's own `ab12`/`ab12` fixture could never
    // exercise, since there the id and the fallback displayName were identical strings.
    expect(composed.items[0]).toMatchObject({ alias: null, name: 'FITBIT' })
  })
})

describe('intraday', () => {
  // demo/capture/out/manifest.json's
  // "/api/v1/p/demo/intraday?date=2026-09-06&metric=heart_rate&points=720&source=927acb5da30fb1fd4d844a9e10723c10",
  // first two points, trimmed to a length that keeps the test readable.
  const SOURCE = '927acb5da30fb1fd4d844a9e10723c10'
  const REAL_INTRADAY = {
    points: [
      { sourceId: SOURCE, utcMs: 1788645600000, min: 52, mean: 52, max: 52, n: 1, excluded: false },
      { sourceId: SOURCE, utcMs: 1788649200000, min: 53, mean: 53, max: 53, n: 1, excluded: false },
    ],
    reduction: null,
  }
  const intradayUrl = `/api/v1/p/${PERSON}/intraday?date=2026-09-06&metric=heart_rate&points=720&source=${SOURCE}`

  it("rewrites a corrected sample's min, mean and max, and leaves the other point alone", () => {
    const overlay = createOverlay()
    writeThrough('POST', `/api/v1/p/${PERSON}/overrides`, {
      scope: 'sample',
      targetKey: sampleTarget({ source: SOURCE, metric: 'heart_rate', utcMs: 1788645600000 }),
      action: 'correct',
      correctedValue: 60,
      reason: 'strap slipped',
    }, overlay)

    const composed = applyOverlay(intradayUrl, REAL_INTRADAY, overlay) as typeof REAL_INTRADAY
    expect(composed.points[0]).toMatchObject({ min: 60, mean: 60, max: 60, excluded: false })
    expect(composed.points[1]).toEqual(REAL_INTRADAY.points[1])
  })

  it('flags an excluded sample rather than dropping it, so the chart can still anchor a marker on it', () => {
    const overlay = createOverlay()
    writeThrough('POST', `/api/v1/p/${PERSON}/overrides`, {
      scope: 'sample',
      targetKey: sampleTarget({ source: SOURCE, metric: 'heart_rate', utcMs: 1788649200000 }),
      action: 'exclude',
      reason: 'watch on charger',
    }, overlay)

    const composed = applyOverlay(intradayUrl, REAL_INTRADAY, overlay) as typeof REAL_INTRADAY
    expect(composed.points).toHaveLength(2)
    expect(composed.points[1]).toMatchObject({ excluded: true, min: 53 })
  })
})

describe('events', () => {
  const eventsUrl = `/api/v1/p/${PERSON}/events?from=2026-09-01&to=2026-09-07`

  it('reads back an added event on the day it falls, and drops it once removed', () => {
    const overlay = createOverlay()
    const written = writeThrough('POST', `/api/v1/p/${PERSON}/events`, {
      kind: 'meal',
      startedAtMs: Date.parse('2026-09-02T10:00:00Z'),
      startedAtOffsetMinutes: 120,
      note: 'lunch',
    }, overlay) as { id: string }
    expect(written).toHaveProperty('id')

    const withEvent = applyOverlay(eventsUrl, { items: [] }, overlay) as { items: { localDate: string, kind: string, note: string | null }[] }
    expect(withEvent.items).toHaveLength(1)
    // 10:00 UTC + a 120 minute (UTC+2) offset is still 2026-09-02, not the next day.
    expect(withEvent.items[0]).toMatchObject({ localDate: '2026-09-02', kind: 'meal', note: 'lunch' })

    writeThrough('DELETE', `/api/v1/p/${PERSON}/events/${written.id}`, undefined, overlay)
    const afterRemoval = applyOverlay(eventsUrl, { items: [] }, overlay) as { items: unknown[] }
    expect(afterRemoval.items).toHaveLength(0)
  })
})

describe('a session-scope exclusion', () => {
  // demo/capture/out/manifest.json's "/api/v1/p/demo/sessions/e2836c272f9838b927be0f4ae9133caa"
  // (detail) and its matching row in
  // "/api/v1/p/demo/sessions?from=2026-09-06&kind=exercise&to=2026-09-06" (list), both trimmed of
  // the provider `attrs` blob, which carries no signal for this test.
  const SESSION_ID = 'e2836c272f9838b927be0f4ae9133caa'
  const REAL_SESSION_ROW = {
    id: SESSION_ID, kind: 'exercise', sourceId: '927acb5da30fb1fd4d844a9e10723c10',
    startMs: 1788670800000, endMs: 1788674067706, startOffsetMinutes: 120, endOffsetMinutes: 120,
    localDate: '2026-09-06', excluded: false, excludeReason: null,
  }
  const REAL_SESSION_DETAIL = { ...REAL_SESSION_ROW, cardioLoad: null, autoSplits: [], laps: [] }
  const detailUrl = `/api/v1/p/${PERSON}/sessions/${SESSION_ID}`
  const listUrl = `/api/v1/p/${PERSON}/sessions?from=2026-09-06&kind=exercise&to=2026-09-06`

  it('sets excluded and excludeReason on both the detail and the matching list row, so the workout page actually changes', () => {
    const overlay = createOverlay()
    const written = writeThrough('POST', `/api/v1/p/${PERSON}/overrides`, {
      scope: 'session',
      targetKey: sessionTarget(SESSION_ID),
      action: 'exclude',
      reason: 'GPS lost signal',
    }, overlay) as { id: string }

    const detail = applyOverlay(detailUrl, REAL_SESSION_DETAIL, overlay) as typeof REAL_SESSION_DETAIL
    expect(detail).toMatchObject({ excluded: true, excludeReason: 'GPS lost signal' })

    const list = applyOverlay(listUrl, { items: [REAL_SESSION_ROW], cursor: null }, overlay) as { items: typeof REAL_SESSION_ROW[] }
    expect(list.items[0]).toMatchObject({ excluded: true, excludeReason: 'GPS lost signal' })

    // Removing the override falls back to the captured (un-excluded) row, matching what a real
    // instance would answer once the row itself is gone: session scope has no opposing "include"
    // action to write, only the override's own removal.
    writeThrough('DELETE', `/api/v1/p/${PERSON}/overrides/${written.id}`, undefined, overlay)
    const restored = applyOverlay(detailUrl, REAL_SESSION_DETAIL, overlay) as typeof REAL_SESSION_DETAIL
    expect(restored).toEqual(REAL_SESSION_DETAIL)
  })

  // The dashboard's "Today's activities" reads the same merged rows out of /glance's day.workouts,
  // not out of /sessions, so an overlay that marked only the two session routes left the dashboard
  // listing the workout unmarked right after the visitor excluded it. The rest of the glance is
  // captured figures and is left exactly as recorded; only the rows' two recorded fields change.
  it('marks the same workout in the glance, so the dashboard list agrees with the workout page', () => {
    const overlay = createOverlay()
    const glanceUrl = `/api/v1/p/${PERSON}/glance`
    const other = { ...REAL_SESSION_ROW, id: 'some-other-session' }
    const captured = {
      sleep: null,
      recovery: { score: 71 },
      day: { steps: { value: 8123 }, workouts: [REAL_SESSION_ROW, other] },
    }
    const written = writeThrough('POST', `/api/v1/p/${PERSON}/overrides`, {
      scope: 'session', targetKey: sessionTarget(SESSION_ID), action: 'exclude', reason: 'GPS lost signal',
    }, overlay) as { id: string }

    const glance = applyOverlay(glanceUrl, captured, overlay) as typeof captured
    expect(glance.day.workouts[0]).toEqual({ ...REAL_SESSION_ROW, excluded: true, excludeReason: 'GPS lost signal' })
    expect(glance.day.workouts[1]).toEqual(other)
    expect(glance.day.steps).toEqual(captured.day.steps)
    expect(glance.recovery).toEqual(captured.recovery)
    // The captured object itself is untouched: the manifest's response is shared by every read.
    expect(captured.day.workouts[0]!.excluded).toBe(false)

    writeThrough('DELETE', `/api/v1/p/${PERSON}/overrides/${written.id}`, undefined, overlay)
    expect(applyOverlay(glanceUrl, captured, overlay)).toBe(captured)
  })

  // Since M9c the demo also replays a past day's glance (`/glance?day=`), whose "That day's
  // activities" list reads the same day.workouts rows. The url the transport hands applyOverlay is
  // the one the page asked for, query string and all, so the marking has to survive the query.
  it("marks the workout in a past day's glance too", () => {
    const overlay = createOverlay()
    const captured = {
      sleep: null, recovery: { score: 71 }, finished: true,
      day: { steps: { value: 8123 }, workouts: [REAL_SESSION_ROW] },
    }
    writeThrough('POST', `/api/v1/p/${PERSON}/overrides`, {
      scope: 'session', targetKey: sessionTarget(SESSION_ID), action: 'exclude', reason: 'GPS lost signal',
    }, overlay)

    const glance = applyOverlay(`/api/v1/p/${PERSON}/glance?day=2026-09-06`, captured, overlay) as typeof captured
    expect(glance.day.workouts[0]).toEqual({ ...REAL_SESSION_ROW, excluded: true, excludeReason: 'GPS lost signal' })
    expect(captured.day.workouts[0]!.excluded).toBe(false)
  })

  // The calendar's verdicts are sleep and steps against their bands, neither of which a session
  // exclusion touches, so its captured body is answered as it is even with an exclusion written.
  it('leaves the glance calendar as captured', () => {
    const overlay = createOverlay()
    writeThrough('POST', `/api/v1/p/${PERSON}/overrides`, {
      scope: 'session', targetKey: sessionTarget(SESSION_ID), action: 'exclude', reason: 'GPS lost signal',
    }, overlay)
    const calendar = { month: '2026-09', firstDay: '2026-08-03', days: [{ localDate: '2026-09-06', sleep: 'within', steps: 'above' }] }
    expect(applyOverlay(`/api/v1/p/${PERSON}/glance/calendar?month=2026-09`, calendar, overlay)).toBe(calendar)
  })

  it('leaves an unrelated session out of the exclusion', () => {
    const overlay = createOverlay()
    writeThrough('POST', `/api/v1/p/${PERSON}/overrides`, {
      scope: 'session', targetKey: sessionTarget('some-other-session'), action: 'exclude', reason: 'x',
    }, overlay)
    const detail = applyOverlay(detailUrl, REAL_SESSION_DETAIL, overlay) as typeof REAL_SESSION_DETAIL
    expect(detail).toEqual(REAL_SESSION_DETAIL)
  })

  it("answers the write's own affected range once the session's date has been read, so invalidateAffected reaches the /sessions list", () => {
    // The real order a visitor's browser actually produces: WorkoutDetail mounts and reads the
    // session (which is what composeSessionDetail's own read-path recording exists for) before
    // AnnotatePanel can ever be opened to write an exclusion against it. WriteOverrideInput
    // carries no localDate of its own (useAnnotations.ts's own type), so without that prior read
    // this has nothing to answer with.
    const overlay = createOverlay()
    applyOverlay(detailUrl, REAL_SESSION_DETAIL, overlay)

    const written = writeThrough('POST', `/api/v1/p/${PERSON}/overrides`, {
      scope: 'session', targetKey: sessionTarget(SESSION_ID), action: 'exclude', reason: 'GPS lost signal',
    }, overlay) as { affected: { from: string, to: string } | null }

    // Not decoration: this is the exact range invalidateAffected (useAnnotations.ts) scans every
    // cached query's own {from, to} key params against, which is how a demo visitor returning to
    // Activity within staleTime sees the session they just excluded actually struck through in the
    // list, not merely on the detail page invalidateResource(..., 'session') already covers.
    expect(written.affected).toEqual({ from: '2026-09-06', to: '2026-09-06' })
  })

  it('answers null, not a guess, for a session this overlay has never read', () => {
    const overlay = createOverlay()
    const written = writeThrough('POST', `/api/v1/p/${PERSON}/overrides`, {
      scope: 'session', targetKey: sessionTarget(SESSION_ID), action: 'exclude', reason: 'x',
    }, overlay) as { affected: unknown }
    expect(written.affected).toBeNull()
  })
})

describe('notes upsert semantics', () => {
  it('replaces a captured day rather than doubling it, matching one-note-per-person-per-day', () => {
    const overlay = createOverlay()
    const captured = { items: [{ id: 'captured-1', localDate: '2026-09-02', body: 'original', updatedAtMs: 1 }] }
    writeThrough('PUT', `/api/v1/p/${PERSON}/notes/2026-09-02`, { body: 'edited' }, overlay)

    const composed = applyOverlay(notesUrl, captured, overlay) as { items: { localDate: string, body: string }[] }
    expect(composed.items).toHaveLength(1)
    expect(composed.items[0]).toMatchObject({ localDate: '2026-09-02', body: 'edited' })
  })
})
