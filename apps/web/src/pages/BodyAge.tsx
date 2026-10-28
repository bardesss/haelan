import type { ReactNode } from 'react'
import { useTranslation } from '../i18n/index.js'
import { Link } from '../router.js'
import { useSession } from '../auth/session.js'
import { localToday } from '../controls/range.js'
import { formatShortDate } from '../format.js'
import { Card } from '../components/Card.js'
import { PageHeader } from '../components/PageHeader.js'
import { EmptyState } from '../components/EmptyState.js'
import { ErrorState } from '../components/ErrorState.js'
import { Loading } from '../components/Loading.js'
import { useBodyAge } from '../data/useBodyAge.js'
import type { BodyAgeUnavailable } from '../data/useBodyAge.js'
import { BodyAgeHero } from './bodyAge/BodyAgeHero.js'
import { FactorRows } from './bodyAge/FactorRows.js'
import { HowItsWorkedOut } from './bodyAge/HowItsWorkedOut.js'

const DAYS_PER_MONTH = 30

/**
 * The body age page: the body age over the last 30 days against the calendar age, with its trend
 * by month, what moves it, and how it is worked out. One read (/body-age), at the person's last
 * scored day, that the server has already computed, capped and rounded; the page words and draws
 * it (PATTERNS.md's "A fixed window").
 *
 * The window is fixed, so there is no control row: the header names the window, and its last day
 * when that is not today (a sync that lags leaves today unscored). Every state keeps that header;
 * one without a read yet keeps the line's place empty, as every page's does.
 *
 * A body age the server withholds says why in one card: a birth date or sex to add in Settings
 * (linked), or no VO2 max reading recent enough. With no scored day at all there is nothing to
 * say why about, and the page says so with the shared EmptyState.
 */
export function BodyAge() {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const session = useSession()
  const query = useBodyAge()
  const { data } = query
  const title = t('bodyAge.title')

  const today = localToday(session.data?.effectiveTimezone)
  const endDate = data?.current?.endDate ?? null
  const line = data === undefined ? undefined
    : endDate === null || endDate === today ? t('bodyAge.line', { days: data.method.windowDays })
      : t('bodyAge.lineTo', { days: data.method.windowDays, date: formatShortDate(endDate, today, language) })
  const page = (cards: ReactNode) => (
    <div className="detail-page">
      <PageHeader title={title} line={line} />
      <div className="grid">{cards}</div>
    </div>
  )
  const alone = (body: ReactNode) => page(<Card span={12}>{body}</Card>)

  if (query.isError) return alone(<ErrorState onRetry={() => void query.refetch()} error={query.error} />)
  if (data === undefined) return alone(<Loading />)
  const { current } = data
  if (current === null) return alone(<EmptyState title={t('bodyAge.empty.title')} detail={t('bodyAge.empty.detail')} />)
  if (!current.enough) return alone(<Unavailable current={current} vo2LookbackDays={data.method.vo2LookbackDays} />)

  return page(
    <>
      <BodyAgeHero read={data} current={current} />
      <FactorRows current={current} method={data.method} />
      <HowItsWorkedOut method={data.method} />
    </>,
  )
}

/** Why there is no body age, a sentence for each reason: the profile first, since it is the reader's to fix. */
function Unavailable({ current, vo2LookbackDays }: { current: BodyAgeUnavailable, vo2LookbackDays: number }) {
  const { t } = useTranslation()
  const profile = current.missing.includes('birthDate') || current.missing.includes('sex')
  return (
    <>
      {profile && <p className="body-age-reason"><Link to="/settings">{t('bodyAge.unavailable.settings')}</Link></p>}
      {current.missing.includes('vo2Max') && (
        <p className="body-age-reason">{t('bodyAge.unavailable.vo2Max', { months: Math.round(vo2LookbackDays / DAYS_PER_MONTH) })}</p>
      )}
    </>
  )
}
