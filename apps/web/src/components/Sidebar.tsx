import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '../i18n/index.js'
import { BrandMark } from './BrandMark.js'
import { Icon } from './icons.js'
import { Link } from '../router.js'
import { readCollapsed, writeCollapsed } from '../ui/railState.js'
import { placementFor } from './StatusControl.js'
import type { Placement } from './StatusControl.js'

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
      { path: '/settings', nameKey: 'sidebar.items.settings' },
    ],
  },
] as const

/**
 * The paths the person menu at the foot of the rail leads to, rather than the nav above it.
 *
 * /account lived in the Settings group until this change, and the reader's own name at the foot
 * was a Link to the same page. Two controls, one destination, and no way to tell from either that
 * the other existed: the rail marked /account as the current page while the name beside it,
 * pointing at the same place, deliberately carried no mark so the rail would not claim two current
 * pages. That comment was the design admitting the duplication.
 *
 * Kept separate from RAIL_PATHS rather than folded into it, because the two are different claims
 * and two test files depend on the difference. RAIL_PATHS means "a nav item with an icon, a name
 * that survives collapse, and a hover title" - rail-collapse.test.ts asserts all three per path -
 * and a menu item inside a popover is none of those things. What the shell test actually wants to
 * know is whether every unparameterised route is reachable from the rail at all, so it asks about
 * both lists together.
 */
export const PERSON_MENU_PATHS: readonly string[] = ['/account']

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


