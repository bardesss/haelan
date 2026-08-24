import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './Shell.js'
import { QueryProvider } from './api/queryClient.js'
import { I18nProvider } from './i18n/index.js'
import './app.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <QueryProvider>
        <App />
      </QueryProvider>
    </I18nProvider>
  </StrictMode>,
)
