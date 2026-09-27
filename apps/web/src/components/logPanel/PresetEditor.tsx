import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent } from 'react'
import { useTranslation } from '../../i18n/index.js'
import { Icon } from '../icons.js'
import { SEED_KINDS } from '../../data/eventKinds.js'
import { MAX_PRESETS, validatePresets } from '@haelan/core/event-kinds'
import { useSavePresets } from '../../data/useQuickLog.js'

/**
 * The log panel's chips in edit mode (M9c, "Editing the chips"): each kind with a remove button, an
 * "Add a kind" field, and the order changed by dragging or, with a kind focused, by ← and →. Nothing
 * is sent until Done, which replaces the saved list outright; Cancel and Escape drop every change.
 *
 * `kinds` is only the starting list: the editor keeps its own copy, so the chips the panel draws
 * from the day log stay as they were until the save lands and the refetch brings the new list.
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
  const dragging = useRef<string | null>(null)
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

  const kindLabel = (kind: string) => SEED_KINDS.includes(kind) ? t(`annotate.event.kinds.${kind}`) : kind

  function moveTo(kind: string, index: number) {
    const from = kinds.indexOf(kind)
    if (from === -1 || index < 0 || index >= kinds.length || index === from) return
    const next = kinds.filter((k) => k !== kind)
    next.splice(index, 0, kind)
    setKinds(next)
    setAnnouncement(t('logPanel.edit.moved', { kind: kindLabel(kind), position: index + 1 }))
  }

  function onItemKeyDown(event: KeyboardEvent<HTMLLIElement>, kind: string, index: number) {
    // Only the item itself: an arrow on its remove button is that button's business.
    if (event.target !== event.currentTarget) return
    const by = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    if (by === 0) return
    event.preventDefault()
    refocus.current = kind
    moveTo(kind, index + by)
  }

  function onDragStart(event: DragEvent<HTMLLIElement>, kind: string) {
    dragging.current = kind
    // Firefox starts no drag without data; happy-dom has no dataTransfer at all.
    event.dataTransfer?.setData('text/plain', kind)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  }

  function onDrop(event: DragEvent<HTMLLIElement>, index: number) {
    if (dragging.current === null) return
    event.preventDefault()
    moveTo(dragging.current, index)
    dragging.current = null
  }

  function remove(kind: string) {
    setKinds(kinds.filter((k) => k !== kind))
    setError(null)
  }

  function onAddKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (draft.trim() === '') return
    try {
      setKinds(validatePresets([...kinds, draft]))
      setDraft('')
      setError(null)
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem))
    }
  }

  function onSave() {
    setError(null)
    save.mutateAsync(kinds).then(
      () => onDone(),
      (problem: unknown) => setError(problem instanceof Error ? problem.message : String(problem)),
    )
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
          <li key={kind} className="log-edit-item" tabIndex={0} draggable
            ref={(el) => { if (el === null) itemRefs.current.delete(kind); else itemRefs.current.set(kind, el) }}
            onKeyDown={(event) => onItemKeyDown(event, kind, index)}
            onDragStart={(event) => onDragStart(event, kind)}
            onDragOver={(event) => { if (dragging.current !== null) event.preventDefault() }}
            onDrop={(event) => onDrop(event, index)}
            onDragEnd={() => { dragging.current = null }}>
            <span className="log-edit-name">{kindLabel(kind)}</span>
            <button type="button" className="log-edit-remove" aria-label={t('logPanel.edit.remove', { kind: kindLabel(kind) })}
              onClick={() => remove(kind)}><Icon name="close" /></button>
          </li>
        ))}
      </ul>
      <p className="sr-only" aria-live="polite">{announcement}</p>
      <input className="input" list={listId} value={draft} disabled={full}
        aria-label={t('logPanel.edit.add')} placeholder={t('logPanel.edit.add')}
        onChange={(event) => setDraft(event.target.value)} onKeyDown={onAddKeyDown} />
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
