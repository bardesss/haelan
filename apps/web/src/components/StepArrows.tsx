import { useTranslation } from '../i18n/index.js'
import { Icon } from './icons.js'
import { useShortcutKeys } from '../ui/shortcuts.js'

/**
 * The ‹ › pair that steps to the nearest neighbour either side of the current day (M9c's DayNav,
 * shared with the detail pages by M10a-2). Where the neighbours are is never computed here - the
 * caller hands over `previous` and `next` from its own payload, and a `null` neighbour disables
 * its button and its key rather than being guessed at.
 *
 * `ignoreKeysInside` is the caller's own escape hatch: a selector for the parts of its tree that
 * have arrow keys of their own (the calendar's grid, the log panel's chips and day arrows), where
 * ← and → must not also step the page behind them. Left out, no key is ignored beyond
 * useShortcutKeys' own rule (a field, a select, a modifier, an open dialog).
 */
export function StepArrows({ previous, next, onPick, labels, ignoreKeysInside }: {
  previous: string | null
  next: string | null
  onPick: (target: string) => void
  labels: { previous: string, next: string }
  ignoreKeysInside?: string
}) {
  const { t } = useTranslation()

  useShortcutKeys((event) => {
    if (event.shiftKey) return
    if (ignoreKeysInside !== undefined && event.target instanceof Element && event.target.closest(ignoreKeysInside) !== null) return
    if (event.key === 'ArrowLeft') {
      if (previous === null) return
      event.preventDefault(); onPick(previous); return
    }
    if (event.key === 'ArrowRight') {
      if (next === null) return
      event.preventDefault(); onPick(next)
    }
  })

  return (
    <>
      <button type="button" className="button day-nav-btn" aria-label={labels.previous}
        title={t('shortcuts.withKey', { label: labels.previous, key: '←' })}
        aria-keyshortcuts="ArrowLeft" disabled={previous === null}
        onClick={() => { if (previous !== null) onPick(previous) }}><Icon name="chevronLeft" /></button>
      <button type="button" className="button day-nav-btn" aria-label={labels.next}
        title={t('shortcuts.withKey', { label: labels.next, key: '→' })}
        aria-keyshortcuts="ArrowRight" disabled={next === null}
        onClick={() => { if (next !== null) onPick(next) }}><Icon name="chevronRight" /></button>
    </>
  )
}
