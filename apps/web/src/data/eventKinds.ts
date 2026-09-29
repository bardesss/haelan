/**
 * Spec section 6's seed set (packages/core/src/db/schema/annotations.ts's own comment on
 * events.kind). A closed list here would contradict the column, which is deliberately not an
 * enum: AnnotatePanel.tsx's own datalist offers these six and accepts anything the reader types
 * past them.
 *
 * Its own file, not owned by AnnotatePanel.tsx: dayAnnotations.ts reads the same list to decide
 * whether a stored event's own `kind` is one of the six annotate.event.kinds translates, or free
 * text a reader typed past them, and every component module in apps/web/src/components imports
 * from the data layer, never the other way (AnnotatePanel.tsx itself imports useAnnotations.ts,
 * not the reverse). A data file reading a component file's constant would invert that, so the
 * list lives here instead, imported by both.
 */
import { SEED_KINDS } from '@haelan/core/event-kinds'
import type { Translate } from '../format.js'

export { SEED_KINDS }

/**
 * The label a reader sees for an event kind: a seed kind's own catalogue string, or the kind
 * exactly as typed when it is a reader's free text past the six seeded ones (the same split this
 * file's own comment above explains for the column itself). One copy, not the five near-identical
 * ternaries LogPanel.tsx, PresetEditor.tsx, AnnotatePanel.tsx, NotesList.tsx and dayAnnotations.ts
 * each carried before this: every one of those tested `SEED_KINDS.includes(kind)` against the same
 * list and fell back to the same six `annotate.event.kinds.*` keys, so a seventh seed kind added to
 * one and not the others would have translated in four places and stayed raw text in a fifth.
 */
export function kindLabel(t: Translate, kind: string): string {
  return SEED_KINDS.includes(kind) ? t(`annotate.event.kinds.${kind}`) : kind
}
