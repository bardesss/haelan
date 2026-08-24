import { useTranslation } from '../i18n/index.js'
import { Icon } from './icons.js'
import { Link } from '../router.js'

const GROUPS = [
  { labelKey: 'sidebar.groups.overview', items: [{ path: '/', nameKey: 'sidebar.items.dashboard' }] },
  {
    labelKey: 'sidebar.groups.tracking',
    items: [
      { path: '/activity', nameKey: 'sidebar.items.activity' },
      { path: '/sleep', nameKey: 'sidebar.items.sleep' },
      { path: '/recovery', nameKey: 'sidebar.items.recovery' },
      { path: '/health', nameKey: 'sidebar.items.health' },
      { path: '/weight', nameKey: 'sidebar.items.weight' },
      { path: '/nutrition', nameKey: 'sidebar.items.nutrition' },
      { path: '/notes', nameKey: 'sidebar.items.notes' },
    ],
  },
] as const

// A hand-written literal, not derived from ROUTES: the two happen to list the same paths, and
// nothing but the shell test comparing this against ROUTES keeps them that way. Exported so that
// test can see what the rail actually links to.
export const RAIL_PATHS: readonly string[] = GROUPS.flatMap((g) => g.items.map((item) => item.path))

export function Sidebar({ active, person }: { active: string, person: string }) {
  const { t } = useTranslation()
  return (
    <nav className="rail" aria-label={t('sidebar.sectionsLabel')}>
      {/* Brand name, not copy: it stays "haelan" in every language. */}
      <div className="brand">haelan</div>
      {GROUPS.map((g) => (
        <div key={g.labelKey}>
          <div className="rail-group">{t(g.labelKey)}</div>
          {g.items.map((item) => (
            <Link key={item.path} to={item.path} className="rail-item"
                  aria-current={active === item.path ? 'page' : undefined}>
              <Icon name={item.path === '/' ? 'dashboard' : item.path.slice(1)} />{t(item.nameKey)}
            </Link>
          ))}
        </div>
      ))}
      {/* Not a Link: the account page it would point to returns in M3e. A dead link here would be
          a ninth way to reach a blank screen. */}
      <div className="rail-foot">
        <span className="avatar" aria-hidden="true">{person.slice(0, 1)}</span>{person}
      </div>
    </nav>
  )
}
