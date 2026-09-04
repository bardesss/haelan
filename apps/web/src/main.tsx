import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './Shell.js'
import { QueryProvider } from './api/queryClient.js'
import { I18nProvider } from './i18n/index.js'
import { ErrorBoundary } from './components/ErrorBoundary.js'
import './app.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <QueryProvider>
        {/* The last boundary, under everything else there is. Shell's two cover the rail and the
            page it renders once somebody is signed in and set up; nothing covered SetupApp, the
            sign-in screen, Shell's own error and pending branches, or Shell's body, which is to
            say nothing covered the screens a fresh upgrade meets first. A version skewed field
            there still emptied the root, which is the whole defect this exists to close.

            Inside QueryProvider rather than around it, so pressing retry puts the app back
            without discarding the query cache with it, and inside I18nProvider so ErrorState has
            translations to render. */}
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </QueryProvider>
    </I18nProvider>
  </StrictMode>,
)