export function Sidebar({ active, person, onSignOut, signOutError, collapsible = true, excludedDataTypes, status }: {
  active: string
  person: string
  onSignOut: () => void
  signOutError?: string | null
  // The status icon, or nothing. A node rather than a component this renders itself, for the
  // reason excludedDataTypes gives just below and one more: StatusControl reads queries, and
  // this component is mounted by a handful of tests with no QueryClientProvider above it. Shell
  // builds the element, where a client is guaranteed; every other caller leaves it out and gets
  // the rail it always had.
  status?: ReactNode
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

  // The person menu at the foot, closed on mount.
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const personButton = useRef<HTMLButtonElement>(null)
  const menuPanel = useRef<HTMLDivElement>(null)

  // Whether the menu floats: portalled to document.body and placed with position: fixed, for the
  // reason StatusControl's popover is. The rail is a scroll container (overflow-y: auto, which
  // makes overflow-x compute to auto as well), and an absolutely positioned menu inside it is cut
  // at the rail's own edge. Expanded, the menu happened to be no wider than the foot it opens
  // from, so nothing showed it; collapsed, it opens to the right of the 60px strip, which is
  // entirely outside the clipping box, and layout:check's paintableAt probe measured nothing of it
  // painted at all - the reader pressed their name and got no menu.
  //
  // Keyed on `collapsible` because that prop is exactly "this is the desktop rail and not the
  // phone drawer". The drawer must keep the menu where it is: it is a modal <dialog>, everything
  // outside a modal dialog is inert, and a menu portalled to the body from in there would draw and
  // then refuse every press. The drawer is also as wide as the screen, so nothing clips it.
  const floating = collapsible
  const [placement, setPlacement] = useState<(Placement & { anchorWidth: number | null }) | null>(null)

  // Navigating closes it. The rail is not unmounted by a route change and `Link` accepts no
  // onClick of its own (router.tsx omits it from the props it forwards, deliberately), so without
  // this the menu would still be hanging open over the page its own item just navigated to.
  useEffect(() => { setMenuOpen(false) }, [active])

  // Escape, and a press anywhere outside the menu. Registered only while it is open, so a closed
  // rail costs nothing.
  //
  // The whole wrapper is the inside test, not just the button, and that distinction is load
  // bearing: `pointerdown` fires before `click`, so a handler that closed the menu on a press
  // inside it would unmount the sign-out button before the click it was waiting for could reach
  // it, and pressing Sign out would do nothing at all. The wrapper covers the button (whose own
  // onClick toggles) and both items (which close themselves, or navigate).
  //
  // `pointerdown` rather than `click` for the outside case, so a press that lands on some other
  // control closes this menu AND reaches that control in the same gesture.
  useEffect(() => {
    if (!menuOpen) return
    // preventDefault, because inside the phone drawer this menu is a layer on top of a <dialog>
    // and Escape is that dialog's own way out. RailDrawer leans on the browser's native
    // Escape-to-close (it only listens for the resulting `close` event to sync React), so without
    // this one press dismissed both: the menu AND the whole drawer, measured in Chromium at 375px.
    // Escape should close the innermost thing that is open, and nothing else. preventDefault on the
    // keydown suppresses the dialog's close as that key's default action; stopPropagation as well,
    // so nothing else on the way up treats this press as its own.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setMenuOpen(false)
      // Back to the name, for the floating menu, since the effect below moved focus into it and
      // closing would otherwise drop focus on the body. The drawer's inline menu never took focus.
      if (floating) personButton.current?.focus({ preventScroll: true })
    }
    // The portalled menu counts as inside as well: it is no longer a descendant of the wrapper,
    // and without this a press on Sign out would close the menu under itself exactly as the
    // paragraph above describes.
    const onDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node
        && (menuRef.current?.contains(target) === true || menuPanel.current?.contains(target) === true)) return
      setMenuOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [menuOpen, floating])

  // Where the floating menu goes, from the name's own rectangle: above it on an expanded rail, its
  // left edge on the wrapper's so it lines up with the name the way `left: 0` used to, and past the
  // strip's right edge on a collapsed one, bottom level with the name. placementFor is the status
  // popover's own function, so the two layers in the foot open from the same edges and clamp into
  // the viewport the same way. A layout effect, so the first painted frame is already in place;
  // again on resize, since a fixed box does not follow the rail. Dropped on close, so the next
  // open never paints at a stale position first.
  useLayoutEffect(() => {
    if (!menuOpen || !floating) { setPlacement(null); return }
    const place = () => {
      const button = personButton.current
      const wrapper = menuRef.current
      if (!button || !wrapper) return
      const anchor = wrapper.getBoundingClientRect()
      const box = menuPanel.current?.getBoundingClientRect()
      const rail = button.closest('.rail')?.getBoundingClientRect()
      const nameRect = button.getBoundingClientRect()
      setPlacement({
        ...placementFor({
          trigger: nameRect,
          anchorLeft: anchor.left,
          stripRight: rail?.right ?? nameRect.right,
          collapsed,
          size: { width: box?.width ?? 0, height: box?.height ?? 0 },
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }),
        // The expanded menu was at least as wide as the name row (`min-width: max(100%, 10rem)`
        // against the wrapper). Fixed, 100% would mean the viewport, so the row's width is carried
        // across as a number instead. Collapsed, the strip is narrower than 10rem and has no width
        // worth matching.
        anchorWidth: collapsed ? null : anchor.width,
      })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [menuOpen, floating, collapsed])

  // Focus into the floating menu once it is placed. Portalled to the end of the body, the menu is
  // no longer next to the name in tab order, and a keyboard reader who opened it would otherwise
  // have to tab through the whole page to reach Sign out. Only once placed, because before that
  // the menu is visibility: hidden and a browser will not focus anything inside a hidden box.
  const placed = placement !== null
  useEffect(() => {
    if (!menuOpen || !floating || !placed) return
    menuPanel.current?.querySelector<HTMLElement>('.rail-menu-item')?.focus({ preventScroll: true })
  }, [menuOpen, floating, placed])

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

  // Built once and placed by the caller below: inline for the drawer, portalled for the desktop
  // rail. Hidden until placed when floating, so the one frame before the layout effect measures
  // never shows it at the viewport's corner; layout effects run before paint, so in practice it
  // never shows at all.
  const menu = (
    <div ref={menuPanel} className={floating ? 'rail-menu rail-menu-floating' : 'rail-menu'} role="menu"
      style={!floating ? undefined : placement === null ? { visibility: 'hidden' } : {
        left: `${placement.left}px`,
        bottom: `${placement.bottom}px`,
        minWidth: placement.anchorWidth === null ? undefined : `max(${placement.anchorWidth}px, 10rem)`,
      }}>
      {/* No onClick closing the menu: router.tsx's Link forwards no onClick, and it does
          not need to. The effect above closes on `active` changing, which is the same
          event by a more reliable route - it also fires for a navigation that started
          somewhere else entirely. */}
      <Link to="/account" className="rail-menu-item" role="menuitem">
        <Icon name="account" />{t('sidebar.items.account')}
      </Link>
      <button type="button" className="rail-menu-item" role="menuitem" onClick={onSignOut}>
        <Icon name="signOut" />{t('shell.signOut')}
      </button>
    </div>
  )

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
        {/* The name and the status icon share one row. The sync control used to sit above the
            name as a row of its own, a button and two freshness fragments; the status icon that
            replaced it is a single glyph, and beside the name it costs the foot no height at all.
            Absent entirely when no node is passed, which is every caller but the shell. */}
        <div className="rail-foot-row">
          {/* The reader's own name, and now the only way to their own page.
              It was a Link to /account while the Settings group above also listed Account, which is
              one destination wearing two controls; the old comment here explained that the name
              carried no aria-current because the rail item already did, which is the duplication
              stated as a rule rather than removed. The nav keeps app-wide settings, the name keeps
              what belongs to the person, and signing out moves in here with them: it was a
              permanently visible full-width button for an action taken once a session, sitting
              below the reader's own name in a rail that had already run out of room.

              aria-current moves onto this button, since it is what leads to /account now. A button
              rather than a Link even though one of its two items navigates: what it does on click is
              open a menu. */}
          <div className="rail-person-menu" ref={menuRef}>
            <button ref={personButton} type="button" className="rail-person"
              aria-haspopup="menu" aria-expanded={menuOpen}
              aria-current={active === '/account' ? 'page' : undefined}
              title={hoverName(person)}
              onClick={() => setMenuOpen((open) => !open)}>
              <span className="avatar" aria-hidden="true">{person.slice(0, 1)}</span>{label(person)}
            </button>
            {menuOpen && (floating ? createPortal(menu, document.body) : menu)}
          </div>
          {status}
        </div>
        {/* Outside the menu, so it survives the menu closing. onSignOut is what fails, and the
            menu shuts on the click that called it. */}
        {signOutError && <p className="form-error" role="alert">{signOutError}</p>}
      </div>
    </nav>
  )
}
