import { useTranslation } from '../i18n/index.js'
import { Card } from '../components/Card.js'
import { EmptyState } from '../components/EmptyState.js'

/**
 * `/nutrition` used to render `<Dashboard />` as a placeholder (routes.tsx's own old comment said
 * so), which meant clicking Voeding in the rail showed the Dashboard's real numbers under a
 * Dashboard heading while the rail marked Nutrition current. Nutrition itself was deliberately
 * dropped from M3e-1, and that decision stands: the database carries no row for a macro, a
 * calorie total or a water total, and packages/core/src/api/catalogue.ts records why for the one
 * data type that comes closest to one of those (`nutrition-log`): this household has never logged
 * food, so its own 'calories' field is kept as an unverified guess with its own mapping deferred
 * until a real payload confirms or corrects it. `hydration-log` is mapped but is in the same state
 * on this instance: mapped does not mean populated, and there are no rows under it either.
 *
 * So this page carries no per-metric card, no chart and no empty state for a metric nobody has
 * ever specified a mapping for (carbs, protein, fat and a logged calorie total have no catalogue
 * entry at all): building those would mean inventing a data model just to have something to
 * render. One honest sentence instead, in the same Card shell every other page's section uses,
 * saying what is missing and what would fill it in.
 */
export function Nutrition() {
  const { t } = useTranslation()
  return (
    <>
      <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-3)' }}>{t('nutrition.title')}</h1>
      <div className="grid">
        <Card span={12} label={t('nutrition.title')}>
          <EmptyState title={t('nutrition.empty.title')} detail={t('nutrition.empty.detail')} />
        </Card>
      </div>
    </>
  )
}
