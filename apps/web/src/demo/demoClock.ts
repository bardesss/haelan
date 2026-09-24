/**
 * Starts the browser's clock at the demo's own day and lets it run from there.
 *
 * Two requirements, and the first version of this met only one of them.
 *
 * It must READ as the demo's day. The seed's span is fixed (DEMO_END_DATE, and
 * scripts/seed-demo.mjs says why reproducible beats current), so without this every page's default
 * range walks past the end of the data as real time moves and a visitor's first screen is empty.
 * It also keeps the recorded fixtures addressable: the urls a page asks for are computed from
 * today, and the manifest is keyed by those urls.
 *
 * It must also ADVANCE, which the first version did not: it returned a constant. zrender takes its
 * animation clock from `new Date().getTime()` (zrender/lib/animation/Animation.js), so a constant
 * makes every frame's elapsed time zero and no animation ever progresses. Every animated series
 * then stays at its initial state - bars drawn at height zero - while axes, labels and tooltips,
 * none of which animate, render normally. The demo shipped that way: charts with a correct y-axis
 * and working tooltips reading real values, and no bars.
 *
 * `performance.now` rather than the real `Date.now`: it is monotonic, so a system clock change
 * under a reader's feet cannot drag the demo's day sideways.
 */
export function installDemoClock(startMs: number, ceilingMs = Number.POSITIVE_INFINITY): void {
  const RealDate = Date
  const origin = performance.now()
  // Bounded, so a tab left open cannot tick past the last day the seed wrote data for: every url
  // a page computes from today would miss the manifest, on a page that worked a moment earlier.
  // Looped rather than clamped: the demo starts half an hour before its ceiling (instant.ts), and a
  // clamp would hold the clock constant from then on, stalling every chart mounted afterwards - the
  // defect described above. The one cost is an animation in flight at the instant of the loop,
  // which waits for the clock to catch up with its start; every later one runs. Infinity % is
  // the identity, so an unbounded clock is unaffected.
  const span = ceilingMs - startMs + 1
  const virtualNow = (): number => startMs + ((performance.now() - origin) % span)

  class DemoDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      // args.length as unknown[]: TS infers ConstructorParameters<typeof Date> from Date's last
      // overload alone (year, monthIndex, ...optional), whose tuple type never has length 0, so
      // comparing the tuple-typed length directly to 0 is flagged as always false (TS2367) even
      // though a real `new Date()` call does produce a zero-length args array at runtime.
      if ((args as unknown[]).length === 0) super(virtualNow())
      else super(...args)
    }

    static now(): number { return virtualNow() }
  }

  globalThis.Date = DemoDate as DateConstructor
}
