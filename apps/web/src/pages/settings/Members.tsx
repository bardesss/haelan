import { useState } from 'react'
import type { FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult } from '@tanstack/react-query'
import type { ApiError } from '../../api/client.js'
import { useSession } from '../../auth/session.js'
import { useTranslation } from '../../i18n/index.js'
import { EmptyState } from '../../components/EmptyState.js'
import { ErrorState } from '../../components/ErrorState.js'
import { Loading } from '../../components/Loading.js'
import {
  membersKey, useDisableMember, useEnableMember, useInviteMember, useMembers, useRevokeInvite,
} from '../../data/useMembers.js'
import type { InviteResult, MemberRow, MemberState } from '../../data/useMembers.js'

// Same reason AccountStep.tsx (the setup wizard's own account step) resolves its own zone list
// rather than importing one: there is no shared timezone module anywhere in this app, only Intl
// itself, and the two screens are otherwise unrelated enough that a shared helper would exist only
// to be shared, not because either screen depends on the other's idea of what a timezone field is.
function timezoneOptions(): string[] {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
  try {
    return supported ? supported('timeZone') : []
  } catch {
    return []
  }
}

// The one formula for turning a bare token into the link a new member actually gets handed. A
// function rather than a component, because both the visible <code> text and the clipboard write
// need the identical string and there is no reason to compute it twice.
function inviteLink(token: string): string {
  return `${window.location.origin}/invite/${token}`
}

type DisableMutation = UseMutationResult<{ state: MemberState }, ApiError, { accountId: string }>
type EnableMutation = UseMutationResult<{ state: MemberState }, ApiError, { accountId: string }>
type RevokeMutation = UseMutationResult<void, ApiError, { inviteId: string }>

/**
 * Every person in the household, the state their account is in, and the one control each row
 * needs: suspend or restore an account, or revoke an invite nobody has redeemed yet. An invited
 * row and an active/disabled row never both apply to the same person (MemberRow.state is one of
 * the three), so a row draws at most one control besides its name and state.
 *
 * Mounted only for an admin -- Settings.tsx's own guard on session.data?.isAdmin -- which is also
 * who the five routes this file calls accept; everyone else already gets 'forbidden' from the
 * server regardless of what renders here.
 */
