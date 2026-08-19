import type { ChartTokens } from './tokens.js'
import type { Stage } from '../fixtures/july.js'

export function stageColor(stage: Stage, t: ChartTokens): string {
  return { deep: t.stageDeep, light: t.stageLight, rem: t.stageRem, awake: t.stageAwake }[stage]
}
