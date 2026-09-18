import { useTranslation } from '../i18n/index.js'

export interface RebuildNoticeProps {
  quarantined: boolean
  droppedPages: number
  drops: { dataType: string, reason: string, pages: number }[]
  lastError: string | null
  /** 'self' addresses the person whose data it is, 'admin' describes someone else's. */
  voice: 'self' | 'admin'
  personName?: string
}

/**
 * One component for both places this state is shown: the affected person's own control row and
 * the admin's household list. Shared rather than written twice, because a member told one thing
 * on their dashboard and an operator told another in settings is worse than either message alone.
 *
 * The two states are worded differently on purpose. A quarantine means "your data has stopped and
 * somebody must act". Dropped pages mean "some history is missing and will return on its own".
 * Collapsing them into one severity would either alarm people about a gap that heals itself or
 * bury an outage inside a footnote.
 *
 * Returns null when there is nothing to say, so both call sites render it unconditionally rather
 * than each repeating the same guard.
 */
export function RebuildNotice({
  quarantined, droppedPages, drops, lastError, voice, personName,
}: RebuildNoticeProps) {
  const { t } = useTranslation()

  if (!quarantined && droppedPages === 0) return null

  return (
    <div className="maintenance">
      {/* .maintenance-blocked: the same negative-toned box Maintenance.tsx uses for the one fact
          worth a household's attention before they click reclaim -- a quarantine is exactly that
          register, since it names something already broken and waiting on a person to act. */}
      {quarantined && (
        <p className="maintenance-blocked">
          {voice === 'self'
            ? t('settings.rebuild.quarantinedSelf')
            : t('settings.rebuild.quarantinedOther', { name: personName })}
        </p>
      )}
      {/* .maintenance-download-note: the same muted register Maintenance.tsx uses for a fact that
          is true but not alarming -- dropped pages heal themselves once the cause is fixed, the
          same way that note's own credentials caveat is a condition rather than a failure. */}
      {droppedPages > 0 && (
        <p className="maintenance-download-note">
          {voice === 'self'
            ? t('settings.rebuild.droppedSelf')
            : t('settings.rebuild.droppedOther', { count: droppedPages, name: personName })}
        </p>
      )}
      {drops.length > 0 && (
        <>
          <p className="maintenance-retention">{t('settings.rebuild.dropsHeading')}</p>
          {drops.map((drop) => (
            <p className="maintenance-download-note" key={drop.dataType}>
              {t('settings.rebuild.dropRow', { dataType: drop.dataType, count: drop.pages, reason: drop.reason })}
            </p>
          ))}
        </>
      )}
      {/* Shown verbatim whenever the store recorded one, independent of which state above is
          also true: core's own store (see the commit this branch built on) already decided
          lastError is safe to display, and folding it under only one of the two states above
          would hide it in the other. */}
      {lastError !== null && (
        <>
          <p className="maintenance-retention">{t('settings.rebuild.errorHeading')}</p>
          <p className="maintenance-download-note">{lastError}</p>
        </>
      )}
    </div>
  )
}
