import { useTranslation } from '../i18n/index.js'
import { Card } from '../components/Card.js'
import { ControlRow } from '../components/ControlRow.js'
import { usePageControls } from '../controls/usePageControls.js'
import { NotesList } from './notes/NotesList.js'
import { FlaggedDaysCard } from './notes/FlaggedDaysCard.js'

/**
 * The reading surface for the write path M3c shipped: every note and event a reader has written,
 * over the control row's own range, newest first (NotesList.tsx's own comment says which rows get
 * a remove control and why not every one does). Creation has no form here on purpose: the chart
 * panel is where a note or an event is written, because the panel exists precisely so the day
 * comes from the point clicked rather than from a date typed by hand, and a form on this page
 * would put the typing back.
 *
 * A thin shell around NotesList.tsx, the same split Settings.tsx already uses around
 * OverrideList.tsx: this file owns the title, the range control and the card, NotesList.tsx owns
 * the query states and the table.
 *
 * No `source` dimension: a note or an event is not read off a device the way a metric sample is,
 * so ControlRow is handed no sources to choose between and no export, both of which describe a
 * series this page never requests.
 *
 * FlaggedDaysCard (pages/notes/FlaggedDaysCard.tsx), moved here from the Dashboard in M9b, sits
 * above the list: it reads useAnnotations(range) itself, the same key NotesList below already
 * calls with, so the two share one cache entry and this page pays no extra request for it. No
 * `link` prop: a reader is already on the page that card's Dashboard copy would have sent them to.
 */
export function Notes() {
  const { t } = useTranslation()
  const controls = usePageControls()
  const range = { from: controls.from, to: controls.to }

  return (
    <>
      <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-3)' }}>{t('notes.title')}</h1>
      <ControlRow controls={controls} sources={[]} />
      <div className="grid">
        <FlaggedDaysCard range={range} span={12} />
        <Card span={12} label={t('notes.list.title')}>
          <NotesList range={range} />
        </Card>
      </div>
    </>
  )
}
