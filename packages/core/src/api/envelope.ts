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
  | { readable: true, points: unknown[] }
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
  if (Array.isArray(points)) return { readable: true, points }
  if (points !== undefined) return unreadable(`${pointsKey} is present but is not an array`)

  // The points key is absent, which is ambiguous on its own. proto3 JSON omits a repeated field
  // that is empty, so an empty body is the expected shape of a window with no data, and calling
  // that drift would cry wolf on every quiet day. What is not ambiguous is a body carrying
  // content under names we do not know: that is a field that got renamed, which is precisely
  // the case zero-point counting could never see.
  const unknown = Object.keys(object).filter((key) => !BENIGN_SIBLINGS.includes(key))
  if (unknown.length > 0) {
    return unreadable(`no ${pointsKey}, but the body carried ${unknown.join(', ')}`)
  }
  return { readable: true, points: [] }
}
