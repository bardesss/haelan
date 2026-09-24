import { useState } from 'react'
import { useTranslation } from '../i18n/index.js'
import { Icon } from './icons.js'
import { PeriodSheet } from './PeriodSheet.js'
import { RANGE_KEYS } from '../controls/range.js'
import type { PageControlsState } from '../controls/usePageControls.js'
import { useSourceNames } from '../data/useSourceNames.js'
import { useSyncStatus } from '../data/useSyncStatus.js'
import { ALL_SOURCES } from '../controls/source.js'
import { periodLabel } from '../controls/periodLabel.js'
import { useIsPhone } from '../ui/breakpoint.js'
import { RebuildNotice } from './RebuildNotice.js'
import { useShortcutKeys } from '../ui/shortcuts.js'

// A frozen module constant, not a fresh `[]` default: a new array identity on every render is
// what chart-lifecycle.test.tsx exists to catch elsewhere in this app, and a default parameter
// expression runs on every call.
const EMPTY_SOURCES: string[] = Object.freeze([]) as never[]

// Built per language and cached by Intl itself. "Watch and scale" in English, "Watch en scale" in
// Dutch, and neither spelling hardcoded here.
const listFormat = (language: string): Intl.ListFormat =>
  new Intl.ListFormat(language, { style: 'long', type: 'conjunction' })

/**
 * Which range, which period, which source - and on a phone, one row instead of five.
 *
 * Until M10 this row also carried the sync button and its freshness line. Both have moved to the
 * shell (now the status panel, StatusControl.tsx), where they render once rather than once per
 * page: a sync is an instance-wide action and had no business being the loudest control on a
 * page about September. Losing it is most of why the phone layout below is possible at all.
 *
 * Two layouts, chosen by the same breakpoint the rail uses. Above it, one line: the five ranges,
 * the stepper with its date picker, the source picker, and the export. Below it, one line of a
 * different shape - the stepper arrows either side of a chip naming the period, with everything
 * else behind the chip in a sheet. The arrows stay out here on purpose; stepping is the frequent
 * action and must not cost a sheet.
 */
