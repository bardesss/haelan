import type { ChartTokens } from './tokens.js'
import type { Stage } from '../fixtures/july.js'
import { STROKE } from './base.js'

export function stageColor(stage: Stage, t: ChartTokens): string {
  return { deep: t.stageDeep, light: t.stageLight, rem: t.stageRem, awake: t.stageAwake }[stage]
}

export type StageMark = { fill: string; outline: string; outlineWidth: number }

// Stage marks are isolated: a hypnogram bar is centred in its lane at 45% of the
// lane height, and a nap dot is 6px with card on every side. Two stage colours
// sit below the 3:1 non-text floor against their own card - dark stage-deep at
// 1.77, light stage-rem at 1.36 - and the palette cannot lift them without
// giving up the ordering that makes it readable ("deeper sleep, deeper blue",
// spec section 17). So the edge carries the floor instead of the fill. The axis
// token is the outline because it is already held to a contrast floor against
// the card in both themes (packages/tokens/test/accessibility.test.ts), which is
// exactly the guarantee this needs.
export function stageMark(stage: Stage, t: ChartTokens): StageMark {
  return { fill: stageColor(stage, t), outline: t.axis, outlineWidth: STROKE.stageOutline }
}
