import { Icon } from './icons.js'

const GROUPS = [
  { label: 'Overview', items: [['dashboard', 'Dashboard']] },
  { label: 'Tracking', items: [['activity', 'Activity'], ['sleep', 'Sleep'], ['recovery', 'Recovery'], ['health', 'Health'], ['weight', 'Weight'], ['nutrition', 'Nutrition'], ['notes', 'Notes']] },
  { label: 'Resources', items: [['docs', 'Docs'], ['changelog', 'Changelog']] },
] as const

export function Sidebar({ active, person, onNavigate }: {
  active: string
  person: string
  onNavigate: (id: string) => void
}) {
  return (
    <nav className="rail" aria-label="Sections">
      <div className="brand">haelan</div>

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

      <div className="rail-foot">
        <a className="rail-item" href="#account" aria-current={active === 'account' ? 'page' : undefined}
           onClick={() => onNavigate('account')}>
          <span className="avatar" aria-hidden="true">{person.slice(0, 1)}</span>{person}
        </a>
        <a className="rail-item" href="#settings" aria-current={active === 'settings' ? 'page' : undefined}
           onClick={() => onNavigate('settings')}>
          <Icon name="settings" />Settings
        </a>
      </div>
    </nav>
  )
}
