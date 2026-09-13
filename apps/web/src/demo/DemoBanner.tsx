import { createRoot } from 'react-dom/client'
import { DEMO_CLOCK_MS } from './instant.js'

// Marks the host `<div>` mountDemoBanner appends to document.body, so a second call (StrictMode's
// double-invoked effects, or entry.tsx running twice under HMR) can tell one is already there
// instead of stacking a second banner on top of it.
const HOST_ATTR = 'data-demo-banner'

// English rather than run through i18n/index.tsx: this banner is not part of the product Shell
// renders (see entry.tsx's own comment - it mounts into a host element outside main.tsx's tree,
// before I18nProvider exists), and it describes the demo harness itself rather than anything a
// self-hosted instance ships. Standing up a second I18nextProvider here to translate three
// sentences about the demo mechanism would be scope this task was never asked for; the landing
// page this demo sits under (site/index.html) is English-only for the same reason.
const DEMO_END_DATE_LABEL = new Date(DEMO_CLOCK_MS).toLocaleDateString('en-US', {
  timeZone: 'Europe/Amsterdam',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
})

export function DemoBanner() {
  return (
    <div
      role="note"
      style={{
        // Semantic tokens, not literal colours: apps/web/test/no-raw-color.test.ts enforces this
        // across apps/web/src with no carve-out for a demo-only element, and --surface-rail /
        // --text-primary already read as "chrome, not page content" everywhere else Sidebar.tsx
        // uses them, which is exactly what this banner is.
        background: 'var(--surface-rail)',
        color: 'var(--text-primary)',
        borderBottom: '1px solid var(--border-subtle)',
        fontSize: 'var(--font-size-xs)',
        lineHeight: 1.5,
        padding: '0.6rem 1rem',
        textAlign: 'center',
      }}
    >
      <p style={{ margin: 0 }}>
        This is a demo. The data is generated, not anyone&rsquo;s real health history, and it ends
        on {DEMO_END_DATE_LABEL}. Anything you write here lives only in this browser tab &mdash; a
        reload resets it. Excluding a day or a session does change what you see, the same as a
        real instance; what does not follow is a recompute, so a figure derived from that data
        upstream &mdash; cardio load, a baseline, an insight &mdash; keeps the value it was
        recorded with.
      </p>
    </div>
  )
}

/**
 * Appends its own host to `document.body` and renders `DemoBanner` into a second root, rather
 * than adding a component to Shell.tsx: the product's tree stays exactly what a real instance
 * ships, and this task's whole footprint is one element bolted on beside it.
 *
 * Idempotent because entry.tsx runs this ahead of `main.js` (see its own comment on why), and a
 * page that re-executes that module - a dev server's HMR reload of entry.tsx itself, or a test
 * calling this twice the way apps/web/test/demo-banner.test.tsx does - must not stack a second
 * banner on top of the first.
 */
export function mountDemoBanner(): void {
  if (document.querySelector(`[${HOST_ATTR}]`) !== null) return
  const host = document.createElement('div')
  host.setAttribute(HOST_ATTR, '')
  // Prepended, not appended: the banner reads as a header above the app, not a footer a reader
  // has to scroll to find.
  document.body.prepend(host)
  createRoot(host).render(<DemoBanner />)
}
