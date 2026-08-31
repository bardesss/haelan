import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { parseDayMetricTarget, parseSampleTarget, parseSessionTarget } from '@haelan/core/target-key'
import type { Translate } from '../../format.js'
import { useTranslation } from '../../i18n/index.js'
import { useSession } from '../../auth/session.js'
import { apiGet } from '../../api/client.js'
import { queryKeys } from '../../api/queryKeys.js'
import { overridesPath, useRemoveOverride } from '../../data/useAnnotations.js'
import type { StoredOverride } from '../../data/useAnnotations.js'
import { ErrorState } from '../../components/ErrorState.js'
import { Loading } from '../../components/Loading.js'
import { EmptyState } from '../../components/EmptyState.js'

interface OverridesResponse { items: StoredOverride[] }

function fetchOverrides(personId: string): Promise<OverridesResponse> {
  return apiGet<OverridesResponse>(overridesPath(personId))
}

/**
 * Every override this person has ever written, across all three scopes. GET /overrides carries no
 * range at all (overridesPath's own comment on useAnnotations.ts says why: this list wants every
 * correction regardless, not a window of them), so this reads it directly with the same query key
 * useAnnotations' own `overrides` query uses, rather than going through useAnnotations itself,
 * which would bundle the identical request with a notes and an events read scoped to a range this
 * page has no chart to draw and no use for. Sharing the key (queryKeys.resource(personId,
 * 'overrides')) is what matters: useWriteOverride and useRemoveOverride both invalidate on exactly
 * that key regardless of which hook first populated it, the same device useSyncStatus.ts's own
 * dedicated single-resource query uses.
 */
function useOverridesList(): UseQueryResult<OverridesResponse> {
  const session = useSession()
  const personId = session.data?.personId
  return useQuery({
    queryKey: queryKeys.resource(personId ?? '', 'overrides'),
    enabled: personId !== undefined,
    queryFn: () => fetchOverrides(personId!),
  })
}

/** What a row shows in its target and date cells, resolved together because both come off the
 * same parse of the same target key. */
interface TargetInfo {
  target: string
  date: string | null
}

/**
 * The chart click panel only ever writes a day_metric target, so parseDayMetricTarget is the only
 * decoder anything in this app has needed before now. This is the one place a sample or a session
 * scoped row is read back at all, since both are written by the sync layer rather than by a
 * reader, so the branch on `item.scope` below is not optional: a day_metric target key parses
 * into a local date and a metric, a sample target key parses into a source, a metric and an
 * instant, and a session target key parses into nothing but a session id, and none of the three
 * shapes can be read with another scope's decoder. Deciding by `item.scope` first, a real column
 * on the row rather than a guess from the key's own shape, is what keeps a parse failure from
 * ever deciding whether the row renders at all: whichever branch runs, a throw here is caught
 * locally and turned into an honest "could not be read" cell, not a blank row and not the raw
 * JSON the key is actually stored as.
 */
function targetInfo(t: Translate, language: string, item: StoredOverride): TargetInfo {
  try {
    if (item.scope === 'day_metric') {
      const { localDate, metric } = parseDayMetricTarget(item.targetKey)
      return { target: metric, date: localDate }
    }
    if (item.scope === 'sample') {
      const { source, metric, utcMs } = parseSampleTarget(item.targetKey)
      return {
        target: t('settings.overrides.target.sample', { metric, source }),
        date: new Date(utcMs).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' }),
      }
    }
    const sessionId = parseSessionTarget(item.targetKey)
    // Unlike the other two scopes, a session target carries no timestamp of any kind
    // (packages/core/src/derive/targetKey.ts's sessionTarget encodes only the session id), so
    // there is no date to recover here even when the key parses cleanly. dateText below says
    // that plainly rather than leaving the cell blank, which would read as a fetch that silently
    // failed rather than a scope that never carried a date to begin with.
    return { target: t('settings.overrides.target.session', { sessionId }), date: null }
  } catch {
    return { target: t('settings.overrides.target.unreadable'), date: null }
  }
}

function dateText(t: Translate, info: TargetInfo): string {
  return info.date ?? t('settings.overrides.date.unavailable')
}

