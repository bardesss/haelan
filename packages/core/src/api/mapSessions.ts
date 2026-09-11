import { createHash } from 'node:crypto'
import type { DataType } from './catalogue.ts'
import type { SessionKind } from '../db/schema/derived.ts'
import { parseInstant, valueAt } from './parse.ts'
import { ConfigError } from '../errors.ts'

export interface SessionRow {
  id: string
  personId: string
  sourceId: string
  kind: SessionKind
  externalId: string
  startMs: number
  startOffsetMinutes: number
  endMs: number
  endOffsetMinutes: number
  localDate: string
  attrs: string
  rawPayloadId: string
}

export interface SegmentRow {
  id: string
  sessionId: string
  stage: string
  startMs: number
  endMs: number
}

export interface MapSessionsInput {
  dataType: DataType
  body: string
  personId: string
  resolveSource: (dataSource: unknown) => string
  rawPayloadId: string
}

// Derived from the natural key rather than random, so the trailing re-fetch window upserts the
// same night instead of accumulating a copy of it every run.
const stableId = (...parts: string[]) =>
  createHash('sha256').update(parts.join(' ')).digest('hex').slice(0, 32)

// A night belongs to the morning it ended in. Spec invariant 3: "last night" on the 31st means
// the 30th to 31st night, so the local date comes from the end instant and its own offset.
function localDateOfEnd(endMs: number, endOffsetMinutes: number): string {
  return new Date(endMs + endOffsetMinutes * 60_000).toISOString().slice(0, 10)
}

export function mapSessions(input: MapSessionsInput): { sessions: SessionRow[], segments: SegmentRow[] } {
  const t = input.dataType
  // A type may write here as its primary target, or as an extra one named in alsoTargets (Task
  // 8's ECG payload does both) - either is "mine", and only neither is a foreign type.
  if (t.target !== 'sessions' && !t.alsoTargets?.includes('sessions')) {
    throw new ConfigError(`${t.id} is not a session type`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(input.body)
  } catch {
    return { sessions: [], segments: [] }
  }

  // JSON.parse accepts "null", "42", and other scalars without throwing, so the type still
  // needs checking before anything reaches into it for dataPoints.
  if (typeof parsed !== 'object' || parsed === null) return { sessions: [], segments: [] }

  const dataPoints = (parsed as { dataPoints?: unknown }).dataPoints
  // A drifted payload might carry dataPoints as a number or a cursor-keyed object rather than
  // an array. Iterating that throws "not iterable"; treating it as no data does not.
  const points = Array.isArray(dataPoints) ? dataPoints : []

  const sessions: SessionRow[] = []
  const segments: SegmentRow[] = []

  for (const point of points) {
    const payload = valueAt(point, t.payloadKey)
    if (payload === undefined) continue

    const interval = valueAt(payload, 'interval')
    const start = parseInstant(interval)
    const end = parseInstant({
      physicalTime: valueAt(interval, 'endTime'),
      utcOffset: valueAt(interval, 'endUtcOffset'),
    })
    if (!start || !end) continue

    const externalId = typeof valueAt(point, 'name') === 'string'
      ? String(valueAt(point, 'name'))
      : `${t.id}:${start.utcMs}`
    const sourceId = input.resolveSource(valueAt(point, 'dataSource'))
    const id = stableId(input.personId, sourceId, t.id, externalId)

    sessions.push({
      id,
      personId: input.personId,
      sourceId,
      kind: t.id === 'sleep' ? 'sleep' : t.id === 'electrocardiogram' ? 'ecg' : 'exercise',
      externalId,
      startMs: start.utcMs,
      startOffsetMinutes: start.tzOffsetMinutes,
      endMs: end.utcMs,
      endOffsetMinutes: end.tzOffsetMinutes,
      localDate: localDateOfEnd(end.utcMs, end.tzOffsetMinutes),
      // One shape covers both kinds rather than a per-kind attrs structure. A sleep point
      // resolves the exercise fields to null and vice versa; tier 2 still knows what kind of
      // exercise a session was, and shortAwakenings survives instead of being silently dropped
      // between tier 1 and the stage segments it deliberately does not become.
      //
      // M8a widened this from seven keys to fourteen. Five of the seven added fields - splits,
      // exerciseEvents, activeDuration, displayName and exerciseMetadata.hasGps - were confirmed
      // against a four-point sample in probe/findings/field-map.md; none of them reached tier 2, so
      // a detail page could not be answered from the sessions table at all. A fuller read-only probe
      // taken 2026-09-11, over 197 distinct sessions, replaced that sample: `notes` is observed
      // there - rare, 4 of 197 - so it is mapped because the archive holds it, not only because the
      // v4 schema does. `splitSummaries` is still mapped for the schema alone; it is absent from all
      // 197 sessions, and every `splitType` this household's devices have ever recorded is
      // `DISTANCE`, so no manual lap has ever appeared. `?? null` rather than a presence test:
      // valueAt already answers undefined for a path the payload does not have, and null is what
      // every other key here uses for the same absence. An empty array the provider really sent
      // survives as an empty array, which is a different statement from a provider that sent no
      // array at all.
      attrs: JSON.stringify({
        type: valueAt(payload, 'type') ?? null,
        mainSleep: valueAt(payload, 'metadata.mainSleep') ?? null,
        stagesStatus: valueAt(payload, 'metadata.stagesStatus') ?? null,
        summary: valueAt(payload, 'summary') ?? null,
        metricsSummary: valueAt(payload, 'metricsSummary') ?? null,
        shortAwakenings: valueAt(payload, 'shortAwakenings') ?? null,
        exerciseType: valueAt(payload, 'exerciseType') ?? null,
        splits: valueAt(payload, 'splits') ?? null,
        splitSummaries: valueAt(payload, 'splitSummaries') ?? null,
        exerciseEvents: valueAt(payload, 'exerciseEvents') ?? null,
        activeDuration: valueAt(payload, 'activeDuration') ?? null,
        displayName: valueAt(payload, 'displayName') ?? null,
        notes: valueAt(payload, 'notes') ?? null,
        exerciseMetadata: valueAt(payload, 'exerciseMetadata') ?? null,
      }),
      rawPayloadId: input.rawPayloadId,
    })

    const stages = valueAt(payload, 'stages')
    if (!Array.isArray(stages)) continue
    for (const stage of stages) {
      const stageStart = parseInstant({
        physicalTime: valueAt(stage, 'startTime'), utcOffset: valueAt(stage, 'startUtcOffset'),
      })
      const stageEnd = parseInstant({
        physicalTime: valueAt(stage, 'endTime'), utcOffset: valueAt(stage, 'endUtcOffset'),
      })
      const kind = valueAt(stage, 'type')
      if (!stageStart || !stageEnd || typeof kind !== 'string') continue
      segments.push({
        id: stableId(id, kind, String(stageStart.utcMs)),
        sessionId: id,
        stage: kind,
        startMs: stageStart.utcMs,
        endMs: stageEnd.utcMs,
      })
    }
  }

  return { sessions, segments }
}
