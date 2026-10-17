/**
 * A service's creator list = what its own listing finds + the creators the user
 * added from a creator page (`AppSettings.addedCreators`). Every caller that
 * needs "the user's creators" (the creator list, a download run's names, avatar
 * backfill) goes through here so an added creator behaves like a listed one.
 */
import type { Creator, ServiceId } from '@shared/types'
import { getSettings, updateSettings } from '@main/storage/settings'
import { isSafeCreatorId, safeCreatorPageUrl } from '@shared/creatorUrl'
import type { Service, ServiceContext } from './types'

/**
 * An added creator as it may be used: the id becomes a folder name and the page
 * URL is opened in the embedded browser, and both may come from a hand-edited
 * settings file — so an unsafe id drops the creator and a page URL off the
 * service's own https site is dropped.
 */
function sanitizeAdded(c: Creator): Creator | null {
  if (!isSafeCreatorId(c?.creatorId)) return null
  return { ...c, pageUrl: safeCreatorPageUrl(c.serviceId, c.pageUrl) }
}

/**
 * Append the added creators the listing didn't return. A creator the listing
 * also found keeps the listing's entry (fresher name/icon, real tier), so an
 * added creator the user later supports simply stops being "added".
 */
export function mergeAddedCreators(listed: Creator[], added: Creator[] | undefined): Creator[] {
  const seen = new Set(listed.map((c) => c.creatorId))
  const extra = (Array.isArray(added) ? added : [])
    .map(sanitizeAdded)
    .filter((c): c is Creator => c !== null && !seen.has(c.creatorId))
    .map((c) => ({ ...c, added: true }))
  return [...listed, ...extra]
}

function addedFor(serviceId: ServiceId): Creator[] {
  try {
    return getSettings().addedCreators?.[serviceId] ?? []
  } catch {
    return [] // settings not initialized (e.g. unit tests): nothing added
  }
}

/** The service's own listing merged with the user's added creators. */
export async function listCreatorsWithAdded(
  service: Service,
  ctx: ServiceContext
): Promise<Creator[]> {
  return mergeAddedCreators(await service.listCreators(ctx), addedFor(service.id))
}

/** Store (or refresh) an added creator. An unsafe id is not stored. */
export function saveAddedCreator(creator: Creator): void {
  const stored = sanitizeAdded(creator)
  if (!stored) return
  delete stored.added // derived on merge, not stored
  const all = getSettings().addedCreators ?? {}
  const list = (all[stored.serviceId] ?? []).filter((c) => c.creatorId !== stored.creatorId)
  updateSettings({ addedCreators: { ...all, [stored.serviceId]: [...list, stored] } })
}

/** Forget an added creator (no-op for a creator the listing finds itself). */
export function removeAddedCreator(serviceId: ServiceId, creatorId: string): void {
  const all = getSettings().addedCreators ?? {}
  const list = all[serviceId] ?? []
  if (!list.some((c) => c.creatorId === creatorId)) return
  updateSettings({
    addedCreators: { ...all, [serviceId]: list.filter((c) => c.creatorId !== creatorId) }
  })
}
