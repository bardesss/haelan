import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useSession } from '../../auth/session.js'
import { useTranslation } from '../../i18n/index.js'
import { formatLocalDate } from '../../format.js'
import { EmptyState } from '../../components/EmptyState.js'
import { ErrorState } from '../../components/ErrorState.js'
import { Loading } from '../../components/Loading.js'
import { sourceActivityKey, useClearSourceName, useRenameSource, useSourcesWithActivity } from '../../data/useSourceNames.js'
import type { NamedSourceWithActivity } from '../../data/useSourceNames.js'

/**
 * Mirrors MAX_ALIAS_LENGTH in packages/core/src/store/sourceAliases.ts. A local constant rather
 * than an import of it: apps/web only ever imports @haelan/core's browser safe subpaths (./metrics,
 * ./target-key), never its root export, because the root pulls better-sqlite3 and drizzle into the
 * browser bundle, and a subpath carrying nothing but this one number is not worth a new public
 * entry point. The field's maxLength below is a convenience only -- the server refuses a longer
 * alias regardless of what this constant says.
 */
const MAX_ALIAS_LENGTH = 64

/**
 * Where a reader turns `12e34bba19af18604590e870380d9c6e` into "My watch".
 *
 * The provider's own name and the id are both shown under the field rather than hidden behind the
 * name: the id is what deep links carry, so somebody debugging a link has to be able to read it
 * off this screen.
 */
export function SourceNames() {
  const { t } = useTranslation()
  const session = useSession()
  const queryClient = useQueryClient()
  const { sources, isPending, isError, error } = useSourcesWithActivity()

  if (isPending) return <Loading />
  if (isError) {
    // useSourceNames() answers isPending/isError but not a refetch to hand ErrorState, the one
    // thing every other card's retry button calls (OverrideList.tsx's own query.refetch(), for
    // one). Going through the query client at the same key useRenameSource and useClearSourceName
    // invalidate on success -- sourceNamesKey -- reaches the identical query without this
    // component keeping a second copy of the fetch those two already own.
    return (
      <ErrorState onRetry={() => {
        const personId = session.data?.personId
        if (personId !== undefined) void queryClient.refetchQueries({ queryKey: sourceActivityKey(personId), exact: true })
      }} error={error} />
    )
  }
  if (sources.length === 0) {
    return <EmptyState title={t('settings.sourceNames.empty.title')} detail={t('settings.sourceNames.empty.detail')} />
  }

  // Partitioned rather than filtered: a source that has stopped is still listed, because a
  // household may want to rename or prioritise it. Only its position changes.
  const live = sources.filter((source) => source.reportingNow)
  const dormant = sources.filter((source) => !source.reportingNow)

  return (
    <>
      <ul className="source-name-list">
        {live.map((source) => <SourceNameRow key={source.id} source={source} />)}
      </ul>
      {dormant.length > 0 && (
        <>
          <h3 className="source-names-dormant-heading">{t('settings.sourceNames.dormantHeading')}</h3>
          <ul className="source-name-list source-names-dormant">
            {dormant.map((source) => <SourceNameRow key={source.id} source={source} />)}
          </ul>
        </>
      )}
    </>
  )
}

function SourceNameRow({ source }: { source: NamedSourceWithActivity }) {
  const { t, i18n } = useTranslation()
  const rename = useRenameSource()
  const clear = useClearSourceName()
  // The field is uncontrolled between edits: `draft` starts from what the server says and is only
  // pushed back on blur or Enter, so a slow round trip never fights the reader's typing.
  const [draft, setDraft] = useState(source.alias ?? '')

  const commit = () => {
    const next = draft.trim()
    if (next === (source.alias ?? '')) return
    if (next === '') clear.mutate({ sourceId: source.id })
    else rename.mutate({ sourceId: source.id, alias: next })
  }

  const failed = rename.isError || clear.isError
  const fallbackLabel = source.displayName === '' ? source.id : source.displayName

  return (
    <li className="source-name-row">
      <label>
        <span className="sr-only">{t('settings.sourceNames.nameLabel', { source: source.name })}</span>
        <input
          type="text"
          className="input"
          value={draft}
          maxLength={MAX_ALIAS_LENGTH}
          placeholder={fallbackLabel}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        />
      </label>
      <span className="source-name-kind">{t(`settings.sourceNames.kind.${source.kind}`)}</span>
      {/* How much this source has actually produced, on every row rather than only the stale ones.
          The card's rule for the stale line - a source reporting normally needs no line, since its
          last reading is yesterday and saying so is noise - holds only while the NAME distinguishes
          the row. On a real household it does not: six of seventeen sources here are
          `com.android.healthconnect.phone.<hash>`, identical but for the hash, all of kind app, all
          reporting. Recency cannot separate them, because it is yesterday for all six. The volume
          can: one is the phone that has recorded for a year and the others logged a handful of days.
          Zero prints nothing - the stale line below already says it has never reported, and a
          "0 days" beside it would state the same fact twice. */}
      {source.reportingDates > 0 && (
        <span className="source-name-volume">
          {t('settings.sourceNames.volume', { count: source.reportingDates })}
        </span>
      )}
      {/* The provider's own name and the id, behind the facts a reader can act on rather than in
          front of them. Kept in full and kept selectable: deep links carry the id, so somebody
          debugging one has to read it off this screen, and a tooltip would make it readable
          without making it copyable - which is the whole reason they are here. */}
      <span className="source-name-detail">{`${fallbackLabel} - ${source.id}`}</span>
      {/* Only said about a source the card is making a claim about. A source reporting normally
          needs no line: its last reading is yesterday and saying so is noise on every row. */}
      {!source.reportingNow && (
        <span className="source-name-stale">
          {/* `stale` is a verdict and `unjudged` is the absence of one, and the difference is the
              whole reason the rule has a history gate: a source with too little history to have
              a cadence must not be called stale, because nothing supports the claim. Grouping
              them together under one line read the same for a dead watch and a two-day app. */}
          {source.lastReportedDate === null
            ? t('settings.sourceNames.neverReported')
            : t(source.status === 'stale'
              ? 'settings.sourceNames.stopped'
              : 'settings.sourceNames.unjudged', {
              // Parsed as UTC, not as a local string: `new Date('2026-01-20')` is already UTC
              // midnight, but the T00:00:00Z is explicit so a reader does not have to know that.
              // The shared helper, which pins timeZone: 'UTC'. Without it a reader west of
              // Greenwich is told a source last reported the day before it did.
              date: formatLocalDate(source.lastReportedDate, i18n.language),
            })}
        </span>
      )}
      {failed && (
        <span className="field-error">
          {/* clear is a DELETE: it only 404s or succeeds, never 400s, so a config error can only
              ever come from rename -- the duplicate name case the server states in its own words. */}
          {rename.error?.kind === 'config' ? rename.error.message : t('settings.sourceNames.saveFailed')}
        </span>
      )}
    </li>
  )
}
