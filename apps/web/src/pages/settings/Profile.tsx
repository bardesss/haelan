import { useState } from 'react'
import type { FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from '../../i18n/index.js'
import { useSession } from '../../auth/session.js'
import { ErrorState } from '../../components/ErrorState.js'
import { Loading } from '../../components/Loading.js'
import { queryKeys } from '../../api/queryKeys.js'
import { useChangePassword, useSaveProfile } from '../../data/useProfile.js'
import type { ProfileEdit } from '../../data/useProfile.js'

// The third copy of this, and still not a shared module, for the reason Members.tsx gave when it
// held the second: there is no timezone module in this app, only Intl, and a helper extracted to
// be shared by three screens that do not otherwise know about each other buys nothing but an
// import. Offered as a datalist rather than a select for AccountStep.tsx's own reason - the list
// is several hundred long and typing three letters of your own city beats scrolling to it.
function timezoneOptions(): string[] {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
  try {
    return supported ? supported('timeZone') : []
  } catch {
    return []
  }
}

/**
 * The caller's own account: the name on their pages, the name they sign in with, the zone their
 * days are measured in, and their password.
 *
 * Not admin gated, unlike every other section below it on this page. Those change the instance;
 * this changes the person reading it, and the two routes behind it act on the account their own
 * session resolves to rather than on one named in the request, so there is nothing here an admin
 * would be needed for and nothing a member could reach that is not theirs.
 *
 * The timezone warning is the point of the panel rather than decoration on it. Day boundaries are
 * computed per person, and `daily` is keyed by the local date the old zone produced, so moving
 * this column files every derived row under a day that is no longer theirs until a rebuild from
 * the archive replays them. That is minutes of work and it happens at the next start, so it is
 * said before the button rather than reported after it.
 */
export function Profile() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const session = useSession()
  const save = useSaveProfile()
  const password = useChangePassword()

  // Null until the reader types, so all three fields follow the session through a save and its
  // invalidation with no second effect pushing values back into state. The same device
  // InstanceUrl.tsx uses, one object instead of one string: a draft of '' is a field deliberately
  // cleared and must not read as untouched.
  const [draft, setDraft] = useState<ProfileEdit | null>(null)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')

  if (session.isPending) return <Loading />
  if (session.isError || session.data === undefined) {
    return (
      <ErrorState onRetry={() => {
        void queryClient.refetchQueries({ queryKey: queryKeys.session(), exact: true })
      }} error={session.error} />
    )
  }

  const current: ProfileEdit = {
    displayName: session.data.displayName,
    username: session.data.username,
    timezone: session.data.timezone,
    birthDate: session.data.birthDate,
    sex: session.data.sex,
  }
  const value = draft ?? current
  const edit = (patch: Partial<ProfileEdit>): void => setDraft({ ...value, ...patch })

  // Compared against what is stored, not against whether the field was touched, because that is
  // the same comparison the route makes before it marks anything for a rebuild. A zone typed back
  // to what it already was costs nothing and must not be warned about.
  const zoneWouldMove = value.timezone !== current.timezone
  const changed = value.displayName !== current.displayName
    || value.username !== current.username
    || zoneWouldMove
    || value.birthDate !== current.birthDate
    || value.sex !== current.sex

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    save.mutate(value, { onSuccess: () => setDraft(null) })
  }

  const submitPassword = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    password.mutate({ currentPassword, newPassword }, {
      onSuccess: () => {
        setCurrentPassword('')
        setNewPassword('')
      },
    })
  }

  return (
    <div className="profile">
      <form onSubmit={submit}>
        <label className="field">
          <span className="label">{t('settings.profile.displayName')}</span>
          <input className="input" value={value.displayName} required
            onChange={(e) => edit({ displayName: e.currentTarget.value })} />
          <span className="field-hint">{t('settings.profile.displayNameHint')}</span>
        </label>

        <label className="field">
          <span className="label">{t('settings.profile.username')}</span>
          <input className="input" value={value.username} required autoComplete="username"
            onChange={(e) => edit({ username: e.currentTarget.value })} />
          <span className="field-hint">{t('settings.profile.usernameHint')}</span>
        </label>

        <label className="field">
          <span className="label">{t('settings.profile.timezone')}</span>
          <input className="input" value={value.timezone} list="haelan-profile-timezones" required
            onChange={(e) => edit({ timezone: e.currentTarget.value })} />
          <datalist id="haelan-profile-timezones">
            {timezoneOptions().map((zone) => <option key={zone} value={zone} />)}
          </datalist>
          <span className="field-hint">{t('settings.profile.timezoneHint')}</span>
        </label>

        {/* Only while the zone is actually different, and role="alert" rather than a quiet caption:
            this is the one instruction on the panel whose cost is paid by somebody who did not
            read it, and showing it permanently is how it stops being read. */}
        {zoneWouldMove && (
          <p className="profile-warning" role="alert">{t('settings.profile.timezoneWarning')}</p>
        )}

        {/* No rebuild warning on either control below, unlike the timezone one above: both are
            read only by the cardio load calculation, computed at read time, so nothing derived
            goes stale when either changes. Both are clearable back to an empty value - an
            explicit `null` in the draft, not the absent field the other three controls send. */}
        <label className="field">
          <span className="label">{t('settings.profile.birthDate')}</span>
          <input className="input" type="date" value={value.birthDate ?? ''}
            onChange={(e) => edit({ birthDate: e.currentTarget.value === '' ? null : e.currentTarget.value })} />
        </label>

        <label className="field">
          <span className="label">{t('settings.profile.sex')}</span>
          <select className="input" value={value.sex ?? ''}
            onChange={(e) => edit({ sex: e.currentTarget.value === '' ? null : e.currentTarget.value as 'male' | 'female' })}>
            <option value="">{t('settings.profile.sexUnset')}</option>
            <option value="male">{t('settings.profile.sexMale')}</option>
            <option value="female">{t('settings.profile.sexFemale')}</option>
          </select>
        </label>

        {/* This sentence is the reason the two controls above are allowed to exist at all: a
            health app asking for a birthday and a sex without saying why is worse than the
            feature it is collected for is worth. */}
        <p className="field-hint">{t('settings.profile.cardioLoadHelp')}</p>

        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={save.isPending || !changed}>
            {save.isPending ? t('settings.profile.saving') : t('settings.profile.save')}
          </button>
        </div>
      </form>

      {/* The server's own sentence, not one of this panel's: a refused username comes back naming
          the name that is taken, and replacing that with "that did not work" would throw away the
          only part telling the reader what to type instead. Same choice InstanceUrl.tsx makes. */}
      {save.isError && (
        <p className="field-error" role="alert">{t('settings.profile.failed', { reason: save.error.message })}</p>
      )}
      {save.isSuccess && !save.isPending && (
        <p className="profile-result" role="status">
          {save.data.rebuildPending ? t('settings.profile.savedRebuild') : t('settings.profile.saved')}
        </p>
      )}

      {/* A rule above it, not only a heading: read as one panel, these two forms look like one
          save button and a stray second one, and somebody who types a password beside their name
          and presses the top button sends half of what they filled in and is told it saved. The
          boundary is the same one .member-row and .session-row separate a list with. */}
      <form className="profile-password" onSubmit={submitPassword}>
        <h3 className="profile-subhead">{t('settings.profile.password.title')}</h3>
        <label className="field">
          <span className="label">{t('settings.profile.password.current')}</span>
          <input className="input" type="password" value={currentPassword} required autoComplete="current-password"
            onChange={(e) => setCurrentPassword(e.currentTarget.value)} />
          <span className="field-hint">{t('settings.profile.password.currentHint')}</span>
        </label>
        <label className="field">
          <span className="label">{t('settings.profile.password.new')}</span>
          <input className="input" type="password" value={newPassword} required autoComplete="new-password"
            onChange={(e) => setNewPassword(e.currentTarget.value)} />
          <span className="field-hint">{t('settings.profile.password.newHint')}</span>
        </label>
        <div className="form-actions">
          <button type="submit" className="button" disabled={password.isPending}>
            {password.isPending ? t('settings.profile.password.submitting') : t('settings.profile.password.submit')}
          </button>
        </div>
      </form>

      {/* One refusal gets its own sentence rather than the server's. 'forbidden' on this route
          means exactly one thing - the current password was wrong - and it is the refusal a reader
          will actually meet, so it is worth saying in their own language. Everything else falls
          back to what the instance said. */}
      {password.isError && (
        <p className="field-error" role="alert">
          {password.error.kind === 'forbidden'
            ? t('settings.profile.password.wrong')
            : t('settings.profile.password.failed', { reason: password.error.message })}
        </p>
      )}
      {password.isSuccess && !password.isPending && (
        <p className="profile-result" role="status">{t('settings.profile.password.changed')}</p>
      )}

      {/* The only place in the app that says the companion app exists. The wizard's companion step
          is seen once, by whoever set the instance up, so a member who joined by invite and an
          admin who took the Google path and later wants a phone have both never met it.

          Unconditional on purpose. Hiding it once a phone has sent something would tidy it away
          from the person who most needs it next: whoever is replacing a lost phone, or adding a
          second one, on the day that happens.

          The address comes off the session rather than the admin-only instance-url route, because
          every member needs it and only an admin can read that one. The Android-only sentence is
          first because it is the one fact that makes the four steps below irrelevant. */}
      <section className="profile-phone">
        <h3 className="profile-subhead">{t('settings.profile.phone.title')}</h3>
        <p className="field-hint">{t('settings.profile.phone.intro')}</p>
        <ol className="profile-phone-steps">
          <li>
            {t('settings.profile.phone.step1')}{' '}
            <a href="https://github.com/bardesss/haelan#the-android-companion-app"
              target="_blank" rel="noreferrer noopener">
              {t('settings.profile.phone.step1Link')}
            </a>
          </li>
          <li>{t('settings.profile.phone.step2')}</li>
          <li>
            {t('settings.profile.phone.step3')}{' '}
            <code className="copy-value">{session.data.baseUrl}</code>
          </li>
          <li>{t('settings.profile.phone.step4')}</li>
        </ol>
      </section>
    </div>
  )
}
