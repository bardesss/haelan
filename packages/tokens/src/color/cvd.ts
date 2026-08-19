import { hexToRgb, rgbToHex, toLinear, fromLinear, deltaE } from './convert.js'

type Matrix = readonly [readonly number[], readonly number[], readonly number[]]

// Vienot 1999 dichromat simulation, applied in linear RGB.
const MATRICES = {
  deuteranopia: [[0.625, 0.375, 0], [0.7, 0.3, 0], [0, 0.3, 0.7]],
  protanopia: [[0.567, 0.433, 0], [0.558, 0.442, 0], [0, 0.242, 0.758]],
  tritanopia: [[0.95, 0.05, 0], [0, 0.433, 0.567], [0, 0.475, 0.525]],
} as const satisfies Record<string, Matrix>

export type CvdKind = keyof typeof MATRICES
export const CVD_KINDS = Object.keys(MATRICES) as CvdKind[]

export function simulate(kind: CvdKind, hex: string): string {
  const m: Matrix | undefined = MATRICES[kind]
  if (!m) throw new Error(`unknown simulation: ${kind}`)
  const [r, g, b] = hexToRgb(hex).map(toLinear) as [number, number, number]
  const out = m.map((row) => (row[0] ?? 0) * r + (row[1] ?? 0) * g + (row[2] ?? 0) * b)
  return rgbToHex(out.map(fromLinear) as [number, number, number])
}

// Worst case across normal vision and every simulated dichromacy; every confusability assertion uses this, not plain deltaE.
export function minSeparation(hexA: string, hexB: string): number {
  return Math.min(deltaE(hexA, hexB), ...CVD_KINDS.map((k) => deltaE(simulate(k, hexA), simulate(k, hexB))))
}
