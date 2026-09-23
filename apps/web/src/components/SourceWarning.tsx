import { createContext, useContext } from 'react'
import { Icon } from './icons.js'

/**
 * The warning a card carries when a source feeding it has gone quiet, drawn beside the card's own
 * title: an icon, the full sentence as its tooltip, and the same sentence for a screen reader.
 *
 * Beside whichever title the card actually draws. A card with a label draws it in Card; a tile
 * card has no Card label and draws its title in StatTile instead. Card therefore hands the warning
 * down through this context, marked as already shown when its own label took it, and StatTile
 * draws it only when Card did not - so a card shows the mark once, next to the name a reader
 * looks at, whichever of the two that is.
 */
export function SourceWarning({ text }: { text: string }) {
  return (
    <span className="source-warning" title={text}>
      <Icon name="warning" />
      <span className="sr-only">{text}</span>
    </span>
  )
}

export interface CardWarning { text: string, shownByCard: boolean }

export const CardWarningContext = createContext<CardWarning | null>(null)

/** The warning a title inside a card still has to draw, or null when there is none or Card drew it. */
export function useUnshownCardWarning(): string | null {
  const warning = useContext(CardWarningContext)
  return warning === null || warning.shownByCard ? null : warning.text
}
