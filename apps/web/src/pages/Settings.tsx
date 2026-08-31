import { useTranslation } from '../i18n/index.js'
import { Card } from '../components/Card.js'
import { OverrideList } from './settings/OverrideList.js'

// The settings page: no sections existed before this one, so pages/settings/ holds each section's
// own component (OverrideList.tsx is the first) and this file is the shell that gives them a
// title, a route and a place in the rail, the same shape every other top level page already uses.
export function Settings() {
  const { t } = useTranslation()
  return (
    <>
      <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-3)' }}>{t('settings.title')}</h1>
      <div className="grid">
        <Card span={12} label={t('settings.overrides.title')}>
          <OverrideList />
        </Card>
      </div>
    </>
  )
}
