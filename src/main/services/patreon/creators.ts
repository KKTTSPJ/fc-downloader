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
 *    `campaignIdCandidates`, each candidate confirmed against the page with
 *    `campaignMatchesRef`), the way gallery-dl resolves a creator URL.
 *
 * Campaign ids and URLs from these responses become folder names and are
 * opened in the embedded browser, so they are validated here: a campaign id
 * must be all digits, a page URL an https patreon.com page.
 */
import type { Creator } from '@shared/types'
import { isServicePageUrl, safeCreatorPageUrl } from '@shared/creatorUrl'

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

/** A Patreon campaign id: digits only (it becomes a folder name). */
export function isCampaignId(id: unknown): id is string {
  return typeof id === 'string' && /^\d+$/.test(id)
}

/**
 * A campaign resource as a Creator (`supporting` per the caller's source), or
 * null when its id isn't a campaign id. The page URL is kept only when it is an
 * https patreon.com page.
 */
export function campaignToCreator(res: JsonApiResource, supporting: boolean): Creator | null {
  if (!isCampaignId(res.id)) return null
  const a = (res.attributes ?? {}) as CampaignAttributes
  return {
    serviceId: 'patreon',
    creatorId: res.id,
    name: a.name || a.vanity || `campaign-${res.id}`,
    iconUrl: a.avatar_photo_url || undefined,
    pageUrl: safeCreatorPageUrl('patreon', a.url),
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
    const creator = campaignToCreator(r, !free)
    if (creator) out.set(r.id, creator)
  }
  return [...out.values()]
}

/** Campaigns in one home-feed (`/api/stream`) page, as followed creators. */
export function creatorsFromStream(included: JsonApiResource[] | undefined): Creator[] {
  return (included ?? [])
    .filter((r) => r.type === 'campaign')
    .map((r) => campaignToCreator(r, false))
    .filter((c): c is Creator => c !== null)
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
  /** A creator page: fetch `url` and confirm the campaign by `vanity` (a
   *  `/<vanity>` page) or `userId` (a `/user?u=<id>` page). */
  | { kind: 'page'; url: string; vanity?: string; userId?: string }

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
  'join',
  'profile',
  'user',
  'pricing',
  'about',
  'apps',
  'blog',
  'help',
  'privacy',
  'terms',
  'legal',
  'features',
  'product'
])

/**
 * Classify a Patreon URL: a campaign id in the query, a post (`/posts/<slug>`
 * ending in its id), or a creator page (`/<vanity>`, `/c/<vanity>`,
 * `/cw/<vanity>`, `/user?u=<id>`) whose HTML holds the campaign id. Null for
 * anything else (other sites, the home feed, settings, ...).
 */
export function parseCreatorRef(pageUrl: string): CreatorRef | null {
  if (!isServicePageUrl('patreon', pageUrl.trim())) return null
  const u = new URL(pageUrl.trim())

  const cid = u.searchParams.get('c') ?? u.searchParams.get('campaign_id')
  if (cid && /^\d+$/.test(cid)) return { kind: 'campaign', campaignId: cid }

  const segs = u.pathname.split('/').filter(Boolean)
  if (segs[0] === 'posts') {
    const m = /(\d+)$/.exec(segs[1] ?? '')
    return m ? { kind: 'post', postId: m[1] } : null
  }
  const userId = u.searchParams.get('u')
  if (segs[0] === 'user' || segs[0] === 'profile') {
    return userId && /^\d+$/.test(userId)
      ? { kind: 'page', url: `${ORIGIN}/user?u=${userId}`, userId }
      : null
  }
  const vanity = segs[0] === 'c' || segs[0] === 'cw' ? segs[1] : segs[0]
  if (!vanity || RESERVED.has(vanity.toLowerCase())) return null
  if (!/^[\w.-]+$/.test(vanity)) return null
  return { kind: 'page', url: `${ORIGIN}/${vanity}`, vanity }
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

/** Most campaign ids taken from one page (each costs a confirming request). */
const MAX_CANDIDATES = 3

/**
 * Campaign ids found in a creator page's HTML, most trustworthy first and
 * de-duplicated, tried in the orders gallery-dl and AtelierMisaka use across
 * Patreon's page generations:
 *  1. Next.js `__NEXT_DATA__` → props.pageProps.bootstrapEnvelope
 *     .(pageBootstrap|bootstrap).campaign.data.id
 *  2. `"campaign":{"data":{"id":"<n>"` fragments (plain or JSON-escaped, as in
 *     the streamed Next.js payload)
 *  3. `https://www.patreon.com/api/campaigns/<n>` self links
 * Text matches can come from anywhere on the page (a post title, another
 * creator), so every candidate must be confirmed with `campaignMatchesRef`.
 */
export function campaignIdCandidates(html: string): string[] {
  const out: string[] = []
  const add = (id: unknown): void => {
    if (isCampaignId(id) && !out.includes(id)) out.push(id)
  }
  const next = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)
  if (next) {
    try {
      const data: unknown = JSON.parse(next[1])
      const env = dig(data, ['props', 'pageProps', 'bootstrapEnvelope'])
      for (const key of ['pageBootstrap', 'bootstrap'])
        add(dig(env, [key, 'campaign', 'data', 'id']))
    } catch {
      /* fall through to the text patterns */
    }
  }
  const q = String.raw`\\*"`
  const frag = new RegExp(
    `${q}campaign${q}\\s*:\\s*\\{\\s*${q}data${q}\\s*:\\s*\\{\\s*${q}id${q}\\s*:\\s*${q}(\\d+)`,
    'g'
  )
  for (const m of html.matchAll(frag)) add(m[1])
  for (const m of html.matchAll(/patreon\.com\/api\/campaigns\/(\d+)/g)) add(m[1])
  return out.slice(0, MAX_CANDIDATES)
}

/** The vanity a patreon.com page URL names (`/<v>`, `/c/<v>`, `/cw/<v>`). */
function vanityOf(url: unknown): string | undefined {
  if (typeof url !== 'string' || !isServicePageUrl('patreon', url)) return undefined
  const segs = new URL(url).pathname.split('/').filter(Boolean)
  return (segs[0] === 'c' || segs[0] === 'cw' ? segs[1] : segs[0])?.toLowerCase()
}

/**
 * Whether a campaign (from `/api/campaigns/<id>?include=creator`) belongs to
 * the creator page the user is on: the page's vanity equals the campaign's (or
 * its creator's) vanity or its page URL's, or the page's `?u=` user id is the
 * campaign's creator. Rejects a campaign id that merely appeared on the page.
 */
export function campaignMatchesRef(
  campaign: JsonApiResource,
  included: JsonApiResource[] | undefined,
  ref: { vanity?: string; userId?: string }
): boolean {
  const a = (campaign.attributes ?? {}) as CampaignAttributes
  const creatorId = linkedIds(campaign, 'creator')[0]
  const creator = included?.find((r) => r.type === 'user' && r.id === creatorId)
  if (ref.userId) {
    if (creatorId === ref.userId) return true
    try {
      return !!a.url && new URL(a.url).searchParams.get('u') === ref.userId
    } catch {
      return false
    }
  }
  const want = ref.vanity?.toLowerCase()
  if (!want) return false
  const names = [
    a.vanity,
    (creator?.attributes as { vanity?: string } | undefined)?.vanity,
    vanityOf(a.url),
    vanityOf((creator?.attributes as { url?: string } | undefined)?.url)
  ]
  return names.some((n) => typeof n === 'string' && n.toLowerCase() === want)
}
