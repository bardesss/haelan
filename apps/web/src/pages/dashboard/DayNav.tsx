import type { ReactNode } from 'react'
import { useTranslation } from '../../i18n/index.js'
import { Icon } from '../../components/icons.js'
import { useShortcutKeys } from '../../ui/shortcuts.js'
import type { Glance } from '../../data/useGlance.js'

/**
 * The dashboard's day navigator (M9c): ‹ and › to the nearest days with data either side, the
 * calendar, and on a past day a "Today" button, at the right of the header.
 *
 * Where the arrows go is the payload's own `nav`, never a date computed here: the server knows
 * which days hold data and this component does not, so a gap in the archive is stepped over rather
 * than landed on. An arrow with no neighbour is disabled rather than hidden, so the row keeps its
 * shape from one day to the next. On yesterday `nav.next` is null while today has no data yet;
 * "Today" is then the way back, which is why it shows on every past day whatever `nav` says.
 *
 * The keys are ControlRow's (← → step, T returns to today), with the same titles and
 * aria-keyshortcuts, bound here because the dashboard has no control row. Keys typed in a field
 * (useShortcutKeys' own rule) or inside the calendar, which has arrow keys of its own for its
 * grid, are left alone.
 *
 * `calendarButton` is the calendar's own trigger; until one is handed in, a disabled button holds
 * its place so the row does not change shape when it arrives.
 */
export function DayNav({ glance, onPick, calendarButton }: {
  glance: Glance
  onPick: (day: string | null) => void
  calendarButton?: ReactNode
}) {
  const { t } = useTranslation()
  const { previous, next } = glance.nav

  useShortcutKeys((event) => {
    if (event.shiftKey) return
    if (event.target instanceof Element && event.target.closest('[data-calendar]') !== null) return
    if (event.key === 'ArrowLeft') {
      if (previous === null) return
      event.preventDefault(); onPick(previous); return
    }
    if (event.key === 'ArrowRight') {
      if (next === null) return
      event.preventDefault(); onPick(next); return
    }
    if ((event.key === 't' || event.key === 'T') && glance.finished) onPick(null)
  })

  return (
    <div className="day-nav" role="group" aria-label={t('glance.dayNav.label')}>
      <button type="button" className="button day-nav-btn" aria-label={t('glance.dayNav.previous')}
        title={t('shortcuts.withKey', { label: t('glance.dayNav.previous'), key: '←' })}
        aria-keyshortcuts="ArrowLeft" disabled={previous === null}
        onClick={() => { if (previous !== null) onPick(previous) }}><Icon name="chevronLeft" /></button>
      <button type="button" className="button day-nav-btn" aria-label={t('glance.dayNav.next')}
        title={t('shortcuts.withKey', { label: t('glance.dayNav.next'), key: '→' })}
        aria-keyshortcuts="ArrowRight" disabled={next === null}
        onClick={() => { if (next !== null) onPick(next) }}><Icon name="chevronRight" /></button>
      {calendarButton ?? (
        <button type="button" className="button day-nav-btn" aria-label={t('glance.dayNav.calendar')} disabled>
          <Icon name="calendar" />
        </button>
      )}
      {glance.finished && (
        <button type="button" className="button day-nav-today"
          title={t('shortcuts.withKey', { label: t('glance.dayNav.today'), key: 'T' })}
          aria-keyshortcuts="T" onClick={() => onPick(null)}>{t('glance.dayNav.today')}</button>
      )}
    </div>
  )
}
