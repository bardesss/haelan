import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useSession } from '../../auth/session.js'
import { useTranslation } from '../../i18n/index.js'
import { formatLocalDate } from '../../format.js'
import { EmptyState } from '../../components/EmptyState.js'
import { ErrorState } from '../../components/ErrorState.js'
import { Loading } from '../../components/Loading.js'
import { sourceActivityKey, useClearSourceName, useRenameSource, useSourcesWithActivity } from '../../data/useSourceNames.js'
import type { NamedSourceWithActivity } from '../../data/useSourceNames.js'
import { useSetSourcePriority, useSourcePriority } from '../../data/useSourcePriority.js'
import { useSetPanelChoice } from '../../data/useStatusPanel.js'
import { localToday } from '../../controls/range.js'
import { shownByDefault } from '@haelan/core/status-panel'

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
  const priority = useSourcePriority()
  const setPriority = useSetSourcePriority()
  // Read aloud rather than shown: the whole reason reordering is two buttons and not drag is that
  // a screen reader user drives them, and neither the row moving nor a disabled attribute changing
  // says anything to that reader on its own, especially for a move in the middle of a long list
  // where nothing at either end becomes newly enabled or disabled.
  const [announcement, setAnnouncement] = useState('')

  // One row's own up/down pair, captured by a callback ref rather than looked up by id on demand:
  // React calls a callback ref with null on unmount, so a row that leaves the DOM clears itself
  // here without this component having to notice the list changed underneath it.
  const buttonRefs = useRef(new Map<string, { up: HTMLButtonElement | null, down: HTMLButtonElement | null }>())
  const buttonRefFor = (sourceId: string, which: 'up' | 'down') => (el: HTMLButtonElement | null) => {
    const entry = buttonRefs.current.get(sourceId) ?? { up: null, down: null }
    entry[which] = el
    buttonRefs.current.set(sourceId, entry)
  }

  // What to restore once the mutation now in flight settles. Read by the effect below rather than
  // acted on directly in the click handler or in onSettled, because `disabled` on the button this
  // press came from is still true at that moment -- React has not yet committed the re-render that
  // flips setPriority.isPending back to false, and focusing a still-disabled button does nothing.
  const pendingFocusRef = useRef<{ sourceId: string, direction: -1 | 1 } | null>(null)

  // Bumped from onSettled below, once per mutation, rather than reading setPriority.isPending
  // itself in the effect's dependency array. A round trip fast enough to resolve within the same
  // microtask batch it was issued from lets React coalesce the pending state and the settled state
  // into a single commit, so isPending's rendered value can go straight from false to false and
  // never visibly pass through true -- an effect keyed on it would then see no change and never
  // fire. A counter bumped once per settle has no such coincidence: each mutation produces a value
  // strictly higher than the last, so the dependency always changes when one finishes.
  const [settledCount, setSettledCount] = useState(0)

  // Runs once the render carrying settledCount's new value has committed, which is the same render
  // that carries isPending: false and the buttons' final disabled state -- both landed in the same
  // batch as the bump that triggered this effect. Restores focus to the button that was pressed; if
  // a move landed the row at the boundary that same button now guards, that button is disabled by
  // design, so focus goes to the row's other button instead of vanishing to <body> the way a
  // disabled focused element does in every browser.
  useEffect(() => {
    if (setPriority.isPending) return
    const pending = pendingFocusRef.current
    if (!pending) return
    pendingFocusRef.current = null
    const refs = buttonRefs.current.get(pending.sourceId)
    if (!refs) return
    const primary = pending.direction === -1 ? refs.up : refs.down
    const fallback = pending.direction === -1 ? refs.down : refs.up
    if (primary && !primary.disabled) primary.focus()
    else if (fallback && !fallback.disabled) fallback.focus()
    // settledCount is the trigger; setPriority.isPending is read, not depended on, since it is
    // already implied by settledCount having just changed.
  }, [settledCount])

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

  // Sourced from `sources`, not `live`: the ranking list below must include a dormant source too,
  // since priorityFrom treats an omitted source as UNRANKED_BASE and the route would refuse a
  // write that left one out. Falling back to the id keeps a name lookup that races the sources
  // query from crashing the row rather than rendering it blank.
  const nameFor = (sourceId: string): string => sources.find((s) => s.id === sourceId)?.name ?? sourceId
  const order = (priority.data?.order ?? []).map((entry) => entry.sourceId)

  // The announcement is built from `next`, the list this move is about to send, rather than
  // read back from the server's own answer: the PUT echoes the same order it was given, so
  // waiting for the round trip to name a position already known here would only make a screen
  // reader wait longer than a sighted reader does for the same information.
  const move = (sourceId: string, name: string, at: number, by: -1 | 1): void => {
    pendingFocusRef.current = { sourceId, direction: by }
    const next = moved(order, at, by)
    const position = next.indexOf(sourceId) + 1
    setPriority.mutate(next, {
      onSuccess: () => setAnnouncement(t('settings.sourceOrder.moved', { name, position, total: next.length })),
      // The list stays whatever it was before this click -- setPriority.mutate does not touch
      // cached data on rejection -- so the only thing telling either kind of reader this failed is
      // this announcement and the field-error rendered off setPriority.isError below.
      onError: () => setAnnouncement(t('settings.sourceOrder.saveFailed')),
      onSettled: () => setSettledCount((n) => n + 1),
    })
  }

  const reset = (): void => {
    setPriority.mutate([], {
      onSuccess: () => setAnnouncement(t('settings.sourceOrder.resetAnnounced')),
      onError: () => setAnnouncement(t('settings.sourceOrder.saveFailed')),
      onSettled: () => setSettledCount((n) => n + 1),
    })
  }

  // The person's today, for the status panel switch's default below: the same derivation the
  // panel itself makes, so the two agree about which day "the last thirty days" ends on.
  const today = localToday(session.data?.timezone)

  return (
    <>
      <ul className="source-name-list">
        {live.map((source) => <SourceNameRow key={source.id} source={source} today={today} />)}
      </ul>
      {dormant.length > 0 && (
        <>
          <h3 className="source-names-dormant-heading">{t('settings.sourceNames.dormantHeading')}</h3>
          <ul className="source-name-list source-names-dormant">
            {dormant.map((source) => <SourceNameRow key={source.id} source={source} today={today} />)}
          </ul>
        </>
      )}
      {/* Its own Loading and ErrorState rather than a third shape: the sources list above already
          answers "what does this card show while its own query is in flight or has failed", and
          the priority query is just as capable of either, on its own schedule - the two routes
          answer at different times, and gating the whole card on the slower of the two would leave
          the names blank while priority is still in flight for no reason. */}
      <section className="source-order">
        <h3>{t('settings.sourceOrder.title')}</h3>
        <p>{t('settings.sourceOrder.intro')}</p>
        {/* Present regardless of the section's own load state, so a screen reader has already
            registered this region before the first move happens rather than discovering it at
            the same moment its content would change. */}
        <p className="sr-only" aria-live="polite">{announcement}</p>
        {priority.isPending && <Loading />}
        {priority.isError && (
          <ErrorState onRetry={() => { void priority.refetch() }} error={priority.error} />
        )}
        {priority.data && (
          <>
            <ol className="source-order-list">
              {priority.data.order.map((entry, at) => {
                const name = nameFor(entry.sourceId)
                return (
                  // No aria-label here: ARIA 1.2 does not let role="listitem" take a name from the
                  // author, so one never reached a screen reader, and the h4 right below already
                  // says the same name to a sighted reader.
                  <li key={entry.sourceId}>
                    <h4>{name}</h4>
                    <button
                      type="button"
                      ref={buttonRefFor(entry.sourceId, 'up')}
                      disabled={at === 0 || setPriority.isPending}
                      aria-label={t('settings.sourceOrder.moveUp', { name })}
                      onClick={() => move(entry.sourceId, name, at, -1)}
                    >{t('settings.sourceOrder.up')}</button>
                    <button
                      type="button"
                      ref={buttonRefFor(entry.sourceId, 'down')}
                      disabled={at === order.length - 1 || setPriority.isPending}
                      aria-label={t('settings.sourceOrder.moveDown', { name })}
                      onClick={() => move(entry.sourceId, name, at, 1)}
                    >{t('settings.sourceOrder.down')}</button>
                  </li>
                )
              })}
            </ol>
            {priority.data.configured && (
              <button
                type="button"
                disabled={setPriority.isPending}
                onClick={reset}
              >{t('settings.sourceOrder.reset')}</button>
            )}
            {setPriority.isError && (
              <p className="field-error">{t('settings.sourceOrder.saveFailed')}</p>
            )}
          </>
        )}
      </section>
    </>
  )
}

