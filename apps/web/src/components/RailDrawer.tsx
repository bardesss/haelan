import { useEffect, useRef, useState } from 'react'
import { Sidebar } from './Sidebar.js'
import { BrandMark } from './BrandMark.js'
import { Icon } from './icons.js'
import { useTranslation } from '../i18n/index.js'
import { useRoute } from '../router.js'

/**
 * The rail, below the breakpoint: a slim top bar with a hamburger, and the same <nav> inside a
 * native modal dialog.
 *
 * <dialog> rather than a hand-rolled panel because focus containment, Escape to close and making
 * the page behind inert are browser behaviour there, and thirty lines of our own everywhere else.
 * The parts of a drawer that are subtly wrong in one browser are exactly those three.
 *
 * What <dialog> does not give is a way out for a finger, and that is what the close button and the
 * backdrop handler below are. Everything the element itself offers - Escape, and the close request
 * a CloseWatcher raises from an Android back gesture - assumes hardware an iPhone does not have.
 */
export function RailDrawer({ active, person, onSignOut, signOutError }: {
  active: string
  person: string
  onSignOut: () => void
  signOutError?: string | null
}) {
  const { t } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const route = useRoute()

  // showModal() and close() are imperative, so React state is the source of truth and this effect
  // is what makes the element agree with it. Guarded both ways: calling showModal on an already
  // open dialog throws.
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
  }, [open])

  // Escape closes the dialog itself, without telling React. Listening to the element's own close
  // event is what keeps the state from drifting out of sync with the DOM, and it covers every
  // other way a dialog can close too.
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    const onClose = () => setOpen(false)
    element.addEventListener('close', onClose)
    return () => element.removeEventListener('close', onClose)
  }, [])

  // Closing on navigation rather than on a click handler inside Sidebar: every link in there
  // routes, and watching the route means the drawer has no opinion about how navigation happened.
  useEffect(() => { setOpen(false) }, [route])

  // Focus goes back where it came from. The browser does not do this for a dialog that is closed
  // by Escape, and a reader who opened the menu with a keyboard would otherwise be returned to the
  // top of the document.
  //
  // Guarded against the very first run: a useEffect fires once after the initial render no matter
  // what its dependency array holds, and `open` starts false, so with no guard this looked exactly
  // like the true-to-false transition after a close and refocused the hamburger on every mount -
  // a phone page load, or crossing the breakpoint downward, since Shell swaps Sidebar for
  // RailDrawer by remounting. mounted starts false and flips (and stays) true after that first
  // effect run, so the mount itself is skipped and only a real open-to-closed transition refocuses.
  const mounted = useRef(false)
  useEffect(() => {
    if (mounted.current && !open) opener.current?.focus({ preventScroll: true })
    mounted.current = true
  }, [open])

  return (
    <>
      <div className="top-bar">
        {/* aria-haspopup, not aria-expanded. aria-expanded describes a region this button shows
            and hides in place, next to itself, and a screen reader announcing "collapsed" invites
            the reader to look there for it. What this opens is a modal dialog that takes the whole
            page over, which is what haspopup="dialog" says. */}
        <button ref={opener} type="button" className="icon-button" data-testid="rail-open"
          aria-haspopup="dialog" aria-label={t('sidebar.openMenu')} onClick={() => setOpen(true)}>
          <Icon name="menu" />
        </button>
        <div className="brand"><BrandMark />Hælan</div>
      </div>
      {/*
        The click handler is the backdrop tap. A click whose target is the dialog element itself
        landed outside the dialog's own box - everything inside it is a descendant, and .rail fills
        the box edge to edge - so this fires for the backdrop and for nothing else.

        Not `closedby="any"`, which asks the browser for the same light dismiss: it is supported in
        the Chromium this repository's own layout check drives (141; `'closedBy' in
        HTMLDialogElement.prototype` answers true there) and in current Safari and Firefox, but it
        arrived in all three during 2025, so an iPhone a year or two behind its last update has a
        drawer with one fewer way out. The handler above costs one line and is the same behaviour
        on every browser that has ever rendered this app, which is what a dismissal control has to
        be. The attribute would add nothing this does not already do.
      */}
      <dialog ref={dialog} className="rail-dialog" aria-label={t('sidebar.sectionsLabel')}
        onClick={(event) => { if (event.target === dialog.current) setOpen(false) }}>
        {/*
          The reason this exists at all: Escape and a route change were the only ways out, and a
          phone has no Escape key. A reader who opened the menu to look and then decided to stay on
          the page they were already on was stuck - tapping the rail item for the current page
          changes no route, so the effect above never fires. A backdrop tap is a real dismissal but
          not a discoverable one; this is the one a finger can find. Sized by the 44px rule through
          .icon-button, which applies below the breakpoint, and this component only ever renders
          there.
        */}
        <button type="button" className="icon-button rail-close" data-testid="rail-close"
          aria-label={t('sidebar.closeMenu')} onClick={() => setOpen(false)}>
          <Icon name="close" />
        </button>
        <Sidebar active={active} person={person} onSignOut={onSignOut}
          signOutError={signOutError} collapsible={false} />
      </dialog>
    </>
  )
}
