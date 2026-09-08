import { createHash } from 'node:crypto'
import type { DataType } from './catalogue.ts'
import type { ObservationRow } from '../store/observations.ts'
import { parseInstant, valueAt } from './parse.ts'
import { localDateOf } from '../derive/localDay.ts'
import { ConfigError } from '../errors.ts'

export interface MapObservationsInput {
  dataType: DataType
  body: string
  personId: string
  resolveSource: (dataSource: unknown) => string
  rawPayloadId: string
}

// Derived from the natural key rather than random, the same reason mapSessions' stableId exists:
// a re-fetch of the trailing window must resolve to the same row, not a fresh one beside it.
const stableId = (...parts: string[]) =>
  createHash('sha256').update(parts.join(' ')).digest('hex').slice(0, 32)

/**
 * How one of the five declared observation types reads its clock and its value. Kept here,
 * keyed by id, rather than as more DataType fields: mapSessions already picks `kind` off `t.id`
 * the same way (`t.id === 'sleep' ? 'sleep' : 'exercise'`), and five fixed, exhaustively-known
 * shapes do not need a general-purpose schema of their own the way samples' valuePath does.
 *
 * `clock: 'sample'` reads `sampleTime` and never sets an end. `clock: 'interval'` reads both
 * ends of `interval`, the same pair mapSessions resolves a session's own end from.
 *
 * `value: 'field'` reads `t.valuePath` as one enum leaf. `value: 'array'` reads `t.valuePath` as
 * an array of enum leaves and writes one row per element - three symptoms at one instant are
 * three observations, because that is what a reader would count. `value: 'none'` writes one row
 * with a null value: menstrual-period's `notes` and irregular-rhythm-notification's
 * `alertWindows[]` are archived in the raw payload rather than read here, because nothing has
 * asked this table to hold either yet.
 */
interface ObservationSpec {
  kind: string
  clock: 'sample' | 'interval'
  value: 'field' | 'array' | 'none'
  /**
   * Overrides `t.valuePath` for the leaf this spec reads. Unset for the original five, which
   * read `t.valuePath` directly because `target: 'observations'` is their only target and the
   * catalogue's own valuePath already names the right leaf. ECG is the exception: its
   * `t.valuePath` names `beatsPerMinuteAvg`, read by mapSamples via `alsoTargets`, so this mapper
   * needs its own leaf name for `resultClassification` rather than sharing that one field.
   */
  valuePath?: string
}

const SPEC_BY_ID: Readonly<Record<string, ObservationSpec>> = {
  'ovulation-test': { kind: 'ovulation_test', clock: 'sample', value: 'field' },
  // moods carries valences[] alongside moods[], parallel arrays over the same instant. Only
  // moods[] is mapped; pairing a mood with its valence is a second decision nothing here is
  // asking for yet, so valences stays archived rather than guessed at.
  moods: { kind: 'mood', clock: 'sample', value: 'array' },
  symptoms: { kind: 'symptom', clock: 'sample', value: 'array' },
  'menstrual-period': { kind: 'menstrual_period', clock: 'interval', value: 'none' },
  'irregular-rhythm-notification': { kind: 'irregular_rhythm', clock: 'interval', value: 'none' },
  // Task 8: the ECG payload's own interval (SessionTimeInterval, same shape as
  // irregular-rhythm-notification's) is the clock; resultClassification is a single enum leaf,
  // same shape as ovulation-test's result.
  ecg: { kind: 'ecg_classification', clock: 'interval', value: 'field', valuePath: 'resultClassification' },
}

export function mapObservations(input: MapObservationsInput): ObservationRow[] {
  const t = input.dataType
  // A type may write here as its primary target, or as an extra one named in alsoTargets - see
  // mapSamples.ts and mapSessions.ts for the same guard.
  if (t.target !== 'observations' && !t.alsoTargets?.includes('observations')) {
    throw new ConfigError(`${t.id} is not an observation type`)
  }
  const spec = SPEC_BY_ID[t.id]
  // Every type this mapper is asked to handle is one of the five above, by construction of the
  // catalogue; a target: 'observations' entry with no spec is a mistake in this file, not a
  // payload this mapper can shrug off the way an unrecognised sub-dimension key does.
  if (!spec) throw new ConfigError(`${t.id} has no observation mapping declared`)

  // Mirrors mapSamples' own defensive parsing exactly: a body that is not JSON, or whose
  // dataPoints is not an array, yields no rows rather than throwing.
  let parsed: unknown
  try {
    parsed = JSON.parse(input.body)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const dataPoints = (parsed as { dataPoints?: unknown }).dataPoints
  const points = Array.isArray(dataPoints) ? dataPoints : []

  const rows: ObservationRow[] = []
  for (const point of points) {
    const payload = valueAt(point, t.payloadKey)
    if (payload === undefined) continue

    let startedAtMs: number
    let startedAtOffsetMinutes: number
    let endedAtMs: number | null = null
    let endedAtOffsetMinutes: number | null = null

    if (spec.clock === 'sample') {
      const instant = parseInstant(valueAt(payload, 'sampleTime'))
      if (!instant) continue
      startedAtMs = instant.utcMs
      startedAtOffsetMinutes = instant.tzOffsetMinutes
    } else {
      const interval = valueAt(payload, 'interval')
      const start = parseInstant(interval)
      const end = parseInstant({
        physicalTime: valueAt(interval, 'endTime'),
        utcOffset: valueAt(interval, 'endUtcOffset'),
      })
      if (!start || !end) continue
      startedAtMs = start.utcMs
      startedAtOffsetMinutes = start.tzOffsetMinutes
      endedAtMs = end.utcMs
      endedAtOffsetMinutes = end.tzOffsetMinutes
    }

    const sourceId = input.resolveSource(valueAt(point, 'dataSource'))
    const localDate = localDateOf(startedAtMs, startedAtOffsetMinutes)

    const pushRow = (value: string | null, index: number) => {
      rows.push({
        id: stableId(input.personId, sourceId, t.id, String(startedAtMs), String(index)),
        personId: input.personId,
        sourceId,
        kind: spec.kind,
        startedAtMs,
        startedAtOffsetMinutes,
        endedAtMs,
        endedAtOffsetMinutes,
        localDate,
        value,
        rawPayloadId: input.rawPayloadId,
      })
    }

    if (spec.value === 'none') {
      pushRow(null, 0)
    } else if (spec.value === 'field') {
      const raw = valueAt(payload, spec.valuePath ?? t.valuePath)
      if (typeof raw === 'string' && raw !== '') pushRow(raw, 0)
    } else {
      const raw = valueAt(payload, spec.valuePath ?? t.valuePath)
      const elements = Array.isArray(raw) ? raw : []
      elements.forEach((element, index) => {
        if (typeof element === 'string' && element !== '') pushRow(element, index)
      })
    }
  }

  return rows
}
