import { Icon } from './icons.js'
import { Link } from '../router.js'

const GROUPS = [
  { label: 'Overview', items: [['/', 'Dashboard']] },
  { label: 'Tracking', items: [['/activity', 'Activity'], ['/sleep', 'Sleep'], ['/recovery', 'Recovery'], ['/health', 'Health'], ['/weight', 'Weight'], ['/nutrition', 'Nutrition'], ['/notes', 'Notes']] },
] as const

export function Sidebar({ active, person }: { active: string, person: string }) {
  return (
    <nav className="rail" aria-label="Sections">
      <div className="brand">haelan</div>
      {GROUPS.map((g) => (
        <div key={g.label}>
          <div className="rail-group">{g.label}</div>
          {g.items.map(([path, name]) => (
            <Link key={path} to={path} className="rail-item"
                  aria-current={active === path ? 'page' : undefined}>
              <Icon name={path === '/' ? 'dashboard' : path.slice(1)} />{name}
            </Link>
          ))}
        </div>
      ))}
      {/* Not a Link: the account page it would point to returns in M3e. A dead link here would be
          a ninth way to reach a blank screen. */}
      <div className="rail-foot">
        <span className="avatar" aria-hidden="true">{person.slice(0, 1)}</span>{person}
      </div>
    </nav>
  )
}