export function Members() {
  const { t } = useTranslation()
  const session = useSession()
  const queryClient = useQueryClient()
  const query = useMembers()
  const invite = useInviteMember()
  const disable = useDisableMember()
  const enable = useEnableMember()
  const revoke = useRevokeInvite()

  const [showForm, setShowForm] = useState(false)
  // The invite's own answer, held here and nowhere else. POST /api/members is the one and only
  // place a token is ever readable (useMembers.ts's own comment on InviteResult -- the server
  // keeps a hash, never the token), so this stays in local state that vanishes the moment the
  // panel below is closed or this component unmounts, never in a query cache entry a later
  // render, a refetch, or a devtools inspector could read back after the fact.
  const [justInvited, setJustInvited] = useState<InviteResult | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [timezone, setTimezone] = useState('')

  if (query.isPending) return <Loading />
  if (query.isError) {
    return (
      <ErrorState onRetry={() => {
        void queryClient.refetchQueries({ queryKey: membersKey(), exact: true })
      }} />
    )
  }

  const items = query.data.items
  const viewerPersonId = session.data?.personId
  // One inline message for whichever of the four mutations last failed, the same "failed" caption
  // OverrideList and SourceNames each show for their own single mutation. Four controls sharing it
  // is a judgement call rather than the sibling sections' pattern: a household has few members and
  // at most one control is ever mid-flight at a time, so there is nothing for a shared line to
  // misattribute the way it might on a long list.
  const failed = invite.isError || disable.isError || enable.isError || revoke.isError

  const submitInvite = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    invite.mutate({ displayName, timezone }, {
      onSuccess: (result) => {
        setJustInvited(result)
        setShowForm(false)
        setDisplayName('')
        setTimezone('')
      },
    })
  }

  return (
    <div>
      {items.length === 0 ? (
        <EmptyState title={t('settings.members.empty.title')} detail={t('settings.members.empty.detail')} />
      ) : (
        <ul className="member-list">
          {items.map((member) => (
            <MemberRowView
              key={member.personId}
              member={member}
              isSelf={member.personId === viewerPersonId}
              disable={disable}
              enable={enable}
              revoke={revoke}
            />
          ))}
        </ul>
      )}

      {failed && <p className="form-error" role="alert">{t('settings.members.failed')}</p>}

      {justInvited && (
        <div className="invite-link-panel" role="status">
          <div className="copy-field">
            <span className="label">{t('settings.members.linkTitle')}</span>
            <code className="copy-value">{inviteLink(justInvited.token)}</code>
            <button
              type="button"
              className="button"
              onClick={() => { void navigator.clipboard.writeText(inviteLink(justInvited.token)) }}
            >
              {t('settings.members.copy')}
            </button>
          </div>
          {/* The honest consequence of storing only a hash: there is no GET this app could ever
              retry to show this again, so the reader is told that plainly rather than finding out
              the hard way the next time they look for it. */}
          <p className="field-hint">{t('settings.members.linkOnce')}</p>
          <div className="form-actions">
            <button type="button" className="button" onClick={() => setJustInvited(null)}>
              {t('annotate.close')}
            </button>
          </div>
        </div>
      )}

      {!justInvited && (showForm ? (
        <form onSubmit={submitInvite}>
          <label className="field">
            <span className="label">{t('settings.members.displayName')}</span>
            <input className="input" value={displayName} required
              onChange={(e) => setDisplayName(e.currentTarget.value)} />
          </label>
          <label className="field">
            <span className="label">{t('settings.members.timezone')}</span>
            <input className="input" value={timezone} list="haelan-member-timezones" required
              onChange={(e) => setTimezone(e.currentTarget.value)} />
            <datalist id="haelan-member-timezones">
              {timezoneOptions().map((zone) => <option key={zone} value={zone} />)}
            </datalist>
          </label>
          <div className="form-actions">
            <button type="submit" className="button button-primary" disabled={invite.isPending}>
              {t('settings.members.create')}
            </button>
          </div>
        </form>
      ) : (
        <div className="form-actions">
          <button type="button" className="button" onClick={() => setShowForm(true)}>
            {t('settings.members.invite')}
          </button>
        </div>
      ))}
    </div>
  )
}

function MemberRowView({ member, isSelf, disable, enable, revoke }: {
  member: MemberRow
  isSelf: boolean
  disable: DisableMutation
  enable: EnableMutation
  revoke: RevokeMutation
}) {
  const { t } = useTranslation()
  return (
    <li className="member-row">
      <span className="member-name">{member.displayName}</span>
      <span className="member-state" data-state={member.state}>
        {t(`settings.members.state.${member.state}`)}
      </span>
      <div className="member-actions">
        {member.state === 'invited' && member.inviteId !== null && (
          <button type="button" className="button" disabled={revoke.isPending}
            onClick={() => revoke.mutate({ inviteId: member.inviteId! })}>
            {t('settings.members.revoke')}
          </button>
        )}
        {/* The viewer's own row never offers suspend or restore: an admin locking out the only
            other admin session they hold has no way back short of editing the database, the same
            reason the server itself refuses `POST /disable` on the caller's own account. */}
        {!isSelf && member.accountId !== null && member.state === 'active' && (
          <button type="button" className="button" disabled={disable.isPending}
            onClick={() => disable.mutate({ accountId: member.accountId! })}>
            {t('settings.members.suspend')}
          </button>
        )}
        {!isSelf && member.accountId !== null && member.state === 'disabled' && (
          <button type="button" className="button" disabled={enable.isPending}
            onClick={() => enable.mutate({ accountId: member.accountId! })}>
            {t('settings.members.restore')}
          </button>
        )}
      </div>
    </li>
  )
}
