import { useId, useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { BasisContext } from '../../../components/basis.js'
import { verdictTone } from '../../../components/FigureRow.js'
import { Sparkline } from '../../../charts/Sparkline.js'
import { useOpensDay } from '../../dashboard/cardShared.js'
import type { PageFigure } from '../../../data/useNightPage.js'
import { formatFigureValue, stripOf, verdictLine } from './figureText.js'

/**
 * The night's lead: time asleep in display type, where it sits against the usual in words, and
 * the strip of this night and the six before it with each night's usual shaded behind it, the
 * same lead the dashboard's night card draws. The verdict is the server's (verdictLine only words
 * it); a thin usual says so rather than claiming one. Like the dashboard's strip, the band's edges
 * are labelled and a dot opens its own night (useOpensDay, the dashboard's words for it).
 *
 * Nothing at all when the night has no time asleep, so the grid closes up rather than holding a
 * card that says nothing. The strip, its arrays and its formatter are memoised on the figure: a
 * fresh array or function every render would rebuild the chart (chart-lifecycle.test.tsx).
 */
export function NightHero({ asleep, localDate, onOpenNight }: {
  asleep: PageFigure
  /** The night this page shows, which its own dot does not open: it is already open. */
  localDate: string
  /** Opens a strip dot's night on its own page, the way the dashboard's night strip opens its day. */
  onOpenNight?: (localDate: string) => void
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const verdictId = useId()
  const captionId = useId()
  const strip = useMemo(() => stripOf(asleep), [asleep])
  const opens = useOpensDay(localDate, onOpenNight)
  const formatValue = useMemo(
    () => (value: number | null, absent: string) => (value === null ? absent : formatFigureValue(asleep, value, language, t)),
    [asleep, language, t],
  )
  // The usual's two edges labelled beside the band, as the dashboard's night strip labels them, so
  // the shading is never left for the reader to decode from colour alone. Memoised for the reason
  // NightCard gives: a fresh object every render would rebuild the chart.
  const band = asleep.baseline !== null && !asleep.baseline.thin ? asleep.baseline : undefined
  const bandLabels = useMemo(() => band === undefined ? undefined : {
    low: formatFigureValue(asleep, band.low, language, t), high: formatFigureValue(asleep, band.high, language, t),
  }, [asleep, band, language, t])
  if (asleep.value === null) return null
  const verdict = verdictLine(asleep, language, t)
  const tone = verdictTone(asleep.judged, asleep.standing)
  const label = t('sleep.night.hero.label')

  return (
    <Card span={12} label={label}>
      <div className="dash-lead detail-hero">
        <div>
          <div className="dash-headline detail-hero-value">{formatFigureValue(asleep, asleep.value, language, t)}</div>
          {verdict !== null && (
            <p id={verdictId} className={tone === null ? 'detail-verdict' : `detail-verdict ${tone}`}>{verdict}</p>
          )}
        </div>
        {strip !== null && (
          <div className="dash-lead-strip">
            {/* Described by the verdict printed beside it (or, with none, its caption), by id, so a
                screen reader hears it once rather than again from a hidden copy. */}
            <BasisContext.Provider value={verdict !== null ? verdictId : captionId}>
              <Sparkline values={strip.values} labels={strip.labels} label={label} unit={label} metric={asleep.metric}
                formatValue={formatValue} baseline={band} bands={strip.bands} bandLabels={bandLabels}
                pointStandings={strip.pointStandings} height={64} dots tableToggle={false} {...opens} />
            </BasisContext.Provider>
            <p id={captionId} className="dash-caption">{t('sleep.night.hero.strip')}</p>
          </div>
        )}
      </div>
    </Card>
  )
}
