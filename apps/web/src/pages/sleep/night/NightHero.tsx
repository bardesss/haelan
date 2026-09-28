import { useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { Sparkline } from '../../../charts/Sparkline.js'
import { Described } from '../../dashboard/cardShared.js'
import type { PageFigure } from '../../../data/useNightPage.js'
import { formatFigureValue, stripOf, verdictLine } from './figureText.js'

/**
 * The night's lead: time asleep in display type, where it sits against the usual in words, and
 * the strip of this night and the six before it with each night's usual shaded behind it, the
 * same lead the dashboard's night card draws. The verdict is the server's (verdictLine only words
 * it); a thin usual says so rather than claiming one.
 *
 * Nothing at all when the night has no time asleep, so the grid closes up rather than holding a
 * card that says nothing. The strip, its arrays and its formatter are memoised on the figure: a
 * fresh array or function every render would rebuild the chart (chart-lifecycle.test.tsx).
 */
export function NightHero({ asleep }: { asleep: PageFigure }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const strip = useMemo(() => stripOf(asleep), [asleep])
  const standings = useMemo(() => asleep.strip?.map((day) => day.standing), [asleep])
  const formatValue = useMemo(
    () => (value: number | null, absent: string) => (value === null ? absent : formatFigureValue(asleep, value, language, t)),
    [asleep, language, t],
  )
  if (asleep.value === null) return null
  const verdict = verdictLine(asleep, language, t)
  const label = t('sleep.night.hero.label')
  const drawn = strip !== null && strip.values.filter((v) => v !== null).length > 1

  return (
    <Card span={12} label={label}>
      <div className="dash-lead night-hero">
        <div>
          <div className="dash-headline night-hero-value">{formatFigureValue(asleep, asleep.value, language, t)}</div>
          {verdict !== null && (
            <p className={asleep.judged === null ? 'night-hero-verdict' : `night-hero-verdict ${asleep.judged}`}>{verdict}</p>
          )}
        </div>
        {drawn && (
          <div className="dash-lead-strip">
            <Described text={verdict ?? t('sleep.night.hero.strip')} hidden>
              <Sparkline values={strip.values} labels={strip.labels} label={label} unit={label} metric={asleep.metric}
                formatValue={formatValue} bands={strip.bands} pointStandings={standings} height={64} dots tableToggle={false} />
            </Described>
            <p className="dash-caption">{t('sleep.night.hero.strip')}</p>
          </div>
        )}
      </div>
    </Card>
  )
}
