// The day block and SideCard as every redesigned page uses them: PATTERNS.md, beside this file.
import type { ReactNode } from 'react'
import { useTranslation } from '../../i18n/index.js'
import { Card } from '../../components/Card.js'
import { kindLabel } from '../../data/eventKinds.js'
import { MoodFace } from '../../components/logPanel/MoodFaces.js'
import type { DayLog } from '../../data/useNightPage.js'

/** Whether a day's quick log has anything to draw: a mood, a chip tapped at least once, or a note. */
export function hasDayLog(log: DayLog): boolean {
  return log.mood !== null || Object.values(log.counts).some((count) => count > 0) || log.note !== null
}

/**
 * A day's quick log as the detail pages draw it (the mockups' "Die dag"): the mood face with its
 * word, a chip for each kind tapped that day (with its count once there is more than one), and the
 * day's note. One component for the night page's day before and the workout page's day of, so the
 * two cannot drift into two spellings of the same log. Nothing at all when the log is empty
 * (hasDayLog) and there is no `note`, so a caller need not guard it.
 *
 * `note` is a note written on something else that day, quoted the way the day's own note is: the
 * workout page's workout note, which belongs with the day's words rather than in the header.
 */
export function DayLogBlock({ log, note = null }: { log: DayLog, note?: string | null }): ReactNode {
  const { t } = useTranslation()
  const extra = note === null || note.trim() === '' ? null : note.trim()
  if (!hasDayLog(log) && extra === null) return null
  const chips = Object.entries(log.counts).filter(([, count]) => count > 0)
  return (
    <div className="day-log">
      {log.mood !== null && (
        <div className="day-log-mood">
          <MoodFace score={log.mood} />
          <span className="day-log-mood-word">{t(`logPanel.mood.${log.mood}`)}</span>
        </div>
      )}
      {chips.length > 0 && (
        <ul className="day-log-chips">
          {chips.map(([kind, count]) => (
            <li key={kind} className="day-log-chip">
              {count > 1 ? t('sleep.night.day.chipCount', { kind: kindLabel(t, kind), count }) : kindLabel(t, kind)}
            </li>
          ))}
        </ul>
      )}
      {log.note !== null && <p className="day-log-note">{t('sleep.night.day.note', { note: log.note })}</p>}
      {extra !== null && <p className="day-log-note">{t('sleep.night.day.note', { note: extra })}</p>}
    </div>
  )
}

/**
 * The card a detail page's side section wears (the night's "Die dag", the workout's "Die dag",
 * "Daarvoor" and "Daarna"): the card's label, then a narrow column saying which day or night the
 * section is about beside the section's own rows, stacked where the grid collapses. One layout for
 * every such section, so the two detail pages cannot draw the same kind of card two ways.
 *
 * `span={6}` is half a row, for two side cards set beside each other (the workout's before and
 * after); there the caption sits over the rows rather than beside them, as it does below 900px,
 * since a quarter of half a card is too narrow for a sentence. The caller picks the span, so a
 * pair whose other half is missing goes back to the full row (uniform spans per run).
 */
export function SideCard({ label, caption, span = 12, children }: { label: string, caption: string, span?: 6 | 12, children: ReactNode }) {
  return (
    <Card span={span} label={label}>
      <div className={span === 6 ? 'detail-side detail-side-stacked' : 'detail-side'}>
        <p className="detail-side-caption">{caption}</p>
        <div className="detail-side-body">{children}</div>
      </div>
    </Card>
  )
}
