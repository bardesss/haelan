import { describe, it, expect } from 'vitest'
import { stageMark } from '../src/charts/stage.js'
import type { ChartTokens } from '../src/charts/tokens.js'
import type { Stage } from '../src/fixtures/july.js'

const STAGES: Stage[] = ['deep', 'light', 'rem', 'awake']

const tokens = {
  stageDeep: '#111111', stageLight: '#222222', stageRem: '#333333', stageAwake: '#444444',
  axis: '#777777',
} as ChartTokens

describe('stage mark styling', () => {
  it('fills a mark with its own stage colour', () => {
    expect(stageMark('deep', tokens).fill).toBe(tokens.stageDeep)
    expect(stageMark('awake', tokens).fill).toBe(tokens.stageAwake)
  })

  // A hypnogram bar is centred in its lane at 45% of the lane height, so card
  // shows above and below it and the bar is an isolated mark rather than part of
  // a tiled band. Two stage colours sit below the WCAG 1.4.11 3:1 floor against
  // their own card (dark stage-deep 1.77, light stage-rem 1.36), which the
  // palette cannot fix without giving up "deeper sleep, deeper blue". The
  // outline is what carries the floor instead, so it is not optional and not
  // per-stage: a bar that is legible only in some themes is worse than one
  // outlined everywhere.
  it.each(STAGES)('outlines %s so the mark clears the card it sits on', (stage) => {
    const mark = stageMark(stage, tokens)
    expect(mark.outline, `${stage} outline`).toBe(tokens.axis)
    expect(mark.outlineWidth, `${stage} outline width`).toBeGreaterThan(0)
  })

  it('never gives two stages the same fill', () => {
    expect(new Set(STAGES.map((s) => stageMark(s, tokens).fill)).size).toBe(STAGES.length)
  })
})
