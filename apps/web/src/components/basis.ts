import { createContext, useContext } from 'react'

// A card's basis line is also the description of whatever chart the card holds:
// the same sentence answers "what am I looking at" for a sighted reader and for
// a screen reader. The card publishes the id; the chart points at it.
export const BasisContext = createContext<string | undefined>(undefined)

export function useBasisId(): string | undefined {
  return useContext(BasisContext)
}
