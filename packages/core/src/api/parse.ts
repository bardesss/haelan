export interface Instant { utcMs: number, tzOffsetMinutes: number }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const hasOwn = (v: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(v, key)

export function valueAt(payload: unknown, path: string): unknown {
  if (!path) return undefined
  let node: unknown = payload
  for (const segment of path.split('.')) {
    // Own-property check only: the paths come from our catalogue but the objects come from
    // Google, and an inherited name like "constructor" must resolve to undefined like any
    // other absent key rather than walking the prototype chain.
    if (!isRecord(node) || !hasOwn(node, segment)) return undefined
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
  // The timestamp and offset must come from the same end of an interval. Falling back through
  // each chain independently could pair endTime with startUtcOffset, which is still absolute
  // but yields the wrong local wall clock whenever the two ends straddle a DST change.
  const pairs: Array<[string, string]> = [
    ['physicalTime', 'utcOffset'],
    ['startTime', 'startUtcOffset'],
    ['endTime', 'endUtcOffset'],
  ]
  for (const [timeKey, offsetKey] of pairs) {
    const physical = node[timeKey]
    if (typeof physical !== 'string') continue
    const utcMs = Date.parse(physical)
    if (!Number.isFinite(utcMs)) continue
    return { utcMs, tzOffsetMinutes: parseOffsetMinutes(node[offsetKey]) }
  }
  return null
}

export function parseCivilDate(node: unknown): string | null {
  if (!isRecord(node)) return null
  const y = node['year']
  const m = node['month']
  const d = node['day']
  // A date missing its month or day is not a date. Reading the proto3 omission as January the
  // first would silently attribute a year of readings to one day.
  if (typeof y !== 'number' || typeof m !== 'number' || typeof d !== 'number') return null
  // A syntactically plausible but impossible date is worse than a rejection, since natural
  // keys and local_date columns downstream will never question it. Full calendar validation
  // (the 31st of a 30 day month) is not this function's job; the API does not send those.
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
