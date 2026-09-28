// The Android app opens web pages behind its glance in a WebView that shares the app's own
// session, and says so in its user agent (` HaelanAndroid/<version>`, WebPagePolicy.userAgent in
// apps/android). Signing out there would sign the whole app out, so the web app leaves its Sign
// out out of the page; the app signs out from its own sync screen, and refuses the route itself
// if anything calls it anyway. Shell reads the same answer to leave its rail and phone header out,
// since the app's own bar is already the page's header there.
export function isInAndroidApp(userAgent: string | undefined = typeof navigator === 'undefined' ? undefined : navigator.userAgent): boolean {
  return userAgent?.includes('HaelanAndroid/') ?? false
}