/**
 * The list with one entry moved by one place, returned whole rather than as a patch. The route
 * takes the complete list because priorityFrom treats it as a complete statement: a source it
 * omits falls to UNRANKED_BASE and loses to every ranked source on every day they share, so a
 * partial send from here would silently demote everything this helper left out.
 */
function moved(order: readonly string[], at: number, by: -1 | 1): string[] {
  const next = [...order]
  const target = at + by
  if (target < 0 || target >= next.length) return next
  const [item] = next.splice(at, 1)
  next.splice(target, 0, item!)
  return next
}

function SourceNameRow({ source, today }: { source: NamedSourceWithActivity, today: string }) {
  const { t, i18n } = useTranslation()
  const rename = useRenameSource()
  const clear = useClearSourceName()
  const setChoice = useSetPanelChoice()
  // What the status panel does with this source right now: the person's own choice when they made
  // one, and otherwise the panel's default - reported within the last thirty days. The default is
  // shownByDefault itself, imported from @haelan/core/status-panel, not a second copy of the
  // window: a switch drawn unchecked beside a source the panel is listing would be a control that
  // misreports the very thing it controls.
  const shown = source.panelChoice ?? shownByDefault(source.lastReportedDate, today)
  // The field is uncontrolled between edits: `draft` starts from what the server says and is only
  // pushed back on blur or Enter, so a slow round trip never fights the reader's typing.
  const [draft, setDraft] = useState(source.alias ?? '')

  const commit = () => {
    const next = draft.trim()
    if (next === (source.alias ?? '')) return
    if (next === '') clear.mutate({ sourceId: source.id })
    else rename.mutate({ sourceId: source.id, alias: next })
  }

  const failed = rename.isError || clear.isError || setChoice.isError
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
      {/* Beside the name, because both are things a reader decides about a source, where
          everything after them on the row is something the card reports about it. Changing it
          records an explicit choice even when it lands on what the default already was: the
          reader has said what they want, and a later change in the source's activity should not
          quietly overrule it. */}
      <label className="source-panel-toggle">
        <input type="checkbox" checked={shown}
          onChange={(e) => setChoice.mutate({ sourceId: source.id, visible: e.currentTarget.checked })} />
        {t('settings.sourceNames.showInPanel')}
      </label>
      {/* Only once a choice exists: with none, the switch already follows the default and there is
          nothing to go back to. */}
      {source.panelChoice !== null && (
        <button type="button" className="source-panel-default"
          onClick={() => setChoice.mutate({ sourceId: source.id, visible: null })}>
          {t('settings.sourceNames.panelDefault')}
        </button>
      )}
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
