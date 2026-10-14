/**
 * Pure helpers for finding a user's Patreon creators. Kept separate from the
 * network code so they can be unit-tested.
 *
 * Patreon has no endpoint listing every campaign the user belongs to: the
 * `current_user` pledges cover PAID memberships only, and free memberships
 * (follows) aren't listed anywhere. Free ones are found two ways instead:
 *  - the home feed (`/api/stream?filter[is_following]=true`) carries each
 *    post's campaign, so walking a few pages finds the followed creators that
 *    posted recently;
 *  - the user can add any creator from its page (`parseCreatorRef` +
 *    `extractCampaignId`), the way gallery-dl resolves a creator URL.
 */
import type { Creator } from '@shared/types'

const ORIGIN = 'https://www.patreon.com'

interface Linkage {
  id: string
  type: string
}

/** A JSON:API resource from a response's `included` (or `data`). */
export interface JsonApiResource {
  id: string
  type: string
  attributes?: Record<string, unknown>
  relationships?: Record<string, { data?: Linkage | Linkage[] | null } | undefined>
}

/** VERIFY: subset of a `type: "campaign"` resource. */
interface CampaignAttributes {
  name?: string
  vanity?: string
  url?: string
  avatar_photo_url?: string
}

/** A campaign resource as a Creator (`supporting` per the caller's source). */
export function campaignToCreator(res: JsonApiResource, supporting: boolean): Creator {
  const a = (res.attributes ?? {}) as CampaignAttributes
  return {
    serviceId: 'patreon',
    creatorId: res.id,
    name: a.name || a.vanity || `campaign-${res.id}`,
    iconUrl: a.avatar_photo_url || undefined,
    pageUrl: a.url || undefined,
    supporting
  }
}

function linkedIds(res: JsonApiResource, rel: string): string[] {
  const data = res.relationships?.[rel]?.data
  if (!data) return []
  return (Array.isArray(data) ? data : [data]).map((l) => l.id)
}

/**
 * Campaigns from a `current_user?include=memberships.campaign,pledges.campaign`
 * response. A campaign is paid (支援中) when a pledge points at it; one reached
 * only through a membership is a free membership. (Verified 2026-10: paid
 * creators arrive via pledges; memberships was empty for the test account.)
 */
export function creatorsFromCurrentUser(included: JsonApiResource[] | undefined): Creator[] {
  const items = included ?? []
  const pledged = new Set<string>()
  const memberOnly = new Set<string>()
  for (const r of items) {
    if (r.type === 'pledge') linkedIds(r, 'campaign').forEach((id) => pledged.add(id))
    else if (r.type === 'member') linkedIds(r, 'campaign').forEach((id) => memberOnly.add(id))
  }
  const out = new Map<string, Creator>()
  for (const r of items) {
    if (r.type !== 'campaign' || out.has(r.id)) continue
    // Without pledge/member linkage (fields trimmed away) fall back to "paid":
    // that was the only source before free memberships were looked up.
    const free = memberOnly.has(r.id) && !pledged.has(r.id)
    out.set(r.id, campaignToCreator(r, !free))
  }
  return [...out.values()]
}

/** Campaigns in one home-feed (`/api/stream`) page, as followed creators. */
export function creatorsFromStream(included: JsonApiResource[] | undefined): Creator[] {
  return (included ?? [])
    .filter((r) => r.type === 'campaign')
    .map((r) => campaignToCreator(r, false))
}

/** Merge creator sources in priority order (an earlier entry wins). */
export function mergeCreators(...sources: Creator[][]): Creator[] {
  const out = new Map<string, Creator>()
  for (const list of sources) {
    for (const c of list) if (!out.has(c.creatorId)) out.set(c.creatorId, c)
  }
  return [...out.values()]
}

/** What a Patreon URL tells us about its creator. */
export type CreatorRef =
  | { kind: 'campaign'; campaignId: string }
  | { kind: 'post'; postId: string }
  | { kind: 'page'; url: string }

/** First path segments that are site pages, not creators. */
const RESERVED = new Set([
  'home',
  'create',
  'login',
  'signup',
  'search',
  'messages',
  'notifications',
  'settings',
  'library',
  'explore',
  'policy',
  'api',
  'auth',
  'checkout',
  'join'
])

/**
 * Classify a Patreon URL: a campaign id in the query, a post (`/posts/<slug>`
 * ending in its id), or a creator page (`/<vanity>`, `/c/<vanity>`,
 * `/cw/<vanity>`, `/user?u=<id>`) whose HTML holds the campaign id. Null for
 * anything else (other sites, the home feed, settings, ...).
 */
export function parseCreatorRef(pageUrl: string): CreatorRef | null {
  let u: URL
  try {
    u = new URL(pageUrl.trim())
  } catch {
    return null
  }
  if (!/^https?:$/.test(u.protocol)) return null
  if (u.hostname !== 'patreon.com' && u.hostname !== 'www.patreon.com') return null

  const cid = u.searchParams.get('c') ?? u.searchParams.get('campaign_id')
  if (cid && /^\d+$/.test(cid)) return { kind: 'campaign', campaignId: cid }

  const segs = u.pathname.split('/').filter(Boolean)
  if (segs[0] === 'posts') {
    const m = /(\d+)$/.exec(segs[1] ?? '')
    return m ? { kind: 'post', postId: m[1] } : null
  }
  const userId = u.searchParams.get('u')
  if ((segs[0] === 'user' || segs[0] === 'profile') && userId && /^\d+$/.test(userId)) {
    return { kind: 'page', url: `${ORIGIN}/user?u=${userId}` }
  }
  const vanity = segs[0] === 'c' || segs[0] === 'cw' ? segs[1] : segs[0]
  if (!vanity || RESERVED.has(vanity.toLowerCase()) || segs[0] === 'user') return null
  if (!/^[\w.-]+$/.test(vanity)) return null
  return { kind: 'page', url: `${ORIGIN}/${vanity}` }
}

/** Walk a parsed object path, returning undefined on any missing step. */
function dig(obj: unknown, path: string[]): unknown {
  let cur = obj
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

/**
 * The campaign id embedded in a creator page's HTML, tried in the orders
 * gallery-dl and AtelierMisaka use across Patreon's page generations:
 *  1. Next.js `__NEXT_DATA__` → props.pageProps.bootstrapEnvelope
 *     .(pageBootstrap|bootstrap).campaign.data.id
 *  2. a `"campaign":{"data":{"id":"<n>"` fragment (plain or JSON-escaped, as in
 *     the streamed Next.js payload)
 *  3. a `https://www.patreon.com/api/campaigns/<n>` self link
 */
export function extractCampaignId(html: string): string | null {
  const next = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)
  if (next) {
    try {
      const data: unknown = JSON.parse(next[1])
      const env = dig(data, ['props', 'pageProps', 'bootstrapEnvelope'])
      for (const key of ['pageBootstrap', 'bootstrap']) {
        const id = dig(env, [key, 'campaign', 'data', 'id'])
        if (typeof id === 'string' && /^\d+$/.test(id)) return id
      }
    } catch {
      /* fall through to the text patterns */
    }
  }
  const q = String.raw`\\*"`
  const frag = new RegExp(
    `${q}campaign${q}\\s*:\\s*\\{\\s*${q}data${q}\\s*:\\s*\\{\\s*${q}id${q}\\s*:\\s*${q}(\\d+)`
  ).exec(html)
  if (frag) return frag[1]
  const self = /patreon\.com\/api\/campaigns\/(\d+)/.exec(html)
  return self ? self[1] : null
}
