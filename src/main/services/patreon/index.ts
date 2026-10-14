/**
 * Patreon service adapter.
 *
 * Auth is via the user's interactive login in the embedded WebView; this
 * adapter reuses the resulting Patreon session cookies through ctx.fetchJson
 * against the site's internal JSON:API (www.patreon.com/api), the same API the
 * Patreon web client uses. Responses are JSON:API (`application/vnd.api+json`).
 *
 * Verified against the live API with a logged-in session (2026-06-08):
 *   - checkAuth: GET /api/current_user → 200 `{ data: { id, type: "user" } }`.
 *   - the current_user `memberships` / `pledges` relationships exist.
 * Verified by a user (2026-10): paid creators arrive via `pledges`; free
 * memberships appear in neither, but their posts are in the home feed
 * (`/api/stream?filter[is_following]=true`) — see ./creators.ts.
 * The campaign-posts + media enumeration is structured from Patreon's JSON:API
 * but is marked `VERIFY:` until confirmed against an account with an active
 * pledge — see scripts/probe-patreon.cjs and docs/spec/service-abstraction.md.
 */
import type { Creator, Post } from '@shared/types'
import type { Service, ServiceContext } from '../types'
import {
  campaignToCreator,
  creatorsFromCurrentUser,
  creatorsFromStream,
  extractCampaignId,
  mergeCreators,
  parseCreatorRef,
  type JsonApiResource
} from './creators'
import {
  mediaMapFromIncluded,
  normalizePost,
  type RawPatreonMedia,
  type RawPatreonPost
} from './normalize'

const ORIGIN = 'https://www.patreon.com'
const API = `${ORIGIN}/api`

/** JSON:API expects a version param on the internal endpoints. */
const V = 'json-api-version=1.0'

interface JsonApiDoc<T> {
  data?: T
  included?: JsonApiResource[]
  links?: { next?: string | null }
}

const CAMPAIGN_FIELDS = 'fields[campaign]=name,url,avatar_photo_url,vanity'

/**
 * Home-feed pages walked to find followed (free) creators. Each page costs one
 * throttled request; a few pages reach the creators that posted recently.
 */
const STREAM_PAGES = 5

/**
 * Followed creators from the home feed: `/api/stream?filter[is_following]=true`
 * (gallery-dl's "user" extractor) lists posts of every followed creator,
 * newest first, each with its campaign. Verified 2026-10 to include free
 * memberships' recent posts. Best-effort: a failed page ends the walk.
 */
async function followedFromStream(ctx: ServiceContext): Promise<Creator[]> {
  const found: Creator[][] = []
  let url: string | null =
    `${API}/stream?${V}&include=campaign&${CAMPAIGN_FIELDS}&fields[post]=published_at` +
    '&filter[is_following]=true&json-api-use-default-includes=false'
  for (let page = 0; page < STREAM_PAGES && url; page++) {
    ctx.signal.throwIfAborted()
    try {
      const doc: JsonApiDoc<unknown> = await ctx.fetchJson<JsonApiDoc<unknown>>(url)
      found.push(creatorsFromStream(doc.included))
      url = doc.links?.next ?? null
    } catch (err) {
      ctx.log('warn', 'listCreators: home feed page failed', err)
      break
    }
    ctx.progress?.(page + 2, STREAM_PAGES + 1)
  }
  return mergeCreators(...found)
}

