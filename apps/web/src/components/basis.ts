import { createContext, useContext } from 'react'

// The card's basis line doubles as the chart's accessible description; the card publishes the id, the chart points at it.
export const BasisContext = createContext<string | undefined>(undefined)

export function useBasisId(): string | undefined {
  return useContext(BasisContext)
}
