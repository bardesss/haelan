import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useSession } from '../../auth/session.js'
import { useTranslation } from '../../i18n/index.js'
import { EmptyState } from '../../components/EmptyState.js'
import { ErrorState } from '../../components/ErrorState.js'
import { Loading } from '../../components/Loading.js'
import { sourceNamesKey, useClearSourceName, useRenameSource, useSourceNames } from '../../data/useSourceNames.js'
import type { NamedSource } from '../../data/useSourceNames.js'

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
  const { sources, isPending, isError, error } = useSourceNames()

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
        if (personId !== undefined) void queryClient.refetchQueries({ queryKey: sourceNamesKey(personId), exact: true })
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

function SourceNameRow({ source }: { source: NamedSource }) {
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
      <span className="source-name-detail">{`${fallbackLabel} - ${source.id}`}</span>
      <span className="source-name-kind">{t(`settings.sourceNames.kind.${source.kind}`)}</span>
      {/* Only said about a source the card is making a claim about. A source reporting normally
          needs no line: its last reading is yesterday and saying so is noise on every row. */}
      {!source.reportingNow && (
        <span className="source-name-stale">
          {source.lastReportedDate === null
            ? t('settings.sourceNames.neverReported')
            : t('settings.sourceNames.lastReported', {
              // Parsed as UTC, not as a local string: `new Date('2026-01-20')` is already UTC
              // midnight, but the T00:00:00Z is explicit so a reader does not have to know that.
              date: new Date(`${source.lastReportedDate}T00:00:00Z`)
                .toLocaleString(i18n.language, { dateStyle: 'medium' }),
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
