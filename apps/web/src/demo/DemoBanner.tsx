import { useId, useLayoutEffect, useState } from 'react'
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
//
// Split into a lead (the notice's first two sentences: it is a demo, and the data ends on
// <date>) and the rest, rather than kept as one string, so a phone-width reader gets the lead and
// a disclosure for the rest instead of four sentences of prose in a narrow column - see the
// `<details>` this file renders below and its own CSS in app.css. The words are unchanged from
// before this split; only where the sentence boundary falls is new.
const BANNER_LEAD: Record<DemoLang, (dateLabel: string) => string> = {
  en: (dateLabel) => `This is a demo. The data is generated, not anyone’s real health ` +
    `history, and it ends on ${dateLabel}.`,
  nl: (dateLabel) => `Dit is een demo. De gegevens zijn gegenereerd, niet iemands echte ` +
    `gezondheidsgeschiedenis, en eindigen op ${dateLabel}.`,
}

// Kept to the same claims as the English above, including the (now second) sentence's distinction
// (an exclusion does change the page; a recompute does not follow it) - the one the review that
// required this file called out as easy to soften in translation - and the coverage edge the
// review that widened the sweep still requires naming: a slice was recorded, not the archive, and
// stepping outside it is silence, not a fault. "cardiobelasting" and "afgeleid" are not
// translator's choices made here for the first time: both already appear in nl.json
// (settings.cardioLoadHelp, setup's timezoneWarning) for exactly these concepts, and "je"/"jouw"
// throughout nl.json is this app's own register, not "u" - matched here rather than introducing a
// second one.
const BANNER_REST: Record<DemoLang, string> = {
  en: `Anything you write here lives only in this browser ` +
    `tab; a reload resets it. Excluding a day or a session does change what you see, the ` +
    `same as a real instance; what does not follow is a recompute, so a figure derived from ` +
    `that data upstream (cardio load, a baseline, an insight) keeps the value it ` +
    `was recorded with. It also only holds a recorded slice of the archive, not the whole of ` +
    `it, so wandering past what was captured (another period back, another night) shows ` +
    `nothing rather than something broken.`,
  nl: `Alles wat je hier schrijft, blijft ` +
    `alleen in dit tabblad bestaan; herladen zet het terug. Een dag of sessie uitsluiten ` +
    `verandert wél wat je ziet, net als bij een echte installatie; wat niet volgt, is een ` +
    `herberekening: een cijfer dat van die gegevens is afgeleid (cardiobelasting, een ` +
    `baseline, een inzicht) behoudt de waarde waarmee het is vastgelegd. Ook bevat de demo ` +
    `maar een opgenomen deel van het archief, niet het geheel; verder terugbladeren dan is ` +
    `vastgelegd (nog een periode terug, nog een nacht) toont niets, geen storing.`,
}

// The phone-only disclosure's own button label, open and closed - the demo banner's per-language
// table, same exception no-hardcoded-strings.test.ts already leaves this file (see BANNER_LEAD's
// own comment on why nothing here routes through i18n).
const MORE_LABEL: Record<DemoLang, string> = { en: 'More', nl: 'Meer' }
const LESS_LABEL: Record<DemoLang, string> = { en: 'Less', nl: 'Minder' }

// Intl locale to format DEMO_CLOCK_MS's date in, one per DemoLang - kept alongside BANNER_TEXT
// rather than derived from it, so a date embedded mid-sentence never ends up in a script the rest
// of that sentence isn't written in.
const DATE_LOCALE: Record<DemoLang, string> = { en: 'en-US', nl: 'nl-NL' }

const DISMISS_LABEL: Record<DemoLang, string> = { en: 'Dismiss the demo notice', nl: 'Demomelding sluiten' }

// Per tab, not per browser: a visitor who closes the notice keeps it closed while they look
// around, and a new tab - which is also where everything they wrote here is gone again - shows it
// once more. Session storage can be missing or refuse (a private window, blocked site data), and
// then the notice simply shows, which is the safe way for this to fail.
const DISMISSED_KEY = 'haelan-demo-banner-dismissed'

function readDismissed(): boolean {
  try { return window.sessionStorage.getItem(DISMISSED_KEY) === '1' } catch { return false }
}

function rememberDismissed(): void {
  try { window.sessionStorage.setItem(DISMISSED_KEY, '1') } catch { /* shows again next load */ }
}

export function DemoBanner({ host }: { host?: HTMLElement } = {}) {
  const lang = detectDemoLang()
  const [dismissed, setDismissed] = useState(readDismissed)
  // Below the phone breakpoint only - app.css hides `.demo-banner-toggle` above it, where the rest
  // of the notice is simply shown regardless of this flag. Real React state, not a native
  // `<details>`: a closed `<details>` hides its own children in a way author CSS on the child
  // cannot override (Chromium: `details.open === false` makes the child fail
  // `checkVisibility()` even when a rule sets `display: inline` on it), which is what silently
  // hid the rest of the notice from every desktop visitor - screen readers included - after this
  // banner first grew a disclosure. A plain toggled element has no such hidden layer.
  const [open, setOpen] = useState(false)
  const restId = useId()
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
  // `dismissed` is a dependency so the height is published again the moment the notice goes: the
  // host is empty then, and --chrome-above has to fall to 0 in the same commit, or the rail would
  // keep leaving room for a banner that is no longer there.
  useLayoutEffect(() => {
    if (!host) return undefined
    return publishBannerHeight(host)
  }, [host, dismissed])

  if (dismissed) return null

  return (
    <div role="note" lang={lang} className="demo-banner">
      <p className="demo-banner-lead">{BANNER_LEAD[lang](dateLabel)}</p>
      {/* No `<details>`: a closed one hides its own children in a way author CSS on the child
          cannot override (see the `open` state's own comment above), so the rest of the notice is
          a plain paragraph, collapsed by CSS class rather than by a native element's hidden
          internals. `.demo-banner-toggle` is likewise plain markup throughout, hidden above the
          phone breakpoint by app.css rather than left unrendered, so its aria-expanded/aria-controls
          pair is always real even on a width where nothing shows the button itself. */}
      <p id={restId} className={open ? 'demo-banner-rest' : 'demo-banner-rest is-collapsed'}>{BANNER_REST[lang]}</p>
      <button
        type="button"
        className="demo-banner-toggle"
        aria-expanded={open}
        aria-controls={restId}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? LESS_LABEL[lang] : MORE_LABEL[lang]}
      </button>
      <button
        type="button"
        className="demo-banner-close"
        aria-label={DISMISS_LABEL[lang]}
        title={DISMISS_LABEL[lang]}
        onClick={() => { rememberDismissed(); setDismissed(true) }}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
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
