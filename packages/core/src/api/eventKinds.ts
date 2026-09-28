// The kinds a person's quick-log chips start from, and the rules a saved list must keep. Browser
// safe, and reached by apps/web through the `@haelan/core/event-kinds` subpath, so the chart panel,
// the Notes list and the server share one list and one set of rules.

/** In chip order. Each has an `annotate.event.kinds.*` translation in the web app. */
export const SEED_KINDS: readonly string[] = [
  'illness', 'travel', 'alcohol', 'medication', 'injury', 'caffeine',
  'meditation', 'sauna', 'reading', 'screen_free', 'stretching',
]

export const MAX_PRESETS = 16
export const MAX_PRESET_LENGTH = 40

/** The trimmed list, or an Error naming the first problem (1-based). An empty list is allowed. */
export function validatePresets(input: unknown): string[] {
  if (!Array.isArray(input)) throw new Error('kinds must be an array of text')
  if (input.length > MAX_PRESETS) throw new Error(`kinds holds at most ${MAX_PRESETS}`)
  const seen = new Set<string>()
  return input.map((raw, i) => {
    if (typeof raw !== 'string') throw new Error(`kind ${i + 1} must be text`)
    const kind = raw.trim()
    if (kind === '') throw new Error(`kind ${i + 1} is empty`)
    if (kind.length > MAX_PRESET_LENGTH) throw new Error(`kind ${i + 1} is longer than ${MAX_PRESET_LENGTH} characters`)
    const key = kind.toLowerCase()
    if (seen.has(key)) throw new Error(`kind ${i + 1} repeats "${kind.toLowerCase()}"`)
    seen.add(key)
    return kind
  })
}
