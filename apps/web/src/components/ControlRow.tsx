import { Icon } from './icons.js'

const RANGES = ['Day', 'Week', 'Month', '3 months', 'Year'] as const

export function ControlRow({ range, label, sources, syncedAgo }: {
  range: string
  label: string
  sources: string
  syncedAgo: string
}) {
  return (
    <div className="controls">
      <div className="segmented" role="group" aria-label="Time range">
        {RANGES.map((r) => (
          <button key={r} type="button" className="segment" aria-pressed={r === range}>{r}</button>
        ))}
      </div>

      <div className="stepper">
        <button type="button" className="icon-button" aria-label="Previous period"><Icon name="chevronLeft" /></button>
        <span className="stepper-label">{label}</span>
        <button type="button" className="icon-button" aria-label="Next period"><Icon name="chevronRight" /></button>
      </div>

      <div className="controls-end">
        <button type="button" className="button">
          <Icon name="sources" />Sources<span className="button-count">{sources}</span>
        </button>
        <button type="button" className="button"><Icon name="download" />Download raw</button>
        <button type="button" className="button button-primary"><Icon name="sync" />Sync</button>
        <span className="synced">Synced {syncedAgo}</span>
      </div>
    </div>
  )
}
