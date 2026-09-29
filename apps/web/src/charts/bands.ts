// A usual band from a baseline. Thin stays undefined, not a band drawn thin: a band computed from
// three nights looks exactly as authoritative as one computed from thirty, and thin is the reader's
// only signal that it is not. One copy for every page (Sleep, Recovery, Health and Weight each had
// their own).
export function bandFrom(baseline: { center: number, spread: number, thin: boolean } | null): { low: number, high: number } | undefined {
  return baseline !== null && !baseline.thin
    ? { low: baseline.center - baseline.spread, high: baseline.center + baseline.spread }
    : undefined
}
