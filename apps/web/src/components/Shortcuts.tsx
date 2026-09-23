import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from '../i18n/index.js'
import { navigate } from '../router.js'
import { useShortcutKeys } from '../ui/shortcuts.js'
import { Icon } from './icons.js'
import { railItemsFor, PERSON_MENU_PATHS } from './Sidebar.js'

/**
 * The app-wide keys: "/" opens a box to go to any page by name, "?" lists every shortcut.
 *
 * Mounted once by the shell, beside the rail, so both work on every signed-in page, including the
 * ones without a control row. The period keys are not here: they belong to ControlRow, which holds
 * the controls they drive.
 *
 * Both are <dialog>s, for the reason PeriodSheet gives - focus containment, Escape and an inert page
 * behind are the browser's behaviour, not code of ours - and an open one silences every shortcut,
 * including these two (isForeignKey), so "/" typed into the go-to box is a character, not a reopen.
 */
export function Shortcuts({ excludedDataTypes }: { excludedDataTypes: ReadonlySet<string> }) {
  const [open, setOpen] = useState<'goto' | 'help' | null>(null)

  useShortcutKeys((event) => {
    if (event.key === '/') { event.preventDefault(); setOpen('goto'); return }
    if (event.key === '?') { event.preventDefault(); setOpen('help') }
  })

  const close = () => setOpen(null)
  return (
    <>
      <GoTo open={open === 'goto'} onClose={close} excludedDataTypes={excludedDataTypes} />
      <Help open={open === 'help'} onClose={close} />
    </>
  )
}

// Folded so a reader typing "herstel" or "slaap" finds the page however they type it, including
// without the accents a Dutch or English name might one day carry.
const fold = (text: string): string => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase()

function GoTo({ open, onClose, excludedDataTypes }: {
  open: boolean
  onClose: () => void
  excludedDataTypes: ReadonlySet<string>
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)

  // The rail's own list, with the same pages hidden that the rail hides, plus the account page the
  // person menu leads to: every page a reader could reach by pointing, and no page they could not.
  const pages = [
    ...railItemsFor(excludedDataTypes),
    ...PERSON_MENU_PATHS.map((path) => ({ path, nameKey: 'sidebar.items.account' })),
  ].map((item) => ({ path: item.path, name: t(item.nameKey) }))
  const matches = pages.filter((page) => fold(page.name).includes(fold(query.trim())))
  const chosen = matches[Math.min(selected, matches.length - 1)]

  // A fresh box every time it opens, not the last search.
  useEffect(() => {
    if (open) { setQuery(''); setSelected(0) }
  }, [open])

  const go = (path: string) => { onClose(); navigate(path) }

  return (
    <ShortcutDialog open={open} onClose={onClose} label={t('shortcuts.goTo.title')}>
      <input type="text" className="input goto-input" data-autofocus aria-label={t('shortcuts.goTo.title')}
        placeholder={t('shortcuts.goTo.placeholder')} value={query}
        role="combobox" aria-expanded="true" aria-controls="goto-list"
        aria-activedescendant={chosen === undefined ? undefined : `goto-${chosen.path}`}
        onChange={(e) => { setQuery(e.currentTarget.value); setSelected(0) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((i) => Math.min(i + 1, matches.length - 1)) }
          if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((i) => Math.max(i - 1, 0)) }
          if (e.key === 'Enter' && chosen !== undefined) { e.preventDefault(); go(chosen.path) }
        }} />
      {matches.length === 0
        ? <p className="goto-empty">{t('shortcuts.goTo.none')}</p>
        : (
          <ul id="goto-list" role="listbox" className="goto-list" aria-label={t('shortcuts.goTo.title')}>
            {matches.map((page) => (
              <li key={page.path} id={`goto-${page.path}`} role="option" aria-selected={page === chosen}
                className="goto-option" onPointerDown={(e) => e.preventDefault()} onClick={() => go(page.path)}>
                {page.name}
              </li>
            ))}
          </ul>
        )}
    </ShortcutDialog>
  )
}

function Help({ open, onClose }: { open: boolean, onClose: () => void }) {
  const { t } = useTranslation()
  const rows: [keys: string[], what: string][] = [
    [['←', '→'], t('shortcuts.help.step')],
    [['T'], t('shortcuts.help.today')],
    [['1', '2', '3', '4', '5'], t('shortcuts.help.ranges')],
    [['/'], t('shortcuts.help.goTo')],
    [['?'], t('shortcuts.help.help')],
    [['Esc'], t('shortcuts.help.close')],
  ]
  return (
    <ShortcutDialog open={open} onClose={onClose} label={t('shortcuts.help.title')}>
      <dl className="shortcut-list">
        {rows.map(([keys, what]) => (
          <div key={what} className="shortcut-row">
            <dt>{keys.map((key) => <kbd key={key}>{key}</kbd>)}</dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
      <p className="shortcut-note">{t('shortcuts.help.note')}</p>
    </ShortcutDialog>
  )
}

/**
 * The dialog both shortcuts open: React state is the source of truth and this keeps the element in
 * step with it, the same pattern PeriodSheet uses, including listening for the element's own close
 * so Escape - which closes a dialog without telling React - does not leave the state behind.
 */
function ShortcutDialog({ open, onClose, label, children }: {
  open: boolean
  onClose: () => void
  label: string
  children: ReactNode
}) {
  const { t } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) {
      element.showModal()
      // showModal focuses the first focusable element, which is the close button. The go-to box
      // wants its search field instead; React's own autoFocus cannot do it, since it runs while
      // the dialog is still closed and nothing inside it can take focus yet.
      element.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    }
    if (!open && element.open) element.close()
  }, [open])

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    const onNativeClose = () => onClose()
    element.addEventListener('close', onNativeClose)
    return () => element.removeEventListener('close', onNativeClose)
  }, [onClose])

  return (
    <dialog ref={dialog} className="shortcut-dialog" aria-label={label}
      onClick={(event) => { if (event.target === dialog.current) onClose() }}>
      <div className="shortcut-dialog-body">
        <div className="shortcut-dialog-head">
          <span className="shortcut-dialog-title">{label}</span>
          <button type="button" className="icon-button" aria-label={t('controlRow.close')} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        {/* Rendered only while open, so a closed dialog holds no stale list. */}
        {open && children}
      </div>
    </dialog>
  )
}
