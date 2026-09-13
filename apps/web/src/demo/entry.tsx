import { installFrozenClock } from './frozenClock.js'
import { DEMO_CLOCK_MS } from './instant.js'

// DEMO_CLOCK_MS, not DEMO_INSTANT_MS. The recorder swept every page with its DOM clock pinned to
// DEMO_CLOCK_MS (instant.ts: the last millisecond of the last day the seed actually wrote data
// for, which formats as 2026-09-06), so every url in the manifest was computed from that date.
// DEMO_INSTANT_MS is one millisecond later - the archive's own exclusive close, formatting as
// 2026-09-07 - and freezing the browser to it would make every range-dependent read ask for a day
// nobody recorded, opening the demo on a page of "not in the demo" cards with nothing obviously
// wrong.
installFrozenClock(DEMO_CLOCK_MS)

// Dynamic, and after the clock: a static import would be hoisted above the call above it.
await import('../main.js')
