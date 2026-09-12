import { useState } from 'react'
import { useTranslation } from '../i18n/index.js'
import { BrandMark } from './BrandMark.js'
import { Icon } from './icons.js'
import { Link } from '../router.js'
import { readCollapsed, writeCollapsed } from '../ui/railState.js'

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
  {
    labelKey: 'sidebar.groups.settings',
    items: [{ path: '/settings', nameKey: 'sidebar.items.settings' }],
  },
] as const

// A hand-written literal, not derived from ROUTES: the two happen to list the same paths, and
// nothing but the shell test comparing this against ROUTES keeps them that way. Exported so that
// test can see what the rail actually links to. Collapsing the rail hides label text, never a
// path, so this derivation stays untouched by that feature.
export const RAIL_PATHS: readonly string[] = GROUPS.flatMap((g) => g.items.map((item) => item.path))

// Three external links, not app routes: a self hosted tool has no in app feedback channel of its
// own, so these point straight at the project's home on GitHub rather than at a page this app
// serves.
const RESOURCES = [
  { href: 'https://github.com/bardesss/haelan#readme', nameKey: 'sidebar.resources.documentation', icon: 'docs' },
  { href: 'https://github.com/bardesss/haelan/releases', nameKey: 'sidebar.resources.changelog', icon: 'changelog' },
  { href: 'https://github.com/bardesss/haelan/issues', nameKey: 'sidebar.resources.issues', icon: 'issues' },
] as const

export function Sidebar({ active, person, onSignOut, signOutError }: {
  active: string
  person: string
  onSignOut: () => void
  signOutError?: string | null
}) {
  const { t } = useTranslation()
  // Read once at mount rather than on every render: the value only ever changes through the
  // toggle below, which already knows the next value without asking storage for it back.
  const [collapsed, setCollapsed] = useState(() => readCollapsed())

  function toggle() {
    setCollapsed((current) => {
      const next = !current
      writeCollapsed(next)
      return next
    })
  }

  // Text stays in the DOM either way, inside a span the "sr-only" class clips rather than
  // removes, so a screen reader keeps every rail item's name even when the rail is narrow enough
  // that only the icon column is visible. This is what keeps names working under collapse; the
  // nav's own "rail-collapsed" class below, the toggle's chevron direction and its aria-label are
  // the rest of what this component decides about collapsing, each handled where it is used.
  const label = (text: string) => <span className={collapsed ? 'sr-only' : undefined}>{text}</span>

  // The hover name for the icon a collapsed rail leaves behind. "label" above keeps the accessible
  // name in the DOM either way, so a screen reader never lost anything to collapsing; a sighted
  // reader was left with nine unlabelled glyphs and no way to learn what any of them meant, which
  // is what this restores. Undefined when expanded, where the label is already on screen and a
  // tooltip repeating it would only sit in the way of it.
  const hoverName = (text: string) => (collapsed ? text : undefined)

  return (
    <nav className={collapsed ? 'rail rail-collapsed' : 'rail'} aria-label={t('sidebar.sectionsLabel')}>
      <div className="brand-row">
        {/* Brand name, not copy: it stays "Hælan" in every language. The æ is the display
            spelling only — the package, the image, the command and every instruction in the
            catalogue stay "haelan", because those are the ones a reader has to type. */}
        <div className="brand"><BrandMark />{label('Hælan')}</div>
        <button type="button" className="icon-button rail-toggle" onClick={toggle}
          aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}>
          <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} />
        </button>
      </div>
      {GROUPS.map((g) => (
        <div key={g.labelKey}>
          <div className="rail-group">{label(t(g.labelKey))}</div>
          {g.items.map((item) => (
            <Link key={item.path} to={item.path} className="rail-item"
                  title={hoverName(t(item.nameKey))}
                  aria-current={active === item.path ? 'page' : undefined}>
              <Icon name={item.path === '/' ? 'dashboard' : item.path.slice(1)} />{label(t(item.nameKey))}
            </Link>
          ))}
        </div>
      ))}
      <div className="rail-foot">
        <div className="rail-resources">
          {RESOURCES.map((resource) => (
            <a key={resource.href} href={resource.href} className="rail-item" target="_blank"
               rel="noreferrer" title={hoverName(t(resource.nameKey))}>
              <Icon name={resource.icon} />{label(t(resource.nameKey))}
            </a>
          ))}
        </div>
        {/* Not a Link: the account page it would point to has no home yet. M3e closes with this
            milestone without one, and the README's own M5 row puts the person switcher and
            member management there instead. A dead link here would be a tenth way to reach a
            blank screen, now that the rail carries nine (M3c-12 added the ninth, Settings). */}
        <div className="rail-person" title={hoverName(person)}>
          <span className="avatar" aria-hidden="true">{person.slice(0, 1)}</span>{label(person)}
        </div>
        {signOutError && <p className="form-error" role="alert">{signOutError}</p>}
        <button type="button" className="button" onClick={onSignOut} title={hoverName(t('shell.signOut'))}>
          <Icon name="signOut" />{label(t('shell.signOut'))}
        </button>
      </div>
    </nav>
  )
}
