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
        <button ref={opener} type="button" className="icon-button" data-testid="rail-open"
          aria-expanded={open} aria-label={t('sidebar.openMenu')} onClick={() => setOpen(true)}>
          <Icon name="menu" />
        </button>
        <div className="brand"><BrandMark />Hælan</div>
      </div>
      <dialog ref={dialog} className="rail-dialog" aria-label={t('sidebar.sectionsLabel')}>
        <Sidebar active={active} person={person} onSignOut={onSignOut}
          signOutError={signOutError} collapsible={false} />
      </dialog>
    </>
  )
}
