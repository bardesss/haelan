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
 * (hasDayLog), so a caller need not guard it.
 */
export function DayLogBlock({ log }: { log: DayLog }): ReactNode {
  const { t } = useTranslation()
  if (!hasDayLog(log)) return null
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
    </div>
  )
}

/**
 * The card a detail page's side section wears (the night's "Die dag", the workout's "Die dag" and
 * "Daarna"): the card's label, then a narrow column saying which day or night the section is about
 * beside the section's own rows, stacked where the grid collapses. One layout for every such
 * section, so the two detail pages cannot draw the same kind of card two ways.
 */
export function SideCard({ label, caption, children }: { label: string, caption: string, children: ReactNode }) {
  return (
    <Card span={12} label={label}>
      <div className="detail-side">
        <p className="detail-side-caption">{caption}</p>
        <div className="detail-side-body">{children}</div>
      </div>
    </Card>
  )
}
