export interface Thinned<T> {
  points: T[]
  reduction: { method: 'lttb' | 'minmax', from: number, to: number } | null
}

interface ThinOpts<T> {
  method: 'lttb' | 'minmax'
  x: (p: T) => number
  y: (p: T) => number
}

/**
 * Thin an already stored series for one response, leaving storage untouched.
 *
 * LTTB (largest triangle three buckets) picks points that preserve a line's visual shape, which
 * is what a single trace wants. Min/max bucketing keeps each bucket's extremes, which is what a
 * range band wants: LTTB run over a band would discard exactly the extremes the band exists to
 * show. The caller states which it wants per call; there is no default.
 *
 * `reduction` is null exactly when nothing was thinned, so a client can tell 400 points that are
 * the whole series from 400 points standing in for 130,000.
 */
export function thin<T>(points: readonly T[], target: number, opts: ThinOpts<T>): Thinned<T> {
  if (points.length <= target || points.length <= 2) {
    return { points: [...points], reduction: null }
  }

  const out = opts.method === 'lttb' ? lttb(points, target, opts) : minmax(points, target, opts)

  return { points: out, reduction: { method: opts.method, from: points.length, to: out.length } }
}

// Largest triangle three buckets: keeps first and last, and for every bucket in between picks
// the point that forms the largest triangle with the previous kept point and the next bucket's
// average, which is the point that most changes the line's shape if dropped.
function lttb<T>(points: readonly T[], target: number, opts: ThinOpts<T>): T[] {
  if (target <= 2) return [points[0]!, points.at(-1)!]

  const out: T[] = [points[0]!]
  // Buckets exclude the first and last point, which are always kept, so there are target - 2
  // buckets between them.
  const bucketCount = target - 2
  const bucketSize = (points.length - 2) / bucketCount

  let previousIndex = 0
  for (let i = 0; i < bucketCount; i++) {
    const bucketStart = Math.floor(1 + i * bucketSize)
    const bucketEnd = Math.floor(1 + (i + 1) * bucketSize)
    const nextBucketStart = bucketEnd
    const nextBucketEnd = i === bucketCount - 1 ? points.length : Math.floor(1 + (i + 2) * bucketSize)

    let avgX = 0
    let avgY = 0
    let avgCount = 0
    for (let j = nextBucketStart; j < Math.min(nextBucketEnd, points.length); j++) {
      avgX += opts.x(points[j]!)
      avgY += opts.y(points[j]!)
      avgCount++
    }
    if (avgCount === 0) {
      avgX = opts.x(points.at(-1)!)
      avgY = opts.y(points.at(-1)!)
      avgCount = 1
    }
    avgX /= avgCount
    avgY /= avgCount

    const prevX = opts.x(points[previousIndex]!)
    const prevY = opts.y(points[previousIndex]!)

    let bestIndex = bucketStart
    let bestArea = -1
    for (let j = bucketStart; j < Math.min(bucketEnd, points.length); j++) {
      const px = opts.x(points[j]!)
      const py = opts.y(points[j]!)
      const area = Math.abs(
        (prevX - avgX) * (py - prevY) - (prevX - px) * (avgY - prevY),
      )
      if (area > bestArea) {
        bestArea = area
        bestIndex = j
      }
    }

    out.push(points[bestIndex]!)
    previousIndex = bestIndex
  }

  out.push(points.at(-1)!)
  return out
}

// target counts points, not buckets, and each interior bucket can contribute two of them (its
// min and its max), so the bucket count is half the interior budget. Without the halving the
// output lands near 2 * target, which turns a budget into an estimate.
function minmax<T>(points: readonly T[], target: number, opts: ThinOpts<T>): T[] {
  return bucketExtremes(points, target, { x: opts.x, low: opts.y, high: opts.y })
}

export interface ThinBandOpts<T> {
  x: (p: T) => number
  /** The value that draws the band's lower edge. */
  low: (p: T) => number
  /** The value that draws the band's upper edge. */
  high: (p: T) => number
}

/**
 * Thins a series drawn as a band whose two edges are different fields on the same point, an
 * intraday min/mean/max row for instance, rather than one scalar `thin`'s `y` accessor can name.
 *
 * Bucketing on a single derived value, even the point's own mean, is what let a spike in `max` or
 * a trough in `min` disappear while the mean it was bucketed on stayed unremarkable: the value
 * the band exists to show was never the one deciding which point survived. Each bucket instead
 * keeps whichever point has the lowest `low` and whichever has the highest `high`, independently,
 * so a real extreme in either edge survives regardless of what the other edge or the mean of
 * either chosen point happened to be.
 */
export function thinBand<T>(points: readonly T[], target: number, opts: ThinBandOpts<T>): Thinned<T> {
  if (points.length <= target || points.length <= 2) {
    return { points: [...points], reduction: null }
  }
  const out = bucketExtremes(points, target, opts)
  return { points: out, reduction: { method: 'minmax', from: points.length, to: out.length } }
}

function bucketExtremes<T>(
  points: readonly T[],
  target: number,
  opts: { x: (p: T) => number, low: (p: T) => number, high: (p: T) => number },
): T[] {
  if (target <= 2) return [points[0]!, points.at(-1)!]

  const middleStart = 1
  const middleEnd = points.length - 1
  const bucketCount = Math.floor((target - 2) / 2)
  if (bucketCount === 0) return [points[0]!, points.at(-1)!]
  const bucketSize = (middleEnd - middleStart) / bucketCount

  const out: T[] = [points[0]!]
  for (let i = 0; i < bucketCount; i++) {
    const start = Math.floor(middleStart + i * bucketSize)
    const end = Math.floor(middleStart + (i + 1) * bucketSize)
    if (start >= end || start >= middleEnd) continue

    let minPoint = points[start]!
    let maxPoint = points[start]!
    for (let j = start; j < Math.min(end, middleEnd); j++) {
      const p = points[j]!
      if (opts.low(p) < opts.low(minPoint)) minPoint = p
      if (opts.high(p) > opts.high(maxPoint)) maxPoint = p
    }

    if (opts.x(minPoint) <= opts.x(maxPoint)) {
      out.push(minPoint)
      if (minPoint !== maxPoint) out.push(maxPoint)
    } else {
      out.push(maxPoint)
      if (minPoint !== maxPoint) out.push(minPoint)
    }
  }

  out.push(points.at(-1)!)
  return out
}
