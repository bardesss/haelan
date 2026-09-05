import { useTranslation } from '../i18n/index.js'
import { useSession } from '../auth/session.js'
import { Card } from '../components/Card.js'
import { OverrideList } from './settings/OverrideList.js'
import { SourceNames } from './settings/SourceNames.js'
import { Members } from './settings/Members.js'

// The settings page: no sections existed before this one, so pages/settings/ holds each section's
// own component (OverrideList.tsx is the first) and this file is the shell that gives them a
// title, a route and a place in the rail, the same shape every other top level page already uses.
export function Settings() {
  const { t } = useTranslation()
  const session = useSession()
  return (
    <>
      <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-3)' }}>{t('settings.title')}</h1>
      <div className="grid">
        <Card span={12} label={t('settings.overrides.title')}>
          <OverrideList />
        </Card>
        <Card span={12} label={t('settings.sourceNames.title')}>
          <SourceNames />
        </Card>
        {/* Admin only, and gated here rather than inside Members itself: the five routes it calls
            already answer 'forbidden' to anyone else, but mounting the section at all for a
            member who cannot use a single control on it would be pure noise on their own screen. */}
        {session.data?.isAdmin === true && (
          <Card span={12} label={t('settings.members.title')}>
            <Members />
          </Card>
        )}
      </div>
    </>
  )
}
