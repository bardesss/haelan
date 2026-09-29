import type { ReactNode } from 'react'
import { useTranslation } from '../../i18n/index.js'
import { Icon } from '../../components/icons.js'
import { StepArrows } from '../../components/StepArrows.js'
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
 * grid, are left alone. ← → and the arrow buttons themselves are StepArrows.tsx (M10a-2), shared
 * with the detail pages; T stays here since StepArrows knows nothing about "today".
 *
 * `logButton` is quick logging's Log button (LogButton.tsx), leading the row when the person has the
 * switch on; without it the row is exactly the four controls it always was. Keys pressed inside
 * the log panel are left alone like the calendar's: its chips and day arrows are buttons, and ← on
 * one must not step the page's day behind it.
 *
 * `calendarButton` is the calendar's own trigger; until one is handed in, a disabled button holds
 * its place so the row does not change shape when it arrives.
 *
 * `pending`: the day asked for is still loading and `glance` is the previous day's answer, held on
 * screen so the row does not vanish under the pointer. Its `nav` names the neighbours of the wrong
 * day, so both arrows (and their keys) are disabled until the new answer arrives; `finished` then
 * says whether the day being loaded is a past one, which decides the Today button.
 */
export function DayNav({ glance, onPick, logButton, calendarButton, pending = false, finished = glance.finished }: {
  glance: Glance
  onPick: (day: string | null) => void
  logButton?: ReactNode
  calendarButton?: ReactNode
  pending?: boolean
  finished?: boolean
}) {
  const { t } = useTranslation()
  const previous = pending ? null : glance.nav.previous
  const next = pending ? null : glance.nav.next

  useShortcutKeys((event) => {
    if (event.shiftKey) return
    if (event.target instanceof Element && event.target.closest('[data-calendar], [data-log-panel]') !== null) return
    if ((event.key === 't' || event.key === 'T') && finished) onPick(null)
  })

  return (
    <div className="day-nav" role="group" aria-label={t('glance.dayNav.label')}>
      {logButton}
      <StepArrows previous={previous} next={next} onPick={onPick}
        labels={{ previous: t('glance.dayNav.previous'), next: t('glance.dayNav.next') }}
        ignoreKeysInside="[data-calendar], [data-log-panel]" />
      {calendarButton ?? (
        <button type="button" className="button day-nav-btn" aria-label={t('glance.dayNav.calendar')} disabled>
          <Icon name="calendar" />
        </button>
      )}
      {finished && (
        <button type="button" className="button day-nav-today"
          title={t('shortcuts.withKey', { label: t('glance.dayNav.today'), key: 'T' })}
          aria-keyshortcuts="T" onClick={() => onPick(null)}>{t('glance.dayNav.today')}</button>
      )}
    </div>
  )
}
