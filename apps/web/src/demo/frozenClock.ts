/**
 * Pins the browser's idea of now to the demo instant.
 *
 * The seed's span is fixed (DEMO_END_DATE, and scripts/seed-demo.mjs says why reproducible beats
 * current), so without this every page's default range walks past the end of the data as real
 * time moves and a visitor's first screen is empty - the same right-hand-edge problem the seed's
 * own comment describes, arriving from the other side. It also keeps the recorded fixtures
 * addressable: the urls a page asks for are computed from today.
 */
export function installFrozenClock(ms: number): void {
  const RealDate = Date
  class FrozenDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      // args.length as unknown[]: TS infers ConstructorParameters<typeof Date> from Date's last
      // overload alone (year, monthIndex, ...optional), whose tuple type never has length 0, so
      // comparing the tuple-typed length directly to 0 is flagged as always false (TS2367) even
      // though a real `new Date()` call does produce a zero-length args array at runtime.
      if ((args as unknown[]).length === 0) super(ms)
      else super(...args)
    }
    static now(): number { return ms }
  }
  globalThis.Date = FrozenDate as DateConstructor
}
