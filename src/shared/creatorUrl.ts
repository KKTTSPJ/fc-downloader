/**
 * Checks for creator values that come from a site's API or from saved
 * settings, before they are used as folder names or opened in the embedded
 * browser. Shared by both processes — keep it free of Node/Electron/DOM imports.
 */
import type { ServiceId } from './types'

/** Hosts a service's creator pages may live on. */
const CREATOR_PAGE_HOSTS: Partial<Record<ServiceId, readonly string[]>> = {
  patreon: ['patreon.com', 'www.patreon.com']
}

/** Whether `url` is an https page on one of the service's own hosts. */
export function isServicePageUrl(serviceId: ServiceId, url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  return u.protocol === 'https:' && (CREATOR_PAGE_HOSTS[serviceId] ?? []).includes(u.hostname)
}

/** `url` when it is safe to open as the service's creator page, else undefined. */
export function safeCreatorPageUrl(
  serviceId: ServiceId,
  url: string | undefined
): string | undefined {
  return url && isServicePageUrl(serviceId, url) ? url : undefined
}

/**
 * Whether a creator id is safe to use as a folder name: non-empty, only
 * letters, digits, `_` and `-` (so never `.`/`..`, a separator, or a character
 * a file system rejects).
 */
export function isSafeCreatorId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id)
}
