import { Fragment } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from '../../i18n/index.js'

/**
 * An overview page's list (nights, workouts), PATTERNS.md's "Overview pages": the first `visible`
 * items, most recent first as the caller orders them, and a "Show all N" button when there are
 * more, which names what it shows where the caller words it (`showAll`: "Show all 30 nights").
 * Expanded, every item, under a heading per group when `groupOf` names one (a month, on 3 months and
 * Year), flowing into columns (.period-list-expanded), and a "Show fewer" button. With
 * `groupCollapsed` the first items keep their headings too, and `groupAside` puts a summary on the
 * right of each ("31 nights · avg. 7h 06m"), the year mockup's month header.
 *
 * The page owns `expanded`, since the list's card takes its own full-width row when it opens and
 * the card beside it widens with it.
 */
/** How many items a list shows before "Show all"; a page sizing the list's card by it reads this. */
export const LIST_VISIBLE = 7

export function ExpandableList<T>({
  items, keyOf, render, groupOf, groupLabel, groupAside, groupCollapsed = false, expanded, onToggle, visible = LIST_VISIBLE, showAll,
}: {
  items: T[]
  keyOf: (item: T) => string
  render: (item: T) => ReactNode
  groupOf?: (item: T) => string
  groupLabel?: (group: string) => string
  /** A group heading's summary, on its right; null for none. */
  groupAside?: (group: string) => string | null
  /** Whether the first items, before "Show all", are grouped under headings as well. */
  groupCollapsed?: boolean
  expanded: boolean
  onToggle: () => void
  visible?: number
  showAll?: (count: number) => string
}) {
  const { t } = useTranslation()
  const more = items.length > visible
  const open = expanded && more
  const shown = open ? items : items.slice(0, visible)

  return (
    <div className="period-list">
      <div className={open ? 'period-list-items period-list-expanded' : 'period-list-items'}>
        {(open || groupCollapsed) && groupOf !== undefined
          ? groups(shown, groupOf).map(([group, members]) => (
            <section key={group} className="period-list-group">
              <Heading name={groupLabel?.(group) ?? group} aside={groupAside?.(group) ?? null} />
              {members.map((item) => <Fragment key={keyOf(item)}>{render(item)}</Fragment>)}
            </section>
          ))
          : shown.map((item) => <Fragment key={keyOf(item)}>{render(item)}</Fragment>)}
      </div>
      {more && (
        <button type="button" className="button period-list-toggle" aria-expanded={open} onClick={onToggle}>
          {open ? t('period.list.showFewer') : showAll?.(items.length) ?? t('period.list.showAll', { count: items.length })}
        </button>
      )}
    </div>
  )
}

function Heading({ name, aside }: { name: string, aside: string | null }) {
  return (
    <div className="period-list-heading">
      <h3 className="period-list-name">{name}</h3>
      {aside !== null && <span className="period-list-aside">{aside}</span>}
    </div>
  )
}

// The items in runs of one group each, in the order the caller gave them.
function groups<T>(items: T[], groupOf: (item: T) => string): [string, T[]][] {
  const runs: [string, T[]][] = []
  for (const item of items) {
    const group = groupOf(item)
    const last = runs.at(-1)
    if (last !== undefined && last[0] === group) last[1].push(item)
    else runs.push([group, [item]])
  }
  return runs
}
