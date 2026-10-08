/**
 * Which window.open / target=_blank popups from a service <webview> stay inside
 * the app. Kept free of Electron imports so it can be unit-tested.
 *
 * Sign-in buttons such as Patreon's "Continue with Google" open the identity
 * provider in a popup and hand the result back to the opener page
 * (window.opener / postMessage). Sent to the system browser, that sign-in lands
 * in the wrong cookie jar and never reaches the app, so those popups open in an
 * in-app window on the service's own session. A same-site popup stays in-app
 * only when a script opened it as a real popup window (`new-window`, e.g. a
 * sign-in step on the site itself); a same-site target=_blank link — like
 * every other link (a creator's X / social links, etc.) — still opens in the
 * system browser.
 */

/** Identity-provider sign-in hosts whose popups must stay in-app. */
const LOGIN_HOSTS = new Set([
  'accounts.google.com',
  'appleid.apple.com',
  'www.facebook.com',
  'm.facebook.com',
  'discord.com'
])

/** Paths on the general-purpose hosts above that are actually sign-in flows. */
function isLoginPath(host: string, path: string): boolean {
  if (host.endsWith('facebook.com')) return /^\/(v[\d.]+\/)?dialog\/oauth|^\/login/.test(path)
  if (host === 'discord.com') return /^\/(api\/)?oauth2\//.test(path)
  return true
}

/** "www.patreon.com" -> "patreon.com" (last two labels; enough for these sites). */
function siteOf(host: string): string {
  return host.split('.').slice(-2).join('.')
}

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/**
 * Whether a popup the guest page wants to open should stay in an in-app window
 * (`true`) rather than go to the system browser.
 */
export function keepPopupInApp(
  openerUrl: string,
  targetUrl: string,
  /** Electron's window-open disposition: `new-window` for a scripted popup
   *  window, `foreground-tab` etc. for a target=_blank link. */
  disposition: string
): boolean {
  const target = parse(targetUrl)
  if (!target || (target.protocol !== 'https:' && target.protocol !== 'http:')) return false
  const host = target.hostname.toLowerCase()
  if (LOGIN_HOSTS.has(host)) return isLoginPath(host, target.pathname)
  if (disposition !== 'new-window') return false
  const opener = parse(openerUrl)
  return !!opener && siteOf(opener.hostname.toLowerCase()) === siteOf(host)
}
