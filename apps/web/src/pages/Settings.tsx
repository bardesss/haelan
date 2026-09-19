import type { ReactNode } from 'react'
import { useTranslation } from '../i18n/index.js'
import { useSession } from '../auth/session.js'
import { Card } from '../components/Card.js'
import { Link, useRoute, readQuery, withQuery } from '../router.js'
import { Members } from './settings/Members.js'
import { InstanceUrl } from './settings/InstanceUrl.js'
import { Maintenance } from './settings/Maintenance.js'
import { RebuildHealth } from './settings/RebuildHealth.js'
import { About } from './settings/About.js'

/**
 * What this page is left holding once the account sections move to Account.tsx: the instance
 * everybody on it shares, and the project it runs.
 *
 * Three tabs rather than a column of cards. The sections were never one subject - who may sign in,
 * where the instance answers and what it keeps on disk, and the project's own links - and scrolling
 * past two of them to reach the third was the complaint.
 *
 * Tabs in the query string, not in the path. `?tab=` is the shape this app already uses for a
 * dimension of a page the URL should carry (ControlRow's range, source and anchor all live there),
 * and it costs no new route: a bookmark, the back button and a reload all work, while the route
 * table, the rail, and every guard that compares the two stay exactly as they are.
 *
 * Links rather than a tablist. These change the URL, which makes them navigation, and a nav of
 * links needs no roving tabindex, no arrow-key handler and no `aria-selected` of its own - the
 * `aria-current="page"` the rail already uses says which one you are on.
 */
interface Tab { id: string, element: ReactNode }

export function Settings() {
  const { t } = useTranslation()
  const session = useSession()
  const route = useRoute()
  const isAdmin = session.data?.isAdmin === true

  // Not gated: these are the project's own links and the version this instance runs, not anything
  // about the instance an admin arbitrates. They used to be three permanent rows in the rail foot
  // - and three unlabelled glyphs in the collapsed rail - for destinations that all leave the app.
  const info: Tab = {
    id: 'info',
    element: (
      <Card span={12} measured label={t('settings.about.title')}>
        <About />
      </Card>
    ),
  }

  // Admin only, and gated by this list rather than inside each section: every route they call
  // already answers 'forbidden' to anyone else, but mounting a section a member cannot use a
  // single control on would be pure noise on their own screen.
  const tabs: readonly Tab[] = isAdmin
    ? [
      {
        id: 'members',
        element: (
          <Card span={12} measured label={t('settings.members.title')}>
            <Members />
          </Card>
        ),
      },
      {
        // The two sections about this instance as a running thing, together: where it answers,
        // and what it keeps. They were a half width pair on the old page for the same reason they
        // share a tab here - neither is a subject on its own.
        id: 'instance',
        element: (
          <>
            <Card span={6} label={t('settings.instanceUrl.title')}>
              <InstanceUrl />
            </Card>
            <Card span={6} label={t('settings.maintenance.title')}>
              <Maintenance />
            </Card>
            {/* Full width rather than sharing a half with either card above: this can list every
                affected person on the household, not one figure or one form, and a household with
                several quarantined members would otherwise scroll a half-width column past two
                unrelated cards to read the rest of its own list. */}
            <Card span={12} measured label={t('settings.rebuild.title')}>
              <RebuildHealth />
            </Card>
          </>
        ),
      },
      info,
    ]
    : [info]

  // An unknown tab, and a member who typed one they cannot see, both land on the first tab they
  // can have: resolving against the visible list rather than against every id there is means the
  // query string can never mount a section its reader is gated out of.
  const wanted = readQuery(route.split('?')[1] ?? '').get('tab')
  const active = tabs.find((tab) => tab.id === wanted) ?? tabs[0]!

  return (
    <>
      <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-3)' }}>{t('settings.title')}</h1>
      {/* A strip of one is not a strip: a member has a single tab, and a chooser over it would be
          a control with nothing to choose. The same ruling the source picker and the session type
          filter already make. */}
      {tabs.length > 1 && (
        <nav className="segmented settings-tabs" aria-label={t('settings.tabs.label')}>
          {tabs.map((tab) => (
            <Link key={tab.id} to={withQuery('/settings', { tab: tab.id })} className="segment"
                  aria-current={tab.id === active.id ? 'page' : undefined}>
              {t(`settings.tabs.${tab.id}`)}
            </Link>
          ))}
        </nav>
      )}
      <div className="grid">{active.element}</div>
    </>
  )
}
