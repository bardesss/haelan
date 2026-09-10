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
    // wrong: naming the half tells an attacker which usernames exist. A locked account lands here
    // too, and deliberately: the server answers 423 with kind 'unauthorized', so it arrives
    // indistinguishable from a wrong password and reaches this same branch rather than one of its
    // own. **Do not give it a branch of its own.** A distinct "this account is locked" message
    // would confirm the username exists, which is exactly what a rejected login must not do - and
    // the kind is no longer what stands between here and that mistake, since M5e-1 made every
    // route declare one. Only the absence of a branch does.
    return { ok: false, messageKey: 'signIn.failed' }
  }
}
