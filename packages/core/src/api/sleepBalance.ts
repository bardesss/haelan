// The sleep balance: each night signed against a zero line that is the person's usual when they
// follow it and it is not thin, their target otherwise. One rule for the Sleep period read and the
// night page, so the two state the same balance. Absent nights stay absent: a night that reported
// nothing is not a night of exactly no surplus.
export interface ZeroLine { minutes: number, source: 'baseline' | 'target' }

export function balanceZeroLine(baseline: { center: number, thin: boolean } | null, useBaseline: boolean, targetMinutes: number): ZeroLine {
  return useBaseline && baseline !== null && !baseline.thin
    ? { minutes: baseline.center, source: 'baseline' }
    : { minutes: targetMinutes, source: 'target' }
}

export function balanceOf(values: readonly (number | null)[], zeroLine: number): { values: (number | null)[], total: number } {
  const signed = values.map((value) => (value === null ? null : value - zeroLine))
  return { values: signed, total: signed.reduce((total: number, value) => (value === null ? total : total + value), 0) }
}
