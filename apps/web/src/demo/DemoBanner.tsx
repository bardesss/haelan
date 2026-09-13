import { createRoot } from 'react-dom/client'
import { DEMO_CLOCK_MS } from './instant.js'

// Marks the host `<div>` mountDemoBanner appends to document.body, so a second call (StrictMode's
// double-invoked effects, or entry.tsx running twice under HMR) can tell one is already there
// instead of stacking a second banner on top of it.
const HOST_ATTR = 'data-demo-banner'

// Two strings, not a route through i18n/index.tsx: this banner is not part of the product Shell
// renders (see entry.tsx's own comment - it mounts into a host element outside main.tsx's tree,
// before I18nProvider exists), and i18n/index.tsx builds its own private i18next instance with no
// ambient singleton this component could read without one. But a demo visitor's browser is a real
// Dutch or English browser either way (the app itself ships both locales for exactly that reader),
// so the banner still has to speak the language the rest of the page renders in - only the
// machinery for getting there is smaller than standing up a second provider for three sentences.
type BannerLang = 'en' | 'nl'

const BANNER_TEXT: Record<BannerLang, (dateLabel: string) => string> = {
  en: (dateLabel) => `This is a demo. The data is generated, not anyone’s real health ` +
    `history, and it ends on ${dateLabel}. Anything you write here lives only in this browser ` +
    `tab — a reload resets it. Excluding a day or a session does change what you see, the ` +
    `same as a real instance; what does not follow is a recompute, so a figure derived from ` +
    `that data upstream — cardio load, a baseline, an insight — keeps the value it ` +
    `was recorded with.`,
  // Kept to the same three claims as the English above, including the third sentence's
  // distinction (an exclusion does change the page; a recompute does not follow it) - the one the
  // review that required this file called out as easy to soften in translation. "cardiobelasting"
  // and "afgeleid" are not translator's choices made here for the first time: both already appear
  // in nl.json (settings.cardioLoadHelp, setup's timezoneWarning) for exactly these concepts, and
  // "je"/"jouw" throughout nl.json is this app's own register, not "u" - matched here rather than
  // introducing a second one.
  nl: (dateLabel) => `Dit is een demo. De gegevens zijn gegenereerd, niet iemands echte ` +
    `gezondheidsgeschiedenis, en eindigen op ${dateLabel}. Alles wat je hier schrijft, blijft ` +
    `alleen in dit tabblad bestaan — herladen zet het terug. Een dag of sessie uitsluiten ` +
    `verandert wél wat je ziet, net als bij een echte installatie; wat niet volgt, is een ` +
    `herberekening: een cijfer dat van die gegevens is afgeleid — cardiobelasting, een ` +
    `baseline, een inzicht — behoudt de waarde waarmee het is vastgelegd.`,
}

// Intl locale to format DEMO_CLOCK_MS's date in, one per BannerLang - kept alongside BANNER_TEXT
// rather than derived from it, so a date embedded mid-sentence never ends up in a script the rest
// of that sentence isn't written in.
const DATE_LOCALE: Record<BannerLang, string> = { en: 'en-US', nl: 'nl-NL' }

/**
 * The same detection i18n/index.tsx's own initI18n uses for its `lng` default - copied rather
 * than imported because that function lives inside the module this banner deliberately does not
 * pull in (see the comment on BANNER_TEXT above). Only 'en' and 'nl' exist as banner strings
 * (en.json/nl.json are the app's only two locales), so anything else - or no navigator at all,
 * true for a test environment that never sets one - falls back to English exactly the way
 * i18next's own `fallbackLng: 'en'` does for the product.
 */
function detectBannerLang(): BannerLang {
  const tag = typeof navigator === 'undefined' ? 'en' : navigator.language.split('-')[0]
  return tag === 'nl' ? 'nl' : 'en'
}

export function DemoBanner() {
  const lang = detectBannerLang()
  const dateLabel = new Date(DEMO_CLOCK_MS).toLocaleDateString(DATE_LOCALE[lang], {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

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
  createRoot(host).render(<DemoBanner />)
}
