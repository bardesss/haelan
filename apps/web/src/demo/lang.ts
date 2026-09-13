// The visitor's language, for the handful of demo-only strings that render before I18nProvider
// exists (DemoBanner.tsx) or that must never carry the raw request path an untranslated ApiError
// message would (client.ts's own refusal for a write this build has no meaning for). Not a route
// through i18n/index.tsx: that module builds its own private i18next instance, which nothing here
// can reach without standing up a second provider for a handful of strings. But a demo visitor's
// browser is a real Dutch or English browser either way (the app itself ships both locales for
// exactly that reader), so this still has to speak the language the rest of the page renders in.
//
// Only 'en' and 'nl' exist as demo-only strings (en.json/nl.json are the app's only two locales),
// so anything else falls back to English the same way i18next's own `fallbackLng: 'en'` does for
// the product.
export type DemoLang = 'en' | 'nl'

/** The same detection i18n/index.tsx's own initI18n uses for its `lng` default - copied rather
 *  than imported for the reason this module's own header comment gives. No navigator at all is
 *  true for a test environment that never sets one, and falls back to English the same way an
 *  unrecognised tag does. */
export function detectDemoLang(): DemoLang {
  const tag = typeof navigator === 'undefined' ? 'en' : navigator.language.split('-')[0]
  return tag === 'nl' ? 'nl' : 'en'
}
