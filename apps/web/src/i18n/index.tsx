import i18next from 'i18next'
import type { i18n } from 'i18next'
import { initReactI18next, I18nextProvider, useTranslation } from 'react-i18next'
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import en from './en.json' with { type: 'json' }
import nl from './nl.json' with { type: 'json' }

export { useTranslation }

// The only file that names i18next. Everything else imports useTranslation from here, so the
// library is one import away from being replaced rather than spread across every component.
export function initI18n(lng?: string): i18n {
  const instance = i18next.createInstance()
  void instance.use(initReactI18next).init({
    resources: { en: { translation: en }, nl: { translation: nl } },
    // The reader's browser choice, falling back to English rather than to the raw key.
    lng: lng ?? (typeof navigator === 'undefined' ? 'en' : navigator.language.split('-')[0]),
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  })
  return instance
}

export function I18nProvider({ children, lng }: { children: ReactNode; lng?: string }) {
  // Memoised on lng: this is mounted once at the app root, and rebuilding a whole i18next
  // instance (and the react-i18next binding wrapped around it) on every render of the tree above
  // it had no purpose once nothing here depended on that render actually happening.
  const instance = useMemo(() => initI18n(lng), [lng])
  return <I18nextProvider i18n={instance}>{children}</I18nextProvider>
}
