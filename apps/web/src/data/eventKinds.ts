/**
 * Spec section 6's seed set (packages/core/src/db/schema/annotations.ts's own comment on
 * events.kind). A closed list here would contradict the column, which is deliberately not an
 * enum: AnnotatePanel.tsx's own datalist offers these six and accepts anything the reader types
 * past them.
 *
 * Its own file, not owned by AnnotatePanel.tsx: dayAnnotations.ts reads the same list to decide
 * whether a stored event's own `kind` is one of the six annotate.event.kinds translates, or free
 * text a reader typed past them, and every data module in apps/web/src/data imports from its
 * component layer never the other way (AnnotatePanel.tsx itself imports useAnnotations.ts, not
 * the reverse). A data file reading a component file's constant would invert that, so the list
 * lives here instead, imported by both.
 */
export const SEED_KINDS: readonly string[] = ['illness', 'travel', 'alcohol', 'medication', 'injury', 'caffeine']
