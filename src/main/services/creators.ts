/**
 * A service's creator list = what its own listing finds + the creators the user
 * added from a creator page (`AppSettings.addedCreators`). Every caller that
 * needs "the user's creators" (the creator list, a download run's names, avatar
 * backfill) goes through here so an added creator behaves like a listed one.
 */
import type { Creator, ServiceId } from '@shared/types'
import { getSettings, updateSettings } from '@main/storage/settings'
import type { Service, ServiceContext } from './types'

/**
 * Append the added creators the listing didn't return. A creator the listing
 * also found keeps the listing's entry (fresher name/icon, real tier), so an
 * added creator the user later supports simply stops being "added".
 */
export function mergeAddedCreators(listed: Creator[], added: Creator[] | undefined): Creator[] {
  const seen = new Set(listed.map((c) => c.creatorId))
  const extra = (added ?? [])
    .filter((c) => !seen.has(c.creatorId))
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

/** Store (or refresh) an added creator. */
export function saveAddedCreator(creator: Creator): void {
  const all = getSettings().addedCreators ?? {}
  const list = (all[creator.serviceId] ?? []).filter((c) => c.creatorId !== creator.creatorId)
  const stored: Creator = { ...creator }
  delete stored.added // derived on merge, not stored
  updateSettings({ addedCreators: { ...all, [creator.serviceId]: [...list, stored] } })
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
