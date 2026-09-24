import { installDemoClock } from './demoClock.js'
import { DEMO_CLOCK_MS, DEMO_CLOCK_CEILING_MS } from './instant.js'
import { mountDemoBanner } from './DemoBanner.js'
import { demoRefusalMessage } from './client.js'

// DEMO_CLOCK_MS, not DEMO_INSTANT_MS. The recorder swept every page with its DOM clock started at
// DEMO_CLOCK_MS (instant.ts: 23:30 on the last day the seed actually wrote data for, which
// formats as 2026-09-06), so every url in the manifest was computed from that date.
// DEMO_INSTANT_MS is the archive's own exclusive close, formatting as 2026-09-07, and starting the
// browser there would make every range-dependent read ask for a day nobody recorded, opening the
// demo on a page of "not in the demo" cards with nothing obviously wrong.
//
// The ceiling is what keeps that true for a tab left open: the clock advances (demoClock.ts says
// why - a constant stalls every chart animation) and must not tick past this day's end into a date
// the seed wrote nothing for.
installDemoClock(DEMO_CLOCK_MS, DEMO_CLOCK_CEILING_MS)

// Its own root, appended to document.body ahead of main.js's own createRoot(document.getElementById
// ('root')) call below: mounting it here, rather than adding it to Shell.tsx, keeps the product's
// component tree exactly what a real instance ships. See DemoBanner.tsx's own comment for why this
// banner does not go through I18nProvider either.
mountDemoBanner()

/**
 * ControlRow's "download totals" link (apps/web/src/components/ControlRow.tsx) renders a plain
 * `<a href="/api/v1/p/.../export?...">` - a real file download in a real instance, so it is
 * deliberately a link rather than a fetch call, and it never goes through apiSend at all. On Pages
 * that href is not base-prefixed (it is not an app route withBase would know to rewrite) and the
 * path itself does not exist, so an unhandled click navigates the whole tab to a 404 with only the
 * browser's own Back button to recover - the demo's primary chrome throwing a visitor out of it,
 * on every rail page. A capture-phase listener on the document, added here rather than by changing
 * ControlRow itself, is what catches it before the browser acts on the href: no product file needs
 * to know the demo exists for this one fix. `closest`, not a direct tag check, because the actual
 * click target is usually the icon or the label text inside the anchor, not the anchor element
 * itself.
 */
document.addEventListener('click', (event) => {
  const anchor = (event.target as Element | null)?.closest?.('a[href^="/api/"]')
  if (anchor === null || anchor === undefined) return
  event.preventDefault()
  // window.alert, not a page-level error state: this fires from a global listener with no
  // component of its own to hold a message in, the same reason installFrozenClock and
  // mountDemoBanner above work outside React rather than inside it. The wording is the identical
  // refusal a sync run gets (demoRefusalMessage, shared with client.ts's own writeThrough catch),
  // so a visitor reads one consistent explanation for every action this static build cannot
  // honour, not a second, differently worded one invented just for this button.
  window.alert(demoRefusalMessage())
}, true)

// Dynamic, and after the clock: a static import would be hoisted above the call above it.
await import('../main.js')
