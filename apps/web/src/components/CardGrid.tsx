import { createContext, useCallback, useContext, useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from '../i18n/index.js'
import { Card } from './Card.js'
import { EmptyState } from './EmptyState.js'

/**
 * How a page learns that every one of its cards hid itself.
 *
 * React gives a parent no way to ask whether its children rendered anything, and the alternative
 * — having each page re-run the visibility predicate over its own card inputs before building the
 * elements — puts the gate in two places, the split MetricCard exists to end. So the shell does
 * the reporting: `Card` is what every VISIBLE card renders, in every branch of every gate
 * (loading, error, empty-but-kept, drawn), and a hidden card renders no `Card` at all. The count
 * of registrations is therefore the count of cards on screen, with nothing for a card author to
 * remember and no exemption list for the cards that never hide.
 *
 * `register` is stable across renders (useCallback with a setter-function update and no deps), so
 * the effect in `useCardPresence` runs once per card mount rather than on every parent render.
 * An unstable value here would deregister and re-register every card on every commit, which is
 * not merely wasteful: between the two, the count passes through zero.
 */
const CardPresence = createContext<((id: string) => () => void) | null>(null)

/**
 * Called by `Card`, once, unconditionally. Outside a `CardGrid` the context is null and this is a
 * no-op, which is the path every `Card` on Settings, Account, Notes and the two detail pages
 * takes, and the path the fallback below takes by sitting outside the provider.
 *
 * `counts` is false for an ambient card (see `Card`'s own prop): it renders, it is visible, and it
 * does not speak for the page. The check lives inside the effect rather than around the hook call,
 * because a hook behind an `if` moves hook order the first time a card changes its mind.
 */
export function useCardPresence(counts: boolean): void {
  const register = useContext(CardPresence)
  const id = useId()
  useEffect(() => {
    if (!counts) return
    return register?.(id)
  }, [register, id, counts])
}

export function CardGrid({ children }: { children: ReactNode }): ReactNode {
  const { t } = useTranslation()
  const [present, setPresent] = useState<ReadonlySet<string>>(() => new Set())
  // Distinct from `present.size === 0`, and the difference is the whole of the no-flash rule: on
  // the first commit nothing has registered yet, so an empty set means "not measured", not "no
  // cards". React runs child effects before parent effects, so by the time the effect below fires
  // every card in this commit has already registered.
  const [measured, setMeasured] = useState(false)

  const register = useCallback((id: string) => {
    setPresent((was) => {
      const next = new Set(was)
      next.add(id)
      return next
    })
    return () => setPresent((was) => {
      const next = new Set(was)
      next.delete(id)
      return next
    })
  }, [])

  useEffect(() => { setMeasured(true) }, [])

  return (
    <div className="grid">
      <CardPresence.Provider value={register}>{children}</CardPresence.Provider>
      {/* Inside the grid so its own `gridColumn: span 12` means something, outside the provider
          so it never registers: inside, it would take the count to one, stop rendering, drop the
          count back to zero and oscillate. A provider renders no DOM node, so being outside it
          costs the fallback nothing but the registration. */}
      {measured && present.size === 0 && (
        <Card span={12}>
          <EmptyState title={t('emptyState.page.title')} detail={t('emptyState.page.detail')} />
        </Card>
      )}
    </div>
  )
}
