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
import { useResetMemberPassword } from '../../data/useProfile.js'

// The one formula for turning a bare token into the link a new member actually gets handed. A
// function rather than a component, because both the visible <code> text and the clipboard write
// need the identical string and there is no reason to compute it twice.
function inviteLink(token: string): string {
  return `${window.location.origin}/invite/${token}`
}

type DisableMutation = UseMutationResult<{ state: MemberState }, ApiError, { accountId: string }>
type EnableMutation = UseMutationResult<{ state: MemberState }, ApiError, { accountId: string }>
type RevokeMutation = UseMutationResult<void, ApiError, { inviteId: string }>
type ResetMutation = UseMutationResult<void, ApiError, { accountId: string, password: string }>

/**
 * Every person in the household, the state their account is in, and the controls that state
 * allows: suspend or restore an account, revoke an invite nobody has redeemed yet, or - for a
 * revoked or expired invite - nothing at all (MemberRow.state is one of four; 'expired' draws no
 * control, since re-issuing against the row and deleting it are both out of scope here). No two of
 * those four ever apply to the same person.
 *
 * Reset password is the one that does not follow that rule: it sits beside suspend or restore on
 * any row that has an account, because being locked out of a password is orthogonal to being
 * suspended. It is the household's only way back into an account on an instance that sends no
 * mail, short of the console tool in apps/server/src/admin.ts.
 *
 * Mounted only for an admin -- Settings.tsx's own guard on session.data?.isAdmin -- which is also
 * who the six routes this file calls accept; everyone else already gets 'forbidden' from the
 * server regardless of what renders here.
 */
export function Members() {
  const { t, i18n } = useTranslation()
  const session = useSession()
  const queryClient = useQueryClient()
  const query = useMembers()
  const invite = useInviteMember()
  const disable = useDisableMember()
  const enable = useEnableMember()
  const revoke = useRevokeInvite()
  const reset = useResetMemberPassword()

  const [showForm, setShowForm] = useState(false)
  // The invite's own answer, held here and nowhere else. POST /api/members is the one and only
  // place a token is ever readable (useMembers.ts's own comment on InviteResult -- the server
  // keeps a hash, never the token), so this stays in local state that vanishes the moment the
  // panel below is closed or this component unmounts, never in a query cache entry a later
  // render, a refetch, or a devtools inspector could read back after the fact.
  const [justInvited, setJustInvited] = useState<InviteResult | null>(null)
  const [displayName, setDisplayName] = useState('')
  // Which member's reset form is open, by account id, and the password being typed into it. One
  // pair rather than one per row: opening a second closes the first, so there is never a password
  // sitting in state for a row the reader has moved on from.
  const [resetting, setResetting] = useState<string | null>(null)
  const [resetPassword, setResetPassword] = useState('')
  const [resetDone, setResetDone] = useState<string | null>(null)

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
    invite.mutate({ displayName }, {
      onSuccess: (result) => {
        setJustInvited(result)
        setShowForm(false)
        setDisplayName('')
      },
    })
  }

  const submitReset = (event: FormEvent<HTMLFormElement>, member: MemberRow): void => {
    event.preventDefault()
    reset.mutate({ accountId: member.accountId!, password: resetPassword }, {
      onSuccess: () => {
        // Cleared on success and only on success: a password refused for being too short is still
        // in the field, which is where somebody fixing it expects to find it.
        setResetPassword('')
        setResetting(null)
        setResetDone(member.displayName)
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
              reset={reset}
              isResetting={resetting === member.accountId}
              onResetOpen={() => {
                setResetting(member.accountId)
                setResetPassword('')
                setResetDone(null)
                reset.reset()
              }}
              onResetCancel={() => { setResetting(null); setResetPassword('') }}
              password={resetPassword}
              onPasswordChange={setResetPassword}
              onSubmitReset={(event) => submitReset(event, member)}
            />
          ))}
        </ul>
      )}

      {failed && <p className="form-error" role="alert">{t('settings.members.failed')}</p>}

      {/* The server's own sentence rather than the shared caption above: the one refusal a reader
          will actually meet here is a password under the length floor, and the message names the
          floor. */}
      {reset.isError && (
        <p className="field-error" role="alert">{t('settings.members.resetFailed', { reason: reset.error.message })}</p>
      )}
      {resetDone !== null && (
        <p className="member-reset-result" role="status">{t('settings.members.resetDone', { name: resetDone })}</p>
      )}

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
          {/* INVITE_TTL_MS is why this exists at all (packages/core/src/store/invites.ts's own
              comment): a constant the copy has to state, not a number the reader would otherwise
              have to guess at. Same formatting OverrideList.tsx uses for a stored instant. */}
          <p className="field-hint">
            {t('settings.members.expiresOn', {
              date: new Date(justInvited.expiresAtMs).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
            })}
          </p>
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
          {/* One field. The timezone the invited person lands in is the inviting admin's own
              (apps/server/src/routes/members.ts), because an admin guessing somebody else's day
              boundary and nobody being able to correct it afterwards was the worse of the two. */}
          <span className="field-hint">{t('settings.members.timezoneInherited')}</span>
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

function MemberRowView({
  member, isSelf, disable, enable, revoke, reset,
  isResetting, onResetOpen, onResetCancel, password, onPasswordChange, onSubmitReset,
}: {
  member: MemberRow
  isSelf: boolean
  disable: DisableMutation
  enable: EnableMutation
  revoke: RevokeMutation
  reset: ResetMutation
  isResetting: boolean
  onResetOpen: () => void
  onResetCancel: () => void
  password: string
  onPasswordChange: (value: string) => void
  onSubmitReset: (event: FormEvent<HTMLFormElement>) => void
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
        {/* Not on the viewer's own row: an admin changing their own password has the Profile card
            above, which asks for the current one. Reaching their own account through the reset
            door instead would quietly make that question optional for the one person who can open
            it. A suspended member is offered it too - somebody restored tomorrow may well have
            forgotten their password today, and the two states answer different questions. */}
        {!isSelf && member.accountId !== null && member.state !== 'invited' && member.state !== 'expired' && !isResetting && (
          <button type="button" className="button" onClick={onResetOpen}>
            {t('settings.members.reset')}
          </button>
        )}
      </div>
      {isResetting && (
        <form className="member-reset" onSubmit={onSubmitReset}>
          <label className="field">
            <span className="label">{t('settings.members.resetLabel', { name: member.displayName })}</span>
            {/* type="password" even though nothing is being hidden from the admin typing it: what
                it keeps out of view is the shoulder of the member standing beside them, who is
                about to be told this password and should hear it rather than read it off a screen
                and never change it. */}
            <input className="input" type="password" value={password} required autoComplete="new-password"
              onChange={(e) => onPasswordChange(e.currentTarget.value)} />
            <span className="field-hint">{t('settings.members.resetHint')}</span>
          </label>
          <div className="form-actions">
            <button type="submit" className="button button-primary" disabled={reset.isPending}>
              {t('settings.members.resetSubmit')}
            </button>
            <button type="button" className="button" onClick={onResetCancel}>
              {t('annotate.close')}
            </button>
          </div>
        </form>
      )}
    </li>
  )
}
