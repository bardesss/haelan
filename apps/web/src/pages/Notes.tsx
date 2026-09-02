import { useTranslation } from '../i18n/index.js'
import { Card } from '../components/Card.js'
import { ControlRow } from '../components/ControlRow.js'
import { usePageControls } from '../controls/usePageControls.js'
import { useSyncStatus } from '../data/useSyncStatus.js'
import { NotesList } from './notes/NotesList.js'

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
 */
export function Notes() {
  const { t } = useTranslation()
  const controls = usePageControls()
  const range = { from: controls.from, to: controls.to }

  const syncStatus = useSyncStatus()
  const syncedMinutesAgo = syncStatus.data?.lastFinishedAtMs != null
    ? Math.max(0, Math.round((Date.now() - syncStatus.data.lastFinishedAtMs) / 60_000))
    : null

  return (
    <>
      <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-3)' }}>{t('notes.title')}</h1>
      <ControlRow controls={controls} sources={[]} syncedMinutesAgo={syncedMinutesAgo} />
      <div className="grid">
        <Card span={12} label={t('notes.list.title')}>
          <NotesList range={range} />
        </Card>
      </div>
    </>
  )
}
