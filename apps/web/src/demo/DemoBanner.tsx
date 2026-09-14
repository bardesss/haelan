import { useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { DEMO_CLOCK_MS } from './instant.js'
import { detectDemoLang } from './lang.js'
import type { DemoLang } from './lang.js'

// Marks the host `<div>` mountDemoBanner appends to document.body, so a second call (StrictMode's
// double-invoked effects, or entry.tsx running twice under HMR) can tell one is already there
// instead of stacking a second banner on top of it.
const HOST_ATTR = 'data-demo-banner'

// Two strings, not a route through i18n/index.tsx - see lang.ts's own header comment for why, and
// for why the visitor's language still has to be read: client.ts's demo refusal message now reads
// it too, which is why the detection itself moved out to its own module rather than staying
// private here.
const BANNER_TEXT: Record<DemoLang, (dateLabel: string) => string> = {
  en: (dateLabel) => `This is a demo. The data is generated, not anyone’s real health ` +
    `history, and it ends on ${dateLabel}. Anything you write here lives only in this browser ` +
    `tab; a reload resets it. Excluding a day or a session does change what you see, the ` +
    `same as a real instance; what does not follow is a recompute, so a figure derived from ` +
    `that data upstream (cardio load, a baseline, an insight) keeps the value it ` +
    `was recorded with. It also only holds a recorded slice of the archive, not the whole of ` +
    `it, so wandering past what was captured (another period back, another night) shows ` +
    `nothing rather than something broken.`,
  // Kept to the same claims as the English above, including the third sentence's distinction (an
  // exclusion does change the page; a recompute does not follow it) - the one the review that
  // required this file called out as easy to soften in translation - and now the fourth, the
  // coverage edge the review that widened the sweep still requires naming: a slice was recorded,
  // not the archive, and stepping outside it is silence, not a fault. "cardiobelasting" and
  // "afgeleid" are not translator's choices made here for the first time: both already appear in
  // nl.json (settings.cardioLoadHelp, setup's timezoneWarning) for exactly these concepts, and
  // "je"/"jouw" throughout nl.json is this app's own register, not "u" - matched here rather than
  // introducing a second one.
  nl: (dateLabel) => `Dit is een demo. De gegevens zijn gegenereerd, niet iemands echte ` +
    `gezondheidsgeschiedenis, en eindigen op ${dateLabel}. Alles wat je hier schrijft, blijft ` +
    `alleen in dit tabblad bestaan; herladen zet het terug. Een dag of sessie uitsluiten ` +
    `verandert wél wat je ziet, net als bij een echte installatie; wat niet volgt, is een ` +
    `herberekening: een cijfer dat van die gegevens is afgeleid (cardiobelasting, een ` +
    `baseline, een inzicht) behoudt de waarde waarmee het is vastgelegd. Ook bevat de demo ` +
    `maar een opgenomen deel van het archief, niet het geheel; verder terugbladeren dan is ` +
    `vastgelegd (nog een periode terug, nog een nacht) toont niets, geen storing.`,
}

// Intl locale to format DEMO_CLOCK_MS's date in, one per DemoLang - kept alongside BANNER_TEXT
// rather than derived from it, so a date embedded mid-sentence never ends up in a script the rest
// of that sentence isn't written in.
const DATE_LOCALE: Record<DemoLang, string> = { en: 'en-US', nl: 'nl-NL' }

export function DemoBanner({ host }: { host?: HTMLElement } = {}) {
  const lang = detectDemoLang()
  const dateLabel = new Date(DEMO_CLOCK_MS).toLocaleDateString(DATE_LOCALE[lang], {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  // Measured here, inside the component's own commit, rather than by the caller right after
  // `root.render(...)` returns - see publishBannerHeight's doc comment for why that call site was
  // wrong. useLayoutEffect runs synchronously once this component's own output has actually been
  // written into `host`, so the very first measurement already sees the real, rendered height.
  useLayoutEffect(() => {
    if (!host) return undefined
    return publishBannerHeight(host)
  }, [host])

  return (
    <div
      role="note"
      lang={lang}
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
      <p style={{ margin: 0 }}>{BANNER_TEXT[lang](dateLabel)}</p>
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
  // `host` also goes in as a prop, so DemoBanner's own useLayoutEffect - not this call site - does
  // the first measurement. See publishBannerHeight's doc comment for why.
  createRoot(host).render(<DemoBanner host={host} />)
}

/**
 * Tells the app's own layout how much room this banner took.
 *
 * `.rail` is `position: sticky; top: 0` and exactly one viewport tall, because `.rail-foot` pins
 * the account to its bottom with `margin-top: auto`. Prepending anything to document.body pushes
 * the rail down while leaving it a full viewport high, so its bottom lands below the fold and its
 * own `overflow-y: auto` turns the menu into a scroller - which is what this banner did.
 *
 * Measured rather than declared: the banner is four sentences of prose in two languages and wraps
 * to a different height at every width, so any constant here would be wrong for some reader.
 *
 * Called from DemoBanner's own useLayoutEffect, not from mountDemoBanner right after
 * `root.render(...)` returns: `createRoot(...).render(...)` does not paint or even commit
 * synchronously, so a measurement taken immediately after that call reads `host` while it is still
 * empty - 0px, every time, not a rare loss of a race. useLayoutEffect instead runs synchronously
 * once this component's own commit has actually landed, so the first measurement is already
 * correct. The ResizeObserver installed here is what keeps it correct after that, through a window
 * resize and through the reflow that follows the fonts landing; app.css reads the result as
 * --chrome-above, defaulting to 0px, so a real instance - where nothing sits above the app - is
 * untouched. Returns a cleanup that disconnects the observer, for the effect it's called from.
 */
function publishBannerHeight(host: HTMLElement): () => void {
  const publish = (): void => {
    const height = Math.ceil(host.getBoundingClientRect().height)
    document.documentElement.style.setProperty('--chrome-above', `${height}px`)
  }
  publish()
  const observer = new ResizeObserver(publish)
  observer.observe(host)
  return () => observer.disconnect()
}
