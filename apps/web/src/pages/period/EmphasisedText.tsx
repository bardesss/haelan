import type { Emphasised } from '../detail/periodText.js'

/**
 * A line from emphasise() (periodText.ts): its plain runs as text, its emphasised ones bold, and a
 * good run (the ✦) in the positive colour, as the nights list draws its own.
 */
export function EmphasisedText({ line }: { line: Emphasised }) {
  return <>{line.map((run, index) => (run.strong ? <strong key={index}>{run.text}</strong>
    : run.good === true ? <span key={index} className="period-good">{run.text}</span> : run.text))}</>
}
