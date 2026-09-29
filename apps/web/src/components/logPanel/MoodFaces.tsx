import { useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { useTranslation } from '../../i18n/index.js'

// The five mouths, frown to grin, from the approved mockup (spec 2026-09-27-m9c-quick-logging,
// panel.cjs); the face and eyes around them are the same on all five.
const MOUTHS = ['M10 22 Q16 16 22 22', 'M10 21 Q16 18 22 21', 'M10 20 L22 20', 'M10 19 Q16 22 22 19', 'M10 18 Q16 25 22 18']

// Written out rather than built from the score, so catalogue-usage.test.ts sees every key.
const LABELS = ['logPanel.mood.1', 'logPanel.mood.2', 'logPanel.mood.3', 'logPanel.mood.4', 'logPanel.mood.5'] as const

// Looked up rather than assembled, so css-classes.test.ts reads both names as written.
const FACE_CLASS = { on: 'log-face is-on', off: 'log-face' } as const

function Face({ mouth }: { mouth: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="16" cy="16" r="13" />
      <circle cx="11.5" cy="13" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="20.5" cy="13" r="1.2" fill="currentColor" stroke="none" />
      <path d={mouth} />
    </svg>
  )
}

/**
 * One of the five faces, read only: the night page's "That day" card names a mood already set,
 * rather than offering to set one, so it has no use for the radio group above - only for the one
 * face MoodFaces already knows how to draw. `score` is 1 to 5, the same range the radio group
 * takes; `label` is the caller's own word for it (`logPanel.mood.{{score}}`), passed in rather than
 * looked up here, since this file already reads `t` only for the five it draws itself, and a sixth
 * caller with its own translation hook is not a reason to add a second one to this one.
 */
export function MoodFace({ score, label }: { score: number, label: string }) {
  return (
    <span className={FACE_CLASS.on} role="img" aria-label={label}>
      <Face mouth={MOUTHS[score - 1]!} />
    </span>
  )
}

/**
 * How the day felt, scored 1 to 5: a radio group of five faces, each with its word beneath it.
 *
 * A radio group rather than five toggles because only one can be marked, but one that can also be
 * emptied: a tap on the marked face clears it (`onChange(null)`), since "no answer" is a real
 * state for a mood and a native radio group has no way back to it. The keys are the radio group's
 * own (the arrows move and select, wrapping at the ends; Home and End jump there), with one tab
 * stop, on the marked face or on the first when none is.
 */
export function MoodFaces({ value, onChange, labelledBy }: {
  value: number | null
  onChange: (score: number | null) => void
  labelledBy: string
}) {
  const { t } = useTranslation()
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const focusStop = value ?? 1

  function select(score: number) {
    buttons.current[score - 1]?.focus()
    if (score !== value) onChange(score)
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, score: number) {
    const target = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (score % 5) + 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? ((score + 3) % 5) + 1
        : event.key === 'Home' ? 1
          : event.key === 'End' ? 5
            : null
    if (target === null) return
    event.preventDefault()
    select(target)
  }

  return (
    <div className="log-faces" role="radiogroup" aria-labelledby={labelledBy}>
      {MOUTHS.map((mouth, i) => {
        const score = i + 1
        const on = score === value
        return (
          <button key={score} type="button" role="radio" aria-checked={on}
            ref={(el) => { buttons.current[i] = el }}
            className={on ? FACE_CLASS.on : FACE_CLASS.off} tabIndex={score === focusStop ? 0 : -1}
            onClick={() => onChange(on ? null : score)} onKeyDown={(event) => onKeyDown(event, score)}>
            <Face mouth={mouth} />
            <span>{t(LABELS[i]!)}</span>
          </button>
        )
      })}
    </div>
  )
}