export function ControlRow({
  controls, sources, exportPath, stoppedSources = EMPTY_SOURCES, trendNote = false, yearCompare = false,
}: {
  controls: PageControlsState
  sources: string[]
  /**
   * Sources that fed this range and then went quiet inside it, from
   * `sourcesStoppedInRange` (data/pageShell.ts). Defaulted, so a page that has not adopted it
   * renders exactly as it did before rather than being forced to pass an empty array.
   *
   * Passed in rather than computed here: this component has no series, and the question is about
   * the points a page has already loaded.
   */
  stoppedSources?: string[]
  // Optional rather than required: a page with no range of its own has no export to offer, and
  // the link is left out rather than rendered with no href.
  exportPath?: string
  /**
   * For a page whose tiles carry change badges: says once, under the controls, what every badge's
   * percentage compares. Each badge still carries its own exact numbers as its tooltip and spoken
   * text (StatTile); this is the sentence a reader needs before pointing at any of them.
   */
  trendNote?: boolean
  /**
   * For a page whose tiles can draw the same days a year earlier: offers the toggle for it, here
   * and in the phone's period sheet. Left off on a page with nothing to compare (Notes).
   */
  yearCompare?: boolean
}) {
  const { t, i18n } = useTranslation()
  const { nameOf } = useSourceNames()
  const isPhone = useIsPhone()
  const [sheetOpen, setSheetOpen] = useState(false)
  // Still read here after M10 moved the sync button out, and deliberately so. The button was an
  // instance-wide action that had no business on a page; the notice below is the opposite - it
  // says the numbers on this page are not being updated, which is a fact about exactly what the
  // reader is looking at, and it belongs directly above them.
  const status = useSyncStatus()

  // The period keys belong to this row, because this row holds the controls they drive: a page
  // with no control row (Records, Settings) has no period to step, and gets none of these keys.
  // Numbers rather than letters for the ranges, because the ranges are named in two languages and
  // "j" for jaar and "y" for year cannot both be right. The shell owns "/" and "?" (Shortcuts.tsx).
  useShortcutKeys((event) => {
    if (event.shiftKey) return
    if (event.key === 'ArrowLeft') { event.preventDefault(); controls.step(-1); return }
    if (event.key === 'ArrowRight') { event.preventDefault(); controls.step(1); return }
    if (event.key === 't' || event.key === 'T') { controls.setAnchor(controls.today); return }
    const index = Number(event.key) - 1
    const range = Number.isInteger(index) ? RANGE_KEYS[index] : undefined
    if (range !== undefined) controls.setTab(range)
  })

  // Shown exactly as handed over. controls.source has already been resolved against this same
  // list in the state layer (controls/source.ts), so the label here and the source the page is
  // querying under cannot drift apart: they are one value.
  const options = [ALL_SOURCES, ...sources]
  // Notes hands this component `sources={[]}` on purpose (Notes.tsx's own doc comment: a note or
  // an event is not read off a device the way a metric sample is), which used to still draw a
  // select holding one option, "All sources", choosing between nothing. A picker of one choice is
  // not a picker.
  const hasSourcePicker = sources.length > 0

  const period = periodLabel(controls.tab, controls.from, controls.to, i18n.language)
  const exactBounds = `${controls.from} ${t('common.to')} ${controls.to}`

  /* Guarded on status.data rather than left to RebuildNotice's own null return: the query
     answers nothing for a moment after mount, and status.data.rebuild does not exist yet in that
     instant -- rendering the row's other controls immediately while this waits one tick behind
     them. SyncStatus.rebuild is a required field: a real response always carries it (runner.ts's
     own status()), so once status.data exists, trusting its shape rather than re-checking the
     field itself is what keeps a future malformed or legacy answer from reading as "nothing to
     report" instead of failing where it can be seen.

     rebuildInFlight is passed by name rather than arriving in the spread: it is not in
     status.data.rebuild, because it is one fact about the server process and that object carries
     facts about this person's own data. The spread would silently stop supplying it if it ever
     moved, which the required prop on RebuildNotice is what catches.

     Held in a variable so both layouts below render the same one. It leads each of them, because
     "your data has stopped updating" outranks every control underneath it. */
  const rebuildNotice = status.data !== undefined && (
    <RebuildNotice
      voice="self" rebuildInFlight={status.data.rebuildInFlight} {...status.data.rebuild}
    />
  )

  const stopped = stoppedSources.length > 0 && (
    /* The answer to what a thinning chart actually raises: did the person do less, or did the
       device stop. Said once for the page rather than on each card, because every card on a
       page reads the same range and would otherwise repeat one sentence up to twelve times.
       Named, because "a source stopped" sends the reader to Settings to find out which.

       The names never begin the sentence, which is why the copy reads "Stopped reporting
       during this range: X" rather than "X stopped reporting". A source is called whatever
       its device or its owner called it - "com.lyfta", "My watch" - so a sentence-initial
       name either renders lowercase mid-sentence or gets capitalised into something nobody
       typed. */
    <p className="control-row-stopped">
      {t('controlRow.sourceStopped', {
        sources: listFormat(i18n.language).format(stoppedSources.map(nameOf)),
        count: stoppedSources.length,
      })}
    </p>
  )

  const note = trendNote && <p className="control-row-note">{t('controlRow.trendNote')}</p>

  // Only on a page whose tiles draw the comparison, and never on Day, where a tile has no line.
  const canCompare = yearCompare && controls.tab !== 'day' && controls.setCompareYear !== undefined
  const compareToggle = canCompare && (
    <button type="button" className="button compare-toggle" aria-pressed={controls.compareYear === true}
      onClick={() => controls.setCompareYear!(controls.compareYear !== true)}>
      {t('controlRow.compareYear')}
    </button>
  )

  if (isPhone) {
    return (
      <div className="controls controls-phone">
        {rebuildNotice}
        <div className="stepper">
          <button type="button" className="icon-button" aria-label={t('controlRow.previousPeriod')}
            onClick={() => controls.step(-1)}><Icon name="chevronLeft" /></button>
          {/* The chip is the whole of the rest of this row. Its accessible name says the range as
              well as the period, because "september 2026" alone does not tell a reader whether
              they are looking at a month or at the three ending in it. */}
          <button type="button" className="period-chip" data-testid="period-chip"
            aria-haspopup="dialog" title={exactBounds}
            aria-label={`${t(`controlRow.ranges.${controls.tab}`)} · ${period}`}
            onClick={() => setSheetOpen(true)}>
            <span className="period-chip-range">{t(`controlRow.ranges.${controls.tab}`)}</span>
            <span className="period-chip-period">{period}</span>
            <Icon name="chevronDown" />
          </button>
          <button type="button" className="icon-button" aria-label={t('controlRow.nextPeriod')}
            onClick={() => controls.step(1)}><Icon name="chevronRight" /></button>
        </div>
        <PeriodSheet controls={controls} sources={sources} exportPath={exportPath} label={period} yearCompare={yearCompare}
          open={sheetOpen} onClose={() => setSheetOpen(false)} />
        {note}
        {stopped}
      </div>
    )
  }

  return (
    <div className="controls">
      {rebuildNotice}
      <div className="segmented" role="group" aria-label={t('controlRow.timeRangeLabel')}>
        {/* Each control names its key in its tooltip, and to assistive tech through
            aria-keyshortcuts: the "?" overview is the complete list, but a key is learned fastest
            from the thing it presses. */}
        {RANGE_KEYS.map((key, index) => (
          <button key={key} type="button" className="segment" aria-pressed={key === controls.tab}
            title={t('shortcuts.withKey', { label: t(`controlRow.ranges.${key}`), key: index + 1 })}
            aria-keyshortcuts={String(index + 1)}
            onClick={() => controls.setTab(key)}>
            {t(`controlRow.ranges.${key}`)}
          </button>
        ))}
      </div>

      <div className="stepper">
        <button type="button" className="icon-button" aria-label={t('controlRow.previousPeriod')}
          title={t('shortcuts.withKey', { label: t('controlRow.previousPeriod'), key: '←' })}
          aria-keyshortcuts="ArrowLeft"
          onClick={() => controls.step(-1)}><Icon name="chevronLeft" /></button>
        {/* The exact bounds move to the title rather than being dropped: the label now names the
            period ("september 2026") and a reader who wants to know which days that covers can
            hover for them. The pretty name is what a screen reader gets, which is an improvement
            on two ISO dates rather than a loss, so nothing here is sr-only. */}
        <span className="stepper-label" title={exactBounds}>{period}</span>
        <button type="button" className="icon-button" aria-label={t('controlRow.nextPeriod')}
          title={t('shortcuts.withKey', { label: t('controlRow.nextPeriod'), key: '→' })}
          aria-keyshortcuts="ArrowRight"
          onClick={() => controls.step(1)}><Icon name="chevronRight" /></button>
        {/* An icon rather than a second field. The picker's own text ("15-08-2026") sat beside the
            label and read as a second period, when on every tab but Day it was only whichever day
            inside the period the anchor happened to be. The input stays - it is what keyboard and
            assistive tech reach, and what opens the browser's own calendar - laid transparent over
            the icon, and showPicker() is called because a click on a date input's text opens
            nothing in Chromium. */}
        <span className="date-pick" title={t('controlRow.pickDate')}>
          <Icon name="calendar" />
          <input type="date" className="date-pick-input" aria-label={t('controlRow.pickDate')}
            value={controls.anchor} onChange={(e) => controls.setAnchor(e.currentTarget.value)}
            onClick={(e) => { try { e.currentTarget.showPicker?.() } catch { /* not allowed here; focus stands */ } }} />
        </span>
      </div>

      {compareToggle}

      <div className="controls-end">
        {hasSourcePicker && (
          <label className="button">
            <Icon name="sources" />
            <span className="sr-only">{t('controlRow.sources')}</span>
            <select value={controls.source} onChange={(e) => controls.setSource(e.currentTarget.value)}>
              {options.map((source) => (
                <option key={source} value={source}>
                  {source === ALL_SOURCES ? t('controlRow.sourceAll') : nameOf(source)}
                </option>
              ))}
            </select>
          </label>
        )}
        {/* A link, not a fetch: the export route answers a file and the browser already knows how
            to save one, so there is no blob and no object URL for this component to manage. Left
            out entirely without a path, rather than rendered as an anchor that goes nowhere.

            Icon only since M10, with the words on the title and in the accessible name. It is the
            rarest control in this row and it carried the longest label in it - "Download daily
            totals", "Dagtotalen downloaden" - which is what made the row wrap on a laptop. */}
        {exportPath !== undefined && (
          <a className="button icon-button" href={exportPath}
            title={t('controlRow.downloadTotals')} aria-label={t('controlRow.downloadTotals')}>
            <Icon name="download" />
          </a>
        )}
      </div>
      {note}
      {stopped}
    </div>
  )
}
