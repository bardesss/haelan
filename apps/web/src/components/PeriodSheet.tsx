import { useEffect, useRef } from 'react'
import { useTranslation } from '../i18n/index.js'
import { Icon } from './icons.js'
import { RANGE_KEYS } from '../controls/range.js'
import type { PageControlsState } from '../controls/usePageControls.js'
import { ALL_SOURCES } from '../controls/source.js'
import { useSourceNames } from '../data/useSourceNames.js'

/**
 * Everything the control row used to spread across five rows on a phone, inside one sheet.
 *
 * A <dialog> for the same three reasons RailDrawer gives: focus containment, Escape, and making
 * the page behind inert are browser behaviour here and thirty lines of our own everywhere else.
 * The close button and the backdrop handler are what that element does not give a finger, which is
 * the same pair the drawer carries, written the same way.
 *
 * What is deliberately NOT in here is the stepper. Moving a month back is the most frequent thing
 * a reader does to this control, and putting it behind a sheet would make the common case cost two
 * taps to save the rare one. The arrows stay on the row outside; this holds what you touch once in
 * a while - which range, which day, which source, and the export.
 */
export function PeriodSheet({ controls, sources, exportPath, open, onClose, label, yearCompare = false }: {
  controls: PageControlsState
  sources: string[]
  exportPath?: string
  open: boolean
  onClose: () => void
  /** The period as the row outside spells it, repeated here so the sheet says what it is about. */
  label: string
  /** Offer the year-over-year toggle (ControlRow's own prop of this name). */
  yearCompare?: boolean
}) {
  const { t } = useTranslation()
  const { nameOf } = useSourceNames()
  const dialog = useRef<HTMLDialogElement>(null)
  const hasSourcePicker = sources.length > 0
  const options = [ALL_SOURCES, ...sources]

  // showModal() and close() are imperative, so React state is the source of truth and this effect
  // is what makes the element agree with it. Guarded both ways: calling showModal on an already
  // open dialog throws.
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
  }, [open])

  // Escape closes the dialog itself without telling React. Listening for the element's own close
  // event is what keeps the state from drifting out of sync with the DOM, and it covers every
  // other way a dialog can close too.
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    const onNativeClose = () => onClose()
    element.addEventListener('close', onNativeClose)
    return () => element.removeEventListener('close', onNativeClose)
  }, [onClose])

  return (
    <dialog ref={dialog} className="period-sheet" aria-label={t('controlRow.periodSheetTitle')}
      onClick={(event) => { if (event.target === dialog.current) onClose() }}>
      <div className="period-sheet-body">
        <div className="period-sheet-head">
          <span className="period-sheet-title">{label}</span>
          <button type="button" className="icon-button" data-testid="period-sheet-close"
            aria-label={t('controlRow.close')} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>

        {/* A full width row each, rather than the five-across .segmented the row outside uses.
            Five columns on a 375px phone is 59px apiece, which is what clipped "3 maanden" to an
            ellipsis and put a 44px-tall target inside a box too narrow to aim at. A sheet has the
            width to just list them, so it does.

            Its own classes rather than .segmented and .segment, because this dialog is rendered
            inside .controls and would otherwise inherit `.controls .segmented`'s repeat(5, 1fr)
            and have to fight it back on specificity.

            Choosing a range closes the sheet. It is the answer a reader opened this for, and
            leaving the sheet up over the page they just changed makes them dismiss it twice. */}
        <div className="period-options" role="group" aria-label={t('controlRow.timeRangeLabel')}>
          {RANGE_KEYS.map((key) => (
            <button key={key} type="button" className="period-option" aria-pressed={key === controls.tab}
              onClick={() => { controls.setTab(key); onClose() }}>
              {t(`controlRow.ranges.${key}`)}
            </button>
          ))}
        </div>

        {/* Changing the day does not close it: a reader picking a date often wants to see the
            range buttons above in the same breath, and the sheet is where both of them are. */}
        <label className="period-sheet-field">
          <span>{t('controlRow.pickDate')}</span>
          <input type="date" className="date-picker" value={controls.anchor}
            onChange={(e) => controls.setAnchor(e.currentTarget.value)} />
        </label>

        {/* Left out rather than rendered as a picker of one choice, the same ruling ControlRow
            makes: Notes passes no sources at all, and a select holding only "All sources" chooses
            between nothing. */}
        {hasSourcePicker && (
          <label className="period-sheet-field">
            <span>{t('controlRow.sources')}</span>
            <select value={controls.source} onChange={(e) => controls.setSource(e.currentTarget.value)}>
              {options.map((source) => (
                <option key={source} value={source}>
                  {source === ALL_SOURCES ? t('controlRow.sourceAll') : nameOf(source)}
                </option>
              ))}
            </select>
          </label>
        )}

        {/* A pressed/unpressed row like the ranges above, and it leaves the sheet open for the
            same reason changing the day does: it is one of several things a reader sets here. */}
        {yearCompare && controls.tab !== 'day' && controls.setCompareYear !== undefined && (
          <button type="button" className="period-option" aria-pressed={controls.compareYear === true}
            onClick={() => controls.setCompareYear!(controls.compareYear !== true)}>
            {t('controlRow.compareYear')}
          </button>
        )}

        {exportPath !== undefined && (
          <a className="button period-sheet-export" href={exportPath}>
            <Icon name="download" />{t('controlRow.downloadTotals')}
          </a>
        )}
      </div>
    </dialog>
  )
}
