import type { ReactNode } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { FigureRows } from '../../../components/FigureRow.js'
import type { WorkoutPageData } from '../../../data/useWorkoutPage.js'
import { SideCard } from '../../detail/DayLogBlock.js'
import { WorkoutFigureRow } from './WorkoutFigureRow.js'

// The five running dynamics, in the mockup's order.
const FORM = ['cadence', 'strideLength', 'groundContact', 'verticalOscillation', 'verticalRatio'] as const

/**
 * Running form (the mockup's "Loopvorm"), in the shared side layout (SideCard): cadence, stride
 * length, ground contact, vertical oscillation and vertical ratio, each against the usual for the
 * type. Only a watch that records running dynamics sends them, and only for a run (a minority of
 * sessions), so the card is absent on most workouts by design, and a figure the watch left out is
 * left out here too.
 */
export function WorkoutForm({ page }: { page: WorkoutPageData }): ReactNode {
  const { t } = useTranslation()
  const present = FORM.filter((key) => (page.figures[key]?.value ?? null) !== null)
  if (present.length === 0) return null
  return (
    <SideCard label={t('activity.workout.page.form.label')} caption={t('activity.workout.page.form.caption')}>
      <FigureRows side>
        {present.map((key) => (
          <WorkoutFigureRow key={key} figure={page.figures[key]} label={t(`activity.workout.page.figures.${key}`)} />
        ))}
      </FigureRows>
    </SideCard>
  )
}
