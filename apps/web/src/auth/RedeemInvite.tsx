import { useState } from 'react'
import type { FormEvent } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { apiGet, apiSend } from '../api/client.js'
import { useTranslation } from '../i18n/index.js'
import { BrandMark } from '../components/BrandMark.js'

interface InviteInfo { displayName: string, timezone: string }
interface RedeemResult { personId: string, username: string }

// This shape is declared once, by value, the same choice useMembers.ts documents for MemberRow:
// it mirrors GET /api/invite/:token (apps/server/src/routes/invite.ts) exactly, and apps/web never
// imports @haelan/core's root export in shipped code, so there is nothing to import even in
// principle.
export function inviteInfoKey(token: string): readonly unknown[] {
  return ['invite', token]
}

/**
 * The screen a one-time invite link opens. It never asks Shell.tsx anything about the session:
 * whoever holds this link has no account yet, or has an account and is holding a stale link by
 * mistake, and either way the token in the URL, not the session, is what decides what renders
 * here. See Shell.tsx's own comment on why this stays out of routes.tsx.
 */
export function RedeemInvite({ token, onJoined }: { token: string, onJoined: () => void }) {
  const { t } = useTranslation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  // T6.1: whoever is invited names their own path while redeeming instead of inheriting
  // the admin's. Google is the default because it writes nothing, exactly what redeeming
  // without this screen always did; picking the phone sends path companion, which is what
  // records people.companion_path on their own row and nothing else.
  const [path, setPath] = useState<'google' | 'companion'>('google')

  const invite = useQuery({
    queryKey: inviteInfoKey(token),
    queryFn: () => apiGet<InviteInfo>(`/api/invite/${encodeURIComponent(token)}`),
    // A revoked, expired or already-redeemed invite does not become valid on a second try, and
    // retrying an unreachable instance only delays the one message this screen has for either case.
    retry: false,
  })

  // A mutation rather than a bare apiSend call, the same choice useMembers.ts and
  // useAnnotations.ts make for every write in this app: it is what lets a submit register on
  // queryClient.isMutating() the instant the click happens, which is what flush() in the test
  // suite watches for to know a page is still doing something.
  const redeem = useMutation({
    mutationFn: () => apiSend<RedeemResult>('POST', `/api/invite/${encodeURIComponent(token)}`, { username, password, path }),
    onSuccess: onJoined,
    retry: false,
  })

  // Every way GET /api/invite/:token can fail to resolve - unknown, expired, revoked, already
  // redeemed, or the instance not answering at all - collapses into the one sentence below, the
  // same choice invite.ts's own `notFound` makes for its 404 body: a link that once worked and a
  // link that never existed have to read identically, or this screen becomes a way to probe which
  // tokens were ever issued.
  if (invite.error !== null) {
    return (
      <main className="signin">
        <div className="card">
          <BrandMark />
          <p>{t('invite.invalid')}</p>
        </div>
      </main>
    )
  }

  if (invite.data === undefined) return null

  return (
    <main className="signin">
      <form className="card" onSubmit={(event: FormEvent) => { event.preventDefault(); redeem.mutate() }}>
        <BrandMark />
        <h1>{t('invite.joinAs', { name: invite.data.displayName })}</h1>
        <p>{t('invite.explain')}</p>

        {redeem.isError && (
          // A taken username and a password under eight characters both answer 400 from the same
          // route, and the invite stays usable either way (invite.ts's own comment on why create
          // runs before markRedeemed) - so one message here, rather than one per cause, is what
          // lets the member just try again on the same link instead of being told which half was
          // wrong.
          <p className="form-error" role="alert">{t('invite.failed')}</p>
        )}

        <label className="field">
          <span className="label">{t('invite.username')}</span>
          <input className="input" autoComplete="username" value={username}
            onChange={(e) => setUsername(e.target.value)} />
        </label>

        <label className="field">
          <span className="label">{t('invite.password')}</span>
          <input className="input" type="password" autoComplete="new-password" value={password}
            onChange={(e) => setPassword(e.target.value)} />
        </label>

        <fieldset className="field">
          <legend className="label">{t('invite.pathTitle')}</legend>
          <label>
            <input type="radio" name="path" value="google" checked={path === 'google'}
              onChange={() => setPath('google')} />
            {t('invite.pathGoogle')}
          </label>
          <label>
            <input type="radio" name="path" value="companion" checked={path === 'companion'}
              onChange={() => setPath('companion')} />
            {t('invite.pathCompanion')}
          </label>
        </fieldset>

        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={redeem.isPending}>
            {t('invite.submit')}
          </button>
        </div>
      </form>
    </main>
  )
}
