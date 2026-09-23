import { useEffect, useRef } from 'react'

/**
 * Whether a keydown belongs to something other than the app's own shortcuts.
 *
 * Three cases, and each is a way a single-key shortcut would take a keystroke that was meant for
 * something else. A field, a select or anything contenteditable is where the reader is typing,
 * and "t" there is a letter, not "go to today". A modifier means the browser or the system owns
 * the combination (Ctrl+1 switches tabs). An open dialog - the phone's period sheet, the rail
 * drawer, either of the two shortcut dialogs - has its own keys, and a period stepping behind it
 * would change the page under a sheet the reader is still looking at.
 *
 * Shift is not in that list: "?" is Shift+/ on most layouts, and refusing Shift would make the
 * help key unreachable. A shortcut that must not fire with Shift checks it itself.
 */
export function isForeignKey(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing) return true
  if (event.ctrlKey || event.metaKey || event.altKey) return true
  const target = event.target
  if (target instanceof HTMLElement) {
    if (target.isContentEditable) return true
    const tag = target.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  }
  return document.querySelector('dialog[open]') !== null
}

/**
 * A document-level keydown listener that skips every key isForeignKey claims.
 *
 * The handler is read through a ref, so a caller can pass a fresh closure every render (reading
 * the current controls) without the listener being removed and added again each time.
 */
export function useShortcutKeys(handler: (event: KeyboardEvent) => void, enabled = true): void {
  const latest = useRef(handler)
  latest.current = handler
  useEffect(() => {
    if (!enabled) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (isForeignKey(event)) return
      latest.current(event)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [enabled])
}
