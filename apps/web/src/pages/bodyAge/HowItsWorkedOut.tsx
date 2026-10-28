import { useTranslation } from '../../i18n/index.js'
import { Card } from '../../components/Card.js'
import type { BodyAgeMethod } from '../../data/useBodyAge.js'

/**
 * "How it's worked out": plain prose, no list, as Recovery's "How the index works" closes its page
 * (a full-row card, its paragraphs inside `.prose-measured`): how a factor becomes years and the
 * window it is read over, the limits and the days a factor needs (sleep regularity's weeks in their
 * place), each factor's cap, and that it is
 * an estimate. The studies behind each factor sit under the prose in one "Sources" disclosure,
 * closed by default (the About fold's `.detail-about`), so a reference list never outweighs the
 * page. Every number is the server's (`method`, the constants the figure is computed by), never
 * typed into a sentence; the citations are the server's own text, in the language they were
 * published in.
 */
export function HowItsWorkedOut({ method }: { method: BodyAgeMethod }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const number = (value: number) => value.toLocaleString(language)
  const name = (key: string) => t(`bodyAge.factors.names.${key}`)
  return (
    <Card span={12} label={t('bodyAge.method.label')}>
      <div className="prose-measured">
        <p>{t('bodyAge.method.how', { days: method.windowDays, slope: number(method.gompertzSlope) })}</p>
        <p>{t('bodyAge.method.limits', {
          cap: number(method.totalCap), min: method.minFactorDays, vo2Days: method.vo2LookbackDays,
          blocks: method.sleep.minBlocks, blockDays: method.sleep.blockDays, nights: method.sleep.minNightsPerBlock,
        })}</p>
        <p>{method.factors.map((factor) => t('bodyAge.method.factor', { factor: name(factor.key), cap: number(factor.cap) })).join(' ')}</p>
        <p>{t('bodyAge.method.estimate')}</p>
        <details className="detail-about body-age-sources">
          <summary>{t('bodyAge.method.sources')}</summary>
          {method.factors.map((factor) => (
            <p key={factor.key} className="body-age-citation">{t('bodyAge.method.citation', { factor: name(factor.key), citation: factor.citation })}</p>
          ))}
        </details>
      </div>
    </Card>
  )
}