export const patreonService: Service = {
  id: 'patreon',
  name: 'Patreon',
  homeUrl: `${ORIGIN}/home`,
  // Media is served from patreonusercontent.com via tokenized URLs; a Patreon
  // Referer keeps parity with the web client.
  downloadHeaders: { Referer: `${ORIGIN}/` },

  async checkAuth(ctx: ServiceContext): Promise<boolean> {
    try {
      // Verified: 200 `{ data: { id, type: "user" } }` when logged in; the
      // endpoint 401s (fetchJson throws) otherwise.
      const res = await ctx.fetchJson<JsonApiDoc<{ id?: string; type?: string }>>(
        `${API}/current_user?${V}`
      )
      return res?.data?.type === 'user' && !!res.data.id
    } catch (err) {
      ctx.log('debug', 'checkAuth failed (treating as logged out)', err)
      return false
    }
  },

  async listCreators(ctx: ServiceContext): Promise<Creator[]> {
    // Paid memberships come from current_user's pledges; free memberships are
    // listed nowhere, so the followed creators that posted recently are picked
    // up from the home feed (others are added by the user from their page —
    // see resolveCreator). Paid entries win over the feed's.
    ctx.progress?.(0, STREAM_PAGES + 1)
    let paid: Creator[] = []
    try {
      const include = 'memberships.campaign,pledges.campaign'
      const res = await ctx.fetchJson<JsonApiDoc<unknown>>(
        `${API}/current_user?${V}&include=${encodeURIComponent(include)}&${CAMPAIGN_FIELDS}`
      )
      paid = creatorsFromCurrentUser(res.included)
    } catch (err) {
      ctx.log('error', 'listCreators: current_user failed', err)
    }
    ctx.progress?.(1, STREAM_PAGES + 1)
    const followed = await followedFromStream(ctx)
    return mergeCreators(paid, followed)
  },

  async resolveCreator(ctx: ServiceContext, pageUrl: string): Promise<Creator | null> {
    const ref = parseCreatorRef(pageUrl)
    if (!ref) return null
    let campaignId: string | null = null
    if (ref.kind === 'campaign') {
      campaignId = ref.campaignId
    } else if (ref.kind === 'post') {
      // A post names its campaign; no HTML scraping needed.
      const res = await ctx.fetchJson<JsonApiDoc<JsonApiResource>>(
        `${API}/posts/${encodeURIComponent(ref.postId)}?${V}` +
          `&include=campaign&${CAMPAIGN_FIELDS}&json-api-use-default-includes=false`
      )
      const link = res.data?.relationships?.campaign?.data
      campaignId =
        (link && !Array.isArray(link) ? link.id : undefined) ??
        res.included?.find((r) => r.type === 'campaign')?.id ??
        null
    } else {
      campaignId = extractCampaignId(await ctx.fetchText(ref.url))
    }
    if (!campaignId) return null
    // Confirm the campaign exists and get its name/avatar/page.
    const res = await ctx.fetchJson<JsonApiDoc<JsonApiResource>>(
      `${API}/campaigns/${encodeURIComponent(campaignId)}?${V}&${CAMPAIGN_FIELDS}` +
        '&json-api-use-default-includes=false'
    )
    if (res.data?.type !== 'campaign') return null
    // Added creators are free memberships unless the listing finds a pledge.
    return campaignToCreator(res.data, false)
  },

  async *listPosts(ctx: ServiceContext, creatorId: string): AsyncIterable<Post> {
    // VERIFY: /api/posts?filter[campaign_id]=... returns a JSON:API page of
    // posts with their media in `included`, cursor-paginated via links.next.
    const include = ['images', 'audio', 'video', 'attachments_media', 'media', 'post_file'].join(
      ','
    )
    const fields = [
      'fields[post]=title,published_at,post_type,url,current_user_can_view',
      'fields[media]=download_url,file_name,mimetype,size_bytes,image_urls'
    ].join('&')
    let nextUrl: string | null =
      `${API}/posts?${V}` +
      `&filter[campaign_id]=${encodeURIComponent(creatorId)}` +
      `&filter[contains_exclusive_posts]=true&sort=-published_at` +
      `&include=${encodeURIComponent(include)}&${fields}&page[count]=20`

    let guard = 0
    while (nextUrl && guard++ < 500) {
      ctx.signal.throwIfAborted()
      let doc: JsonApiDoc<RawPatreonPost[]>
      try {
        doc = await ctx.fetchJson<JsonApiDoc<RawPatreonPost[]>>(nextUrl)
      } catch (err) {
        ctx.log('warn', `posts page failed for campaign ${creatorId}`, err)
        ctx.markIncomplete?.()
        return
      }
      const mediaById: Map<string, RawPatreonMedia> = mediaMapFromIncluded(doc.included)
      for (const raw of doc.data ?? []) {
        ctx.signal.throwIfAborted()
        const post = normalizePost(raw, mediaById, creatorId)
        if (post) yield post
      }
      nextUrl = doc.links?.next ?? null
    }
  },

  async resolvePost(_ctx: ServiceContext, post: Post): Promise<Post> {
    // listPosts already attaches full media from each page's `included`.
    return post
  }
}
