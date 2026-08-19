export interface Instant { utcMs: number, tzOffsetMinutes: number }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function valueAt(payload: unknown, path: string): unknown {
  if (!path) return undefined
  let node: unknown = payload
  for (const segment of path.split('.')) {
    if (!isRecord(node)) return undefined
    node = node[segment]
  }
  return node
}

// Integer fields arrive as JSON strings, so a bare typeof check would drop every heart rate.
export function parseNumeric(node: unknown): number | null {
  if (typeof node === 'number') return Number.isFinite(node) ? node : null
  if (typeof node !== 'string' || node === '') return null
  const parsed = Number(node)
  return Number.isFinite(parsed) ? parsed : null
}

// Offsets appear both as a protobuf duration ("7200s") and in the colon form. Absent means
// zero, because proto3 omits zero-valued fields rather than sending them.
function parseOffsetMinutes(node: unknown): number {
  if (typeof node !== 'string' || node === '') return 0
  const seconds = /^(-?\d+)s$/.exec(node)
  if (seconds?.[1]) return Math.trunc(Number(seconds[1]) / 60)
  const colon = /^([+-])(\d{2}):(\d{2})$/.exec(node)
  if (colon) {
    const minutes = Number(colon[2]) * 60 + Number(colon[3])
    return colon[1] === '-' ? -minutes : minutes
  }
  return 0
}

export function parseInstant(node: unknown): Instant | null {
  if (!isRecord(node)) return null
  const physical = node['physicalTime'] ?? node['startTime'] ?? node['endTime']
  if (typeof physical !== 'string') return null
  const utcMs = Date.parse(physical)
  if (!Number.isFinite(utcMs)) return null
  return { utcMs, tzOffsetMinutes: parseOffsetMinutes(node['utcOffset'] ?? node['startUtcOffset']) }
}

export function parseCivilDate(node: unknown): string | null {
  if (!isRecord(node)) return null
  const y = node['year']
  const m = node['month']
  const d = node['day']
  // A date missing its month or day is not a date. Reading the proto3 omission as January the
  // first would silently attribute a year of readings to one day.
  if (typeof y !== 'number' || typeof m !== 'number' || typeof d !== 'number') return null
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
