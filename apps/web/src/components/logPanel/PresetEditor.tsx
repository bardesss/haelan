import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { useTranslation } from '../../i18n/index.js'
import { Icon } from '../icons.js'
import { SEED_KINDS, kindLabel as sharedKindLabel } from '../../data/eventKinds.js'
import { MAX_PRESET_LENGTH, MAX_PRESETS, validatePresets } from '@haelan/core/event-kinds'
import { useSavePresets } from '../../data/useQuickLog.js'
import { failureText } from './LogPanel.js'

/** `list` with `kind` moved to `index`, or null when that is no move at all. */
function reorder(list: string[], kind: string, index: number): string[] | null {
  const from = list.indexOf(kind)
  if (from === -1 || index < 0 || index >= list.length || index === from) return null
  const next = list.filter((k) => k !== kind)
  next.splice(index, 0, kind)
  return next
}

/**
 * The log panel's chips in edit mode (M9c, "Editing the chips"): each kind with a remove button, an
 * "Add a kind" field, and the order changed by dragging or, with a kind focused, by ← and →. Nothing
 * is sent until Done, which replaces the saved list outright; Cancel and Escape drop every change.
 *
 * `kinds` is only the starting list: the editor keeps its own copy, so the chips the panel draws
 * from the day log stay as they were until the save lands and the refetch brings the new list.
 *
 * Dragging is pointer events rather than HTML5 drag and drop, which Android Chrome never fires for
 * a finger: one path for a mouse and a touch, the pointer captured by the item it started on, and
 * the list reordered live as it passes over another item.
 *
 * Escape stops here rather than reaching whatever encloses the panel, so a popover closes on a
 * second Escape and never on the one meant to leave edit mode. The arrow keys a kind handles are
 * preventDefault'd, which is what the dashboard's own ← → day stepping reads (isForeignKey) to
 * leave them alone.
 */
