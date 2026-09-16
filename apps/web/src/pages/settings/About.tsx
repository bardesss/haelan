import { useTranslation } from '../../i18n/index.js'
import { Icon } from '../../components/icons.js'

/**
 * The project's own links, exported so the test can assert what they point at without scraping
 * markup for it.
 *
 * Three external addresses, not app routes: a self-hosted tool has no in-app feedback channel of
 * its own, so these go straight to the project's home on GitHub. That reasoning came from the rail,
 * where they used to live, and it survives the move unchanged - it was always an argument for
 * having them somewhere findable rather than for spending three permanent rail rows on them, one
 * of which a collapsed rail turns into an unlabelled glyph.
 */
export const PROJECT_LINKS = [
  { href: 'https://github.com/bardesss/haelan#readme', nameKey: 'settings.about.documentation', icon: 'docs' },
  { href: 'https://github.com/bardesss/haelan/releases', nameKey: 'settings.about.changelog', icon: 'changelog' },
  { href: 'https://github.com/bardesss/haelan/issues', nameKey: 'settings.about.issues', icon: 'issues' },
] as const

export function About() {
  const { t } = useTranslation()
  return (
    <ul className="about-links">
      {PROJECT_LINKS.map((link) => (
        <li key={link.href}>
          {/* rel="noreferrer" beside target="_blank" on every one: without it the opened page gets
              a handle on this one through window.opener. */}
          <a className="about-link" href={link.href} target="_blank" rel="noreferrer">
            <Icon name={link.icon} />{t(link.nameKey)}
          </a>
        </li>
      ))}
    </ul>
  )
}
