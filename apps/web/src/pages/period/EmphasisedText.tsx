import type { Emphasised } from '../detail/periodText.js'

/** A line from emphasise() (periodText.ts): its plain runs as text, its emphasised ones bold. */
export function EmphasisedText({ line }: { line: Emphasised }) {
  return <>{line.map((run, index) => (run.strong ? <strong key={index}>{run.text}</strong> : run.text))}</>
}