export function PresetEditor({ kinds: initial, suggestions, onDone, onCancel }: {
  kinds: string[]
  suggestions: string[]
  onDone: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const save = useSavePresets()
  const listId = useId()
  const [kinds, setKinds] = useState(initial)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef(new Map<string, HTMLLIElement>())
  // The kind a key just moved, focused again once it is drawn in its new place: React moves the
  // other items round it or it round them, and a focused node taken out of the document loses focus.
  const refocus = useRef<string | null>(null)
  // The drag in progress: which kind, where it started, and the order as the drag has left it.
  // The order is kept here rather than read from state, because pointermove is a continuous event
  // React may batch, and the next move has to build on the last one's result.
  const drag = useRef<{ kind: string, from: number, order: string[] } | null>(null)
  const full = kinds.length >= MAX_PRESETS
  const taken = new Set(kinds.map((kind) => kind.toLowerCase()))
  const offered = suggestions.filter((kind) => !taken.has(kind.toLowerCase()))

  // Focus moves into the editor as it opens, so Escape leaves edit mode straight away and focus
  // does not fall to the page when the Edit button that opened it goes.
  useEffect(() => { rootRef.current?.focus() }, [])
  useLayoutEffect(() => {
    if (refocus.current === null) return
    itemRefs.current.get(refocus.current)?.focus()
    refocus.current = null
  })

  const kindLabel = (kind: string) => sharedKindLabel(t, kind)
  const announce = (kind: string, index: number) =>
    setAnnouncement(t('logPanel.edit.moved', { kind: kindLabel(kind), position: index + 1 }))

  function onItemKeyDown(event: KeyboardEvent<HTMLLIElement>, kind: string, index: number) {
    // Only the item itself: an arrow on its remove button is that button's business.
    if (event.target !== event.currentTarget) return
    const by = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    if (by === 0) return
    event.preventDefault()
    const next = reorder(kinds, kind, index + by)
    // At either end there is no move, and nothing to refocus: a refocus left set would pull focus
    // back to this item on whatever render came next.
    if (next === null) return
    refocus.current = kind
    setKinds(next)
    announce(kind, index + by)
  }

  function onPointerDown(event: PointerEvent<HTMLLIElement>, kind: string, index: number) {
    if (event.button !== 0 || (event.target as Element).closest('button') !== null) return
    drag.current = { kind, from: index, order: kinds }
    // happy-dom has no pointer capture; a browser without it still delivers the moves to the item
    // while the pointer stays over it.
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  function onPointerMove(event: PointerEvent<HTMLLIElement>) {
    const current = drag.current
    if (current === null) return
    // Captured, so the event's target is the dragged item itself: what lies under the pointer has
    // to be asked of the document.
    const over = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.log-edit-item')
    const target = over?.dataset.kind
    if (target === undefined) return
    const next = reorder(current.order, current.kind, current.order.indexOf(target))
    if (next === null) return
    current.order = next
    setKinds(next)
  }

  function onPointerEnd() {
    const current = drag.current
    if (current === null) return
    drag.current = null
    const to = current.order.indexOf(current.kind)
    if (to !== current.from) announce(current.kind, to)
  }

  function remove(kind: string) {
    setKinds(kinds.filter((k) => k !== kind))
    setError(null)
  }

  function onAddKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Escape in a field that holds a draft clears the draft, the way it would anywhere else, and
    // goes no further: only an empty field's Escape leaves edit mode.
    if (event.key === 'Escape' && draft !== '') {
      event.stopPropagation()
      setDraft('')
      return
    }
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault()
    addDraft()
  }

  /**
   * The draft added to the list, for Enter, the Add button and Done alike: the list with it (the
   * list as it was for a blank draft), or null when it is refused and the reason is showing.
   */
  function addDraft(): string[] | null {
    const value = draft.trim()
    if (value === '') return kinds
    // The cases a reader can reach are checked here, in their own language; validatePresets is
    // the server's rule and says it in English, so it only has the last word on anything else.
    const existing = kinds.find((kind) => kind.toLowerCase() === value.toLowerCase())
    if (existing !== undefined) { setError(t('logPanel.edit.duplicate', { kind: kindLabel(existing) })); return null }
    if (full) { setError(t('logPanel.edit.full')); return null }
    try {
      const next = validatePresets([...kinds, value])
      setKinds(next)
      setDraft('')
      setError(null)
      return next
    } catch (problem) {
      setError(failureText(problem))
      return null
    }
  }

  // Done takes a typed kind with it: a draft left in the field is added first, and one refused
  // keeps the editor open with the reason, rather than being dropped from the save unseen.
  function onSave() {
    const next = addDraft()
    if (next === null) return
    setError(null)
    save.mutateAsync(next).then(() => onDone(), (problem: unknown) => setError(failureText(problem)))
  }

  function onRootKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onCancel()
  }

  return (
    <div className="log-editor" ref={rootRef} tabIndex={-1} onKeyDown={onRootKeyDown}>
      <ul className="log-edit-list">
        {kinds.map((kind, index) => (
          <li key={kind} className="log-edit-item" tabIndex={0} data-kind={kind}
            ref={(el) => { if (el === null) itemRefs.current.delete(kind); else itemRefs.current.set(kind, el) }}
            onKeyDown={(event) => onItemKeyDown(event, kind, index)}
            onPointerDown={(event) => onPointerDown(event, kind, index)}
            onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}>
            <span className="log-edit-name">{kindLabel(kind)}</span>
            <button type="button" className="log-edit-remove" aria-label={t('logPanel.edit.remove', { kind: kindLabel(kind) })}
              onClick={() => remove(kind)}><Icon name="close" /></button>
          </li>
        ))}
      </ul>
      <p className="sr-only" aria-live="polite">{announcement}</p>
      <div className="log-edit-add">
        <input className="input" list={listId} value={draft} disabled={full} maxLength={MAX_PRESET_LENGTH}
          aria-label={t('logPanel.edit.add')} placeholder={t('logPanel.edit.add')}
          onChange={(event) => setDraft(event.target.value)} onKeyDown={onAddKeyDown} />
        <button type="button" className="button" disabled={full || draft.trim() === ''} onClick={() => addDraft()}>
          {t('logPanel.edit.addButton')}
        </button>
      </div>
      <datalist id={listId}>
        {offered.map((kind) => <option key={kind} value={kind} label={kindLabel(kind)} />)}
      </datalist>
      {full && <p className="field-hint">{t('logPanel.edit.full')}</p>}
      {error !== null && <p className="log-error" role="alert">{error}</p>}
      <div className="log-edit-actions">
        <button type="button" className="button" onClick={onCancel}>{t('logPanel.edit.cancel')}</button>
        <button type="button" className="button button-primary" disabled={save.isPending} onClick={onSave}>
          {t('logPanel.edit.done')}
        </button>
      </div>
    </div>
  )
}