/** "Exclude" or "Correct", the same two words the panel that writes them uses, plus the value for
 * a correction: a bare "Correct" tells a reader something was changed and not what to. */
function actionText(t: Translate, item: StoredOverride): string {
  if (item.action === 'correct' && item.correctedValue !== null) {
    return t('settings.overrides.correctedTo', { value: item.correctedValue })
  }
  return t(`annotate.actions.${item.action}`)
}

/**
 * Every override for the person, with its scope, target, action, reason and date, and a way to
 * remove one. The only surface in this app where a sample or session scoped override is visible
 * at all: both are written by the sync layer rather than by a chart click, so nothing else ever
 * reads them back.
 *
 * Removal answers `applied` the same two ways a write does (useRemoveOverride drains the same
 * queue a write does before responding), but this list cannot answer it the way the panel does.
 * AnnotatePanel stays open on its own row and says the numbers have not caught up; there is no
 * row left here to stay open on, because the override really is gone from the store the moment
 * the write commits, whether or not the drain has caught up with it, and useRemoveOverride
 * unconditionally invalidates the overrides resource on success, so the row leaves this list on
 * the next render regardless of `applied`. So the disappearance itself is not the thing to guard;
 * what must not happen silently is the reader concluding removal did nothing because some number
 * elsewhere has not moved, and removing the same row again looking for a second effect that would
 * find nothing there. `removedNotApplied` below renders the same message the panel does, in the
 * same `applied: false` case, as a page level note once the row itself is gone rather than as a
 * form that stays open.
 */
export function OverrideList() {
  const { t, i18n } = useTranslation()
  const query = useOverridesList()
  const removeOverride = useRemoveOverride()
  const items = query.data?.items ?? []
  const removedNotApplied = removeOverride.data?.applied === false

  return (
    <>
      {query.isError ? <ErrorState onRetry={() => void query.refetch()} />
        : query.isPending ? <Loading />
        : items.length === 0 ? (
          <EmptyState title={t('settings.overrides.empty.title')} detail={t('settings.overrides.empty.detail')} />
        ) : (
          <table className="override-table">
            <caption className="sr-only">{t('settings.overrides.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('settings.overrides.columns.scope')}</th>
                <th scope="col">{t('settings.overrides.columns.target')}</th>
                <th scope="col">{t('settings.overrides.columns.action')}</th>
                <th scope="col">{t('settings.overrides.columns.reason')}</th>
                <th scope="col">{t('settings.overrides.columns.date')}</th>
                <th scope="col"><span className="sr-only">{t('settings.overrides.columns.remove')}</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const info = targetInfo(t, i18n.language, item)
                const date = dateText(t, info)
                const scope = t(`settings.overrides.scope.${item.scope}`)
                const removing = removeOverride.isPending && removeOverride.variables?.overrideId === item.id
                return (
                  <tr key={item.id}>
                    <td>{scope}</td>
                    <td>{info.target}</td>
                    <td>{actionText(t, item)}</td>
                    <td>{item.reason}</td>
                    <td>{date}</td>
                    <td>
                      <button type="button" className="button"
                        // id, not just target and date: target+date reconstructs enough of a
                        // parsed target key to be unique per row (the store's own unique index is
                        // on (person, scope, target_key)), but two rows that both failed to parse
                        // (targetInfo's catch branch) collapse to the identical "Target could not
                        // be read" / "Not recorded for this scope" pair regardless of how
                        // different their real, unreadable keys are. The id is always unique and
                        // always at hand, so it closes that gap for every row rather than only the
                        // ones whose target happens to parse.
                        aria-label={t('settings.overrides.removeAria', { target: info.target, date, id: item.id })}
                        disabled={removing}
                        onClick={() => removeOverride.mutate({ overrideId: item.id })}>
                        {removing ? t('settings.overrides.removing') : t('settings.overrides.remove')}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      {removeOverride.isError && <p className="form-error" role="alert">{t('settings.overrides.removeFailed')}</p>}
      {removedNotApplied && (
        <p className="annotate-note" role="status">{t('settings.overrides.removedNotYetApplied')}</p>
      )}
    </>
  )
}
