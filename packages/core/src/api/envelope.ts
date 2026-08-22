/**
 * Reading the outer shape of a response, as a verdict rather than a count.
 *
 * The old code asked how many points a body carried and got zero for two situations that mean
 * opposite things: a window the person genuinely has no data in, and a body this code can no
 * longer read. Days with no data are omitted rather than zeroed, which `probe/findings/
 * rollup-methods.md` measured, so zero points is an ordinary answer most days. That made a
 * renamed envelope indistinguishable from a quiet week, and the sync cursor walked straight
 * over it.
 */

export type Envelope =
  /** `body` is the parsed object, so a caller reading a sibling such as a page token does not parse twice. */
  | { readable: true, points: unknown[], body: Record<string, unknown> }
  | { readable: false, reason: string }

/**
 * Keys a response may carry beside its points without meaning anything is wrong. A page token
 * is the only one observed: `probe/findings/rollup-methods.md` records that neither rollup
 * method ever returned one, but the list path pages and `RollUpDataPointsResponse` declares the
 * field, so a body carrying it alone is quiet rather than broken.
 */
export const BENIGN_SIBLINGS: readonly string[] = ['nextPageToken']

const unreadable = (reason: string): Envelope => ({ readable: false, reason })

/**
 * `pointsKey` is `dataPoints` for a list response and `rollupDataPoints` for a rollup one.
 * Passing it in rather than trying both is deliberate: a rollup body arriving on the list path
 * is itself a defect, and a reader that accepted either would swallow it.
 */
export function readEnvelope(body: string, pointsKey: string): Envelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return unreadable('body is not JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return unreadable('body is not a JSON object')
  }

  const object = parsed as Record<string, unknown>
  const points = object[pointsKey]
  if (Array.isArray(points)) return { readable: true, points, body: object }
  // An explicit null says no points without ambiguity. proto3 JSON does not emit it, but a
  // transcoding proxy can, and stalling a cursor on it would be a false positive nobody would
  // call a rename.
  if (points !== undefined && points !== null) {
    return unreadable(`${pointsKey} is present but is not an array`)
  }

  // The points key is absent, which is ambiguous on its own. proto3 JSON omits a repeated field
  // that is empty, so an empty body is the expected shape of a window with no data, and calling
  // that drift would cry wolf on every quiet day.
  //
  // What is not ambiguous is a list of structured points sitting under a name we do not know:
  // that is the field having moved. The three qualifiers each rule out a false positive, and a
  // false positive is expensive here because it stalls the cursor silently.
  //
  //   a list, because a scalar sibling like minStartTimeNs is a new field, not a moved one
  //   of objects, because an id echo is a list of strings and a data point never is
  //   non-empty, because a rename on a day with no data costs nothing and is caught the first
  //   busy day, which is the first day anything is at stake
  const moved = Object.keys(object).filter((key) => (
    !BENIGN_SIBLINGS.includes(key) && looksLikePoints(object[key])
  ))
  if (moved.length > 0) {
    return unreadable(`no ${pointsKey}, but the body carried ${moved.join(', ')}`)
  }
  return { readable: true, points: [], body: object }
}

function looksLikePoints(value: unknown): boolean {
  return Array.isArray(value)
    && value.length > 0
    && typeof value[0] === 'object'
    && value[0] !== null
    && !Array.isArray(value[0])
}
