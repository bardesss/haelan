import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { parseDayMetricTarget, parseSampleTarget, parseSessionTarget } from '@haelan/core/target-key'
import type { Translate } from '../../format.js'
import { formatMetricValue, formatNumber } from '../../format.js'
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

// Only reached when a correction's target key fails to parse at all (targetInfo's own catch
// branch below), so METRICS[metric].precision cannot be looked up for it: that row already
// reads "Target could not be read" in its own cell, and this keeps the corrected value beside it
// from also reading as a raw, many-decimal float. Two decimals, not zero: several of the real
// metrics this store can correct (weight, spo2, respiratory_rate) carry a genuine decimal, and
// this function has no way to know from here whether the value it cannot place is one of them.
const UNREADABLE_METRIC_PRECISION = 2

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
 * same parse of the same target key. `unreadable` marks the one case target and date alone cannot
 * keep two rows apart: every parsed shape reconstructs enough of a unique target key on its own
 * (day_metric's metric+date, sample's metric+source+instant, session's own id), but two rows that
 * both fail to parse collapse to the identical "Target could not be read" / "Not recorded for this
 * scope" pair regardless of how different their real, unreadable keys are. */
interface TargetInfo {
  target: string
  date: string | null
  unreadable: boolean
  // The raw metric id, not `target`'s translated display text, so actionText below can look up
  // METRICS[metric].precision for a correction's value. null for the session scope (no metric
  // involved at all) and for a target key that failed to parse (the `unreadable` case): both are
  // real "no metric to consult" states, not a parse this function forgot to attempt.
  metric: string | null
}

/**
 * The chart click panel only ever writes a day_metric target, so parseDayMetricTarget is the only
 * decoder anything in this app has needed before now. This is the one place a sample or a session
 * scoped row is read back at all: `POST /overrides` accepts all three scopes and nothing in this
 * app posts the other two, so a sample or session row reaches this list from a caller of the HTTP
 * API that is not this app. The branch on `item.scope` below is therefore not optional: a
 * day_metric target key parses
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
      return { target: metric, date: localDate, unreadable: false, metric }
    }
    if (item.scope === 'sample') {
      const { source, metric, utcMs } = parseSampleTarget(item.targetKey)
      return {
        target: t('settings.overrides.target.sample', { metric, source }),
        date: new Date(utcMs).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' }),
        unreadable: false,
        metric,
      }
    }
    const sessionId = parseSessionTarget(item.targetKey)
    // Unlike the other two scopes, a session target carries no timestamp of any kind
    // (packages/core/src/derive/targetKey.ts's sessionTarget encodes only the session id), so
    // there is no date to recover here even when the key parses cleanly. dateText below says
    // that plainly rather than leaving the cell blank, which would read as a fetch that silently
    // failed rather than a scope that never carried a date to begin with.
    return { target: t('settings.overrides.target.session', { sessionId }), date: null, unreadable: false, metric: null }
  } catch {
    return { target: t('settings.overrides.target.unreadable'), date: null, unreadable: true, metric: null }
  }
}

function dateText(t: Translate, info: TargetInfo): string {
  return info.date ?? t('settings.overrides.date.unavailable')
}

/** "Exclude" or "Correct", plus the value for a correction: a bare "Correct" tells a reader
 * something was changed and not what to.
 *
 * These two words are this list's own (`settings.overrides.action.*`), not the annotate panel's
 * (`annotate.actions.*`), which is where they used to come from. The panel offers no correct
 * action at all now, since a day_metric correction is refused by OverrideStore.validate and has
 * nothing in the derive path to apply it (AnnotatePanel.tsx's own ACTIONS comment has the full
 * reasoning), so reading a correction's label out of the panel's catalogue would leave the one
 * surface that does render corrections depending on a word the panel has no reason to keep.
 *
 * A correction is a real row and not a leftover, which is why this branch stays where the charts'
 * own was deleted: `POST /overrides` accepts `sample` with `correct` and a value,
 * OverrideStore.validate permits exactly that combination, and `applyToSamples` rewrites the
 * reading at derivation. Nothing in this app writes one and no chart can draw one (a sample target
 * names an instant, not a day), so this list is the only place one is ever seen.
 *
 * `metric`, threaded in from the same parse targetInfo already did (TargetInfo.metric), is what
 * lets this reach METRICS[metric].precision the way formatMetricValue expects. It is null exactly
 * when targetInfo's own parse could not name a metric at all (the session scope, or a target key
 * that failed to parse), and this cell has no metric of its own to fall back on in that case --
 * see UNREADABLE_METRIC_PRECISION below for what it prints instead. */
function actionText(t: Translate, language: string, item: StoredOverride, metric: string | null): string {
  if (item.action === 'correct' && item.correctedValue !== null) {
    const value = metric !== null
      ? formatMetricValue(item.correctedValue, metric, language, '')
      : formatNumber(item.correctedValue, UNREADABLE_METRIC_PRECISION, language, '')
    return t('settings.overrides.correctedTo', { value })
  }
  return t(`settings.overrides.action.${item.action}`)
}

/**
 * Every override for the person, with its scope, target, action, reason and date, and a way to
 * remove one. The only surface in this app where a sample or session scoped override is visible at
 * all: the chart click panel writes day_metric alone, so a row at either of the other two scopes
 * came in over `POST /overrides` from somewhere other than this app, and nothing else here reads
 * one back.
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
                    <td>{actionText(t, i18n.language, item, info.metric)}</td>
                    <td>{item.reason}</td>
                    <td>{date}</td>
                    <td>
                      <button type="button" className="button"
                        // id folded in only for an unreadable target (see TargetInfo's own
                        // comment on why that is the one case target+date cannot disambiguate):
                        // every other row already reads a clean "Remove steps, 2026-08-15" rather
                        // than paying 36 characters of hex on every ordinary row for a collision
                        // only the unreadable case can have.
                        aria-label={info.unreadable
                          ? t('settings.overrides.removeAriaUnreadable', { target: info.target, date, id: item.id })
                          : t('settings.overrides.removeAria', { target: info.target, date })}
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
