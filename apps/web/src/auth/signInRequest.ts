import { apiSend, ApiError } from '../api/client.js'

export type SignInResult = { ok: true } | { ok: false, messageKey: 'signIn.failed' | 'signIn.unreachable' }

export async function submitSignIn(input: { username: string, password: string }): Promise<SignInResult> {
  try {
    await apiSend('POST', '/api/auth/login', input)
    return { ok: true }
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'unreachable') {
      return { ok: false, messageKey: 'signIn.unreachable' }
    }
    // Every other answer is "these credentials did not work", said the same way whichever half was
    // wrong: naming the half tells an attacker which usernames exist. This is also where a locked
    // account lands: the server answers status 423, which apiSend's KIND_BY_STATUS does not name,
    // so it falls to kind 'config' and reaches this same branch rather than one of its own. That
    // is a decision, not an oversight: a distinct "this account is locked" message would confirm
    // the username exists, exactly what a rejected login must not do.
    return { ok: false, messageKey: 'signIn.failed' }
  }
}
