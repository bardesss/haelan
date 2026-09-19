import { useTranslation } from '../i18n/index.js'
import { Card } from '../components/Card.js'
import { ConnectGoogle } from '../auth/ConnectGoogle.js'
import { Profile } from './settings/Profile.js'
import { McpTokens } from './settings/McpTokens.js'
import { OverrideList } from './settings/OverrideList.js'
import { SourceNames } from './settings/SourceNames.js'
import { DataTypes } from './settings/DataTypes.js'

/**
 * The reader's own account: everything on the old Settings page that acted on one person rather
 * than on the instance.
 *
 * The split is along a line that was already drawn in Settings.tsx, where every section was either
 * ungated or wrapped in `isAdmin === true`. Nothing straddled it, which is why this page is a move
 * rather than a rewrite: each section keeps its own component, its own queries and its own
 * translation keys, and only the shell around them is new.
 *
 * The keys stay under `settings.*`. They name the sections themselves ("Profile", "Data types"),
 * not the page that happens to hold them, and renaming them would churn both catalogues and every
 * test that reads one for no gain a reader could see.
 *
 * Reached from the person's own name in the rail foot as well as from the rail item, which is the
 * destination Sidebar.tsx has had a comment about since M3e: the name was always meant to lead
 * here and until now led nowhere.
 */
export function Account() {
  const { t } = useTranslation()
  return (
    <>
      <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-3)' }}>{t('account.title')}</h1>
      <div className="grid">
        {/* A person whose token was revoked lands here with somewhere to reconnect
            from: ConnectGoogle renders nothing once connected (its own doc comment), so this
            is silent for the common case. It lives here and not on the Dashboard, where a
            phone-only member would read it as an instruction seconds after choosing not to. */}
        <ConnectGoogle />
        {/* Half width and side by side, the pairing Settings.tsx established: a form of three
            fields and a list of checkboxes are both narrow enough to earn it, where the three
            sections below are a table and two rows of name-plus-controls that only lose columns
            at half width. */}
        <Card span={6} label={t('settings.profile.title')}>
          <Profile />
        </Card>
        {/* Per person rather than household wide: DataTypes.tsx's own comment on why. This is
            also the control that can take a page out of the rail, which is why this page is one
            the rail must never hide - see PAGE_DATA_TYPES in Sidebar.tsx. */}
        <Card span={6} label={t('settings.dataTypes.title')}>
          <DataTypes />
        </Card>
        {/* The reader's own credential, and there is deliberately no path by which an admin could
            mint one for somebody else. */}
        <Card span={12} label={t('settings.mcp.title')}>
          <McpTokens />
        </Card>
        <Card span={12} label={t('settings.overrides.title')}>
          <OverrideList />
        </Card>
        <Card span={12} label={t('settings.sourceNames.title')}>
          <SourceNames />
        </Card>
      </div>
    </>
  )
}
