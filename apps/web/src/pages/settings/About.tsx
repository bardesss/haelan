import { useTranslation } from '../../i18n/index.js'
import { Icon } from '../../components/icons.js'
import { useSession } from '../../auth/session.js'
import { useUpdateStatus, useSetUpdateCheck, isNewer } from '../../data/useUpdateCheck.js'

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

/**
 * The version this bundle was built from.
 *
 * Re-exported as a named constant rather than read inline, so a test can assert it against the
 * root package.json without scraping the rendered markup for a number.
 */
export const APP_VERSION: string = __APP_VERSION__

/**
 * Which of the five things this card can say about releases is true.
 *
 * A named state rather than a chain of ternaries in the markup, because these are not points on a
 * spectrum: off, never asked, could not ask, behind, and current are five different claims, and
 * each is the only honest thing to say about its own case. Named, they can be read as a list,
 * tested as one, and styled by one - only `available` asks anything of the reader, and it is the
 * only one the stylesheet colours.
 */
export type UpdateState = 'off' | 'unknown' | 'unreachable' | 'current' | 'available'

export function updateState(status: {
  enabled: boolean
  latest: string | null
  reachable: boolean
}, current: string): UpdateState {
  if (!status.enabled) return 'off'
  if (!status.reachable) return 'unreachable'
  if (status.latest === null) return 'unknown'
  return isNewer(status.latest, current) ? 'available' : 'current'
}

export function About() {
  const { t } = useTranslation()
  const session = useSession()
  const status = useUpdateStatus()
  const setEnabled = useSetUpdateCheck()
  const isAdmin = session.data?.isAdmin === true

  return (
    <>
      {/* Plain text, not a link. There is nothing in this app to navigate to about a version, and
          the changelog below already goes where a reader who wants to know what changed is going.
          Selectable, because the first thing anybody does with a version is paste it into an
          issue. */}
      <p className="about-version">{t('settings.about.version', { version: APP_VERSION })}</p>
      {/* Nothing at all until the query answers. The alternative - saying the check is off while
          the answer is still in flight - would flash the wrong one of these five sentences on
          every visit for an instance that has it on. */}
      {status.data !== undefined && (
        <p className="about-update" data-state={updateState(status.data, APP_VERSION)}>
          {t(`settings.about.update.${updateState(status.data, APP_VERSION)}`, { version: status.data.latest ?? '' })}
        </p>
      )}
      {/* The switch is an admin's: this decides whether the instance talks to a third party at
          all, which is a household decision rather than a reader's preference, and the route
          answers 'forbidden' to anybody else. A member sees the sentence above and no control,
          which is the same shape every other admin-gated section on this page takes. */}
      {isAdmin && status.data !== undefined && (
        <label className="about-update-toggle">
          <input type="checkbox" checked={status.data.enabled} disabled={setEnabled.isPending}
                 onChange={(event) => setEnabled.mutate({ enabled: event.currentTarget.checked })} />
          <span>{t('settings.about.update.toggle')}</span>
        </label>
      )}
      {/* Said in full, and said whether or not it is switched on: the whole reason this is a
          setting rather than a feature is that somebody has to be able to decide, and nobody can
          decide against a sentence they only see after saying yes. */}
      {isAdmin && <p className="basis">{t('settings.about.update.sends')}</p>}
      {setEnabled.isError && <p className="form-error" role="alert">{setEnabled.error.message}</p>}
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
    </>
  )
}
