import { useTranslation } from '../../i18n/index.js'
import { Card } from '../../components/Card.js'
import type { BodyAgeMethod } from '../../data/useBodyAge.js'

/**
 * "How it's worked out": plain prose, no list, as Recovery's "How the index works" closes its page
 * (a full-row card, its paragraphs inside `.prose-measured`): how a factor becomes years and the
 * window it is read over, the limits and the days a factor needs, a paragraph per factor with its
 * cap and the server's citation, and last that it is an estimate. Every number is the server's
 * (`method`, the constants the figure is computed by), never typed into a sentence. The citations
 * are the server's own text, study names and figures, in the language they were published in.
 */
export function HowItsWorkedOut({ method }: { method: BodyAgeMethod }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const number = (value: number) => value.toLocaleString(language)
  return (
    <Card span={12} label={t('bodyAge.method.label')}>
      <div className="prose-measured">
        <p>{t('bodyAge.method.how', { days: method.windowDays, slope: number(method.gompertzSlope) })}</p>
        <p>{t('bodyAge.method.limits', { cap: number(method.totalCap), min: method.minFactorDays, vo2Days: method.vo2LookbackDays })}</p>
        {method.factors.map((factor) => (
          // The factor and its cap in the prose's own type, the citation under it smaller and
          // quieter: a reference to look up, not a sentence to read.
          <p key={factor.key}>
            {t('bodyAge.method.factor', { factor: t(`bodyAge.factors.names.${factor.key}`), cap: number(factor.cap) })}
            <span className="body-age-citation">{factor.citation}</span>
          </p>
        ))}
        <p>{t('bodyAge.method.estimate')}</p>
      </div>
    </Card>
  )
}
