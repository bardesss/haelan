import { Icon } from './icons.js'

const GROUPS = [
  { label: 'Overview', items: [['dashboard', 'Dashboard']] },
  { label: 'Tracking', items: [['activity', 'Activity'], ['sleep', 'Sleep'], ['recovery', 'Recovery'], ['health', 'Health'], ['weight', 'Weight'], ['nutrition', 'Nutrition'], ['notes', 'Notes']] },
  { label: 'Resources', items: [['docs', 'Docs'], ['changelog', 'Changelog']] },
] as const

export function Sidebar({ active, onNavigate }: { active: string; onNavigate: (id: string) => void }) {
  return (
    <nav className="rail" aria-label="Sections">
      <div style={{ fontWeight: 700, padding: '4px 12px 16px' }}>Vitals</div>
      {GROUPS.map((g) => (
        <div key={g.label}>
          <div className="rail-group">{g.label}</div>
          {g.items.map(([id, name]) => (
            <a key={id} className="rail-item" href={`#${id}`} aria-current={active === id ? 'page' : undefined}
               onClick={() => onNavigate(id)}>
              <Icon name={id} />{name}
            </a>
          ))}
        </div>
      ))}
    </nav>
  )
}
