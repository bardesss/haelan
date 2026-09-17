import { useState } from 'react'
import { useTranslation } from '../i18n/index.js'
import { BrandMark } from './BrandMark.js'
import { Icon } from './icons.js'
import { Link } from '../router.js'
import { readCollapsed, writeCollapsed } from '../ui/railState.js'

const GROUPS = [
  {
    labelKey: 'sidebar.groups.overview',
    items: [
      { path: '/', nameKey: 'sidebar.items.dashboard' },
      { path: '/records', nameKey: 'sidebar.items.records' },
    ],
  },
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
    items: [
      { path: '/account', nameKey: 'sidebar.items.account' },
      { path: '/settings', nameKey: 'sidebar.items.settings' },
    ],
  },
] as const

// A hand-written literal, not derived from ROUTES: the two happen to list the same paths, and
// nothing but the shell test comparing this against ROUTES keeps them that way. Exported so that
// test can see what the rail actually links to. Collapsing the rail hides label text, never a
// path, so this derivation stays untouched by that feature.
export const RAIL_PATHS: readonly string[] = GROUPS.flatMap((g) => g.items.map((item) => item.path))

/**
 * Which catalogue data types a page has nothing to draw without.
 *
 * Declared here rather than derived from the pages, because a page's metrics are not reachable from
 * the rail and would not answer the question anyway: what matters is which types a person could
 * turn off such that the page has nothing left, and that is an editorial judgement about the page
 * rather than a fact about its imports.
 *
 * Only pages whose whole subject is one category appear. A page absent from this map never hides,
 * which is the right default: Account in particular must always be reachable, since it is where an
 * exclusion is turned back off and a rail that could hide it would be a one-way door.
 *
 * rail-hidden-pages.test.ts holds every id here to the catalogue's own. A typo fails in the worst
 * possible way - an id nothing matches can never be excluded, so the page would simply never hide
 * and nobody would find out why.
 */
export const PAGE_DATA_TYPES: Record<string, readonly string[]> = {
  '/nutrition': ['nutrition-log', 'hydration-log', 'food'],
}

/**
 * The rail's items, with pages the person has switched off left out.
 *
 * Every type a page names has to be excluded before it goes. Turning off one of several leaves the
 * page something to draw, and hiding it then would take away a page that still works.
 *
 * Hidden from the rail, never removed from the router: a bookmark, a deep link and a history entry
 * all keep working, and RAIL_PATHS above stays the complete static list, so the shell test's
 * assertion that the rail and the router name exactly the same paths keeps proving what it was
 * written to prove.
 */
export interface RailItem { path: string, nameKey: string }

// Widened deliberately. GROUPS is `as const` so every path is its own literal type, which is what
// keeps RAIL_PATHS honest - and it makes a flatMap across groups a union of literal shapes that
// nothing downstream can filter without complaint. The names are still checked against GROUPS by
// construction; only the type is loosened here.
const ALL_ITEMS: readonly RailItem[] = GROUPS.flatMap((group) => group.items as readonly RailItem[])

export function railItemsFor(excludedDataTypes: ReadonlySet<string>): readonly RailItem[] {
  return ALL_ITEMS.filter((item) => isVisible(item.path, excludedDataTypes))
}

/** Module level, so a Sidebar rendered without the prop does not build a new Set every render. */
const EMPTY_EXCLUSIONS: ReadonlySet<string> = new Set()

function isVisible(path: string, excluded: ReadonlySet<string>): boolean {
  const required = PAGE_DATA_TYPES[path]
  if (required === undefined || required.length === 0) return true
  return !required.every((id) => excluded.has(id))
}


export function Sidebar({ active, person, onSignOut, signOutError, collapsible = true, excludedDataTypes }: {
  active: string
  person: string
  onSignOut: () => void
  signOutError?: string | null
  // False inside the drawer, where the rail is already as wide as the drawer and the icon strip
  // has nothing to save. The stored preference is still read and still never written here, so a
  // reader who crosses back above the breakpoint finds the rail as they left it.
  collapsible?: boolean
  // The types this person turned off, so a page they have nothing left to draw on leaves the rail.
  // A prop rather than a query of its own: this component is rendered by the shell, inside the
  // drawer and by several tests, and a hook here would put a request behind every one of them.
  // Undefined means "nothing excluded", which is what a caller that has not resolved the set yet
  // should show - a rail that hid pages while the answer was still loading would flicker.
  excludedDataTypes?: ReadonlySet<string>
}) {
  const { t } = useTranslation()
  const excluded = excludedDataTypes ?? EMPTY_EXCLUSIONS
  // Read once at mount rather than on every render: the value only ever changes through the
  // toggle below, which already knows the next value without asking storage for it back.
  const [stored, setStored] = useState(() => readCollapsed())
  const collapsed = collapsible && stored

  function toggle() {
    setStored((current) => {
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
        {collapsible && (
          <button type="button" className="icon-button rail-toggle" onClick={toggle}
            aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}>
            <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} />
          </button>
        )}
      </div>
      {GROUPS.map((g) => ({
        labelKey: g.labelKey,
        items: (g.items as readonly RailItem[]).filter((item) => isVisible(item.path, excluded)),
      }))
        // A group whose every page is hidden takes its heading with it, rather than leaving a
        // label over nothing.
        .filter((g) => g.items.length > 0)
        .map((g) => (
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
        {/* A Link at last: this was a plain div for as long as the account page it wanted to
            point at did not exist, and the comment here said so since M3e. It leads where a
            reader expects their own name to lead - their profile, their data types, their tokens
            - and the rail item above says the same thing in words for anyone who would not think
            to click a name.

            No aria-current of its own. The rail item is what marks /account as the page you are
            on, and a second mark for the same destination would leave the rail claiming two
            current pages. */}
        <Link to="/account" className="rail-person" title={hoverName(person)}>
          <span className="avatar" aria-hidden="true">{person.slice(0, 1)}</span>{label(person)}
        </Link>
        {signOutError && <p className="form-error" role="alert">{signOutError}</p>}
        <button type="button" className="button" onClick={onSignOut} title={hoverName(t('shell.signOut'))}>
          <Icon name="signOut" />{label(t('shell.signOut'))}
        </button>
      </div>
    </nav>
  )
}
