/**
 * pixiv FANBOX service adapter.
 *
 * Auth is via the user's interactive login in the embedded WebView; this
 * adapter reuses the resulting `FANBOXSESSID` cookie through ctx.fetchJson.
 * api.fanbox.cc requires an `Origin: https://www.fanbox.cc` header, and the
 * media CDN requires a `Referer` (see `downloadHeaders`).
 *
 * Fanbox has no official public API; the endpoints/shapes below were verified
 * against the live api.fanbox.cc with a logged-in session (2026-06-07) — see
 * scripts/probe-fanbox.cjs and docs/spec/service-abstraction.md.
 */
import type { Creator, Post } from '@shared/types'
import type { RecentPost, Service, ServiceContext } from '../types'
import { maybeInPeriod, periodPosition } from '@shared/period'
import {
  collectDownloadableCreators,
  extractPageItems,
  extractPageUrls,
  extractRawPost,
  normalizePost,
  type FanboxListingItem,
  type RawFollowedCreator,
  type RawSupportingPlan
} from './normalize'

const API = 'https://api.fanbox.cc'
const ORIGIN = 'https://www.fanbox.cc'

/** Headers required by the JSON API (cookies are applied by the session). */
const apiHeaders: Record<string, string> = { Origin: ORIGIN, Referer: `${ORIGIN}/` }

export const fanboxService: Service = {
  id: 'fanbox',
  name: 'pixiv FANBOX',
  homeUrl: `${ORIGIN}/`,
  // Media is served from pximg, which 403s without a fanbox Referer.
  downloadHeaders: { Referer: `${ORIGIN}/` },

  async checkAuth(ctx: ServiceContext): Promise<boolean> {
    try {
      // Verified: returns 200 `{ body: <number> }` when logged in, and HTTP 400
      // `{ error: "general_error" }` otherwise (fetchJson throws on >= 400).
      const res = await ctx.fetchJson<{ body?: unknown }>(`${API}/user.countUnreadMessages`, {
        headers: apiHeaders
      })
      return !!res && Object.prototype.hasOwnProperty.call(res, 'body')
    } catch (err) {
      ctx.log('debug', 'checkAuth failed (treating as logged out)', err)
      return false
    }
  },

  async listCreators(ctx: ServiceContext): Promise<Creator[]> {
    // Downloadable creators come from two sources, merged & de-duped:
    //   1. plan.listSupporting     -> `{ body: { plans: [{ creatorId, user,
    //      ... }] } }` — creators with an active PAID plan. (FANBOX moved this
    //      from a bare `body: [...]` array to `body.plans`; both are handled.)
    //   2. creator.listFollowing   -> `{ body: { creators: [{ creatorId, user,
    //      isSupported, isStopped, ... }] } }` — everyone the user follows.
    // (1) alone misses creators whose paid support was stopped but is still
    // valid until month-end, and creators downgraded to a free plan (now just
    // followed) — those only appear in (2). Each source is fetched
    // independently so one failing still yields the other's creators.
    const supporting = await ctx
      .fetchJson<{ body?: { plans?: RawSupportingPlan[] } | RawSupportingPlan[] }>(
        `${API}/plan.listSupporting`,
        { headers: apiHeaders }
      )
      .then((res) => (Array.isArray(res.body) ? res.body : (res.body?.plans ?? [])))
      .catch((err) => {
        ctx.log('error', 'plan.listSupporting failed', err)
        return [] as RawSupportingPlan[]
      })
    const following = await ctx
      .fetchJson<{ body?: { creators?: RawFollowedCreator[] } | RawFollowedCreator[] }>(
        `${API}/creator.listFollowing`,
        { headers: apiHeaders }
      )
      .then((res) => (Array.isArray(res.body) ? res.body : res.body?.creators ?? []))
      .catch((err) => {
        ctx.log('warn', 'creator.listFollowing failed', err)
        return [] as RawFollowedCreator[]
      })
    return collectDownloadableCreators(supporting, following)
  },

  async *recentPosts(ctx: ServiceContext, maxPages: number): AsyncIterable<RecentPost> {
    // Verified: post.listHome -> `{ body: { items: [{ id, creatorId,
    // publishedDatetime, isRestricted, ... }], nextUrl } }` — the reverse-chron
    // timeline across supported + followed creators. `isRestricted` marks posts
    // the viewer can't access (so they aren't "downloadable new").
    let url: string | null = `${API}/post.listHome?limit=30`
    for (let page = 0; page < maxPages && url; page++) {
      ctx.signal.throwIfAborted()
      let body: { items?: RawHomeItem[]; nextUrl?: string | null }
      try {
        const res = await ctx.fetchJson<{ body?: typeof body }>(url, { headers: apiHeaders })
        body = res.body ?? {}
      } catch (err) {
        ctx.log('warn', 'post.listHome failed', err)
        return
      }
      for (const it of body.items ?? []) {
        if (!it.creatorId || !it.id) continue
        yield { creatorId: it.creatorId, postId: it.id, accessible: !it.isRestricted }
      }
      url = body.nextUrl ?? null
    }
  },

  async *listPosts(ctx: ServiceContext, creatorId: string): AsyncIterable<Post> {
    for await (const items of listingPages(ctx, creatorId)) {
      for (const item of items) {
        ctx.signal.throwIfAborted()
        if (!wanted(ctx, item)) continue
        // Already fully downloaded for this run's kinds? Skip the post.info
        // call and let the engine skip it from the ledger.
        const stub = ctx.completedPostStub?.(creatorId, item.id)
        if (stub) {
          yield stub
          continue
        }
        const post = await fetchPostDetail(ctx, item.id)
        if (post) yield post
      }
    }
  },

  async countPosts(ctx: ServiceContext, creatorId: string): Promise<number> {
    // Walk the listing pages (post summaries) WITHOUT fetching post.info per
    // post, and keep the result so the following listPosts on this context
    // doesn't walk the same pages a second time.
    const pag = await ctx.fetchJson<{ body?: unknown }>(
      `${API}/post.paginateCreator?creatorId=${encodeURIComponent(creatorId)}`,
      { headers: apiHeaders }
    )
    const pageUrls = extractPageUrls(pag.body)
    const items: FanboxListingItem[] = []
    ctx.progress?.(0, pageUrls.length)
    for (const [i, pageUrl] of pageUrls.entries()) {
      ctx.signal.throwIfAborted()
      const page = await ctx.fetchJson<{ body?: unknown }>(pageUrl, {
        headers: apiHeaders
      })
      const pageItems = extractPageItems(page.body)
      items.push(...pageItems)
      ctx.progress?.(i + 1, pageUrls.length)
      if (pastPeriod(ctx, pageItems)) break
    }
    let cache = listingCache.get(ctx)
    if (!cache) listingCache.set(ctx, (cache = new Map()))
    cache.set(creatorId, items)
    // Count only what listPosts will yield (otherwise the bar can't reach the end).
    return items.filter((it) => wanted(ctx, it)).length
  },

  async resolvePost(_ctx: ServiceContext, post: Post): Promise<Post> {
    // listPosts already fetches full detail per post.
    return post
  }
}

/**
 * Listing items collected by countPosts, per context and creator, handed to the
 * next listPosts for that creator (one-shot) instead of re-walking the pages.
 * Keyed by context so each download run starts from a fresh listing.
 */
const listingCache = new WeakMap<ServiceContext, Map<string, FanboxListingItem[]>>()

/**
 * The creator's post summaries, one page at a time. Cursor pagination:
 * post.paginateCreator gives the page URLs, each page a list of summaries.
 * FANBOX moved both bodies from bare arrays into wrapper objects
 * (`{ pageUrls }`, `{ posts }`); extractPageUrls/Items accept both shapes.
 */
async function* listingPages(
  ctx: ServiceContext,
  creatorId: string
): AsyncIterable<FanboxListingItem[]> {
  const cache = listingCache.get(ctx)
  const cached = cache?.get(creatorId)
  if (cached) {
    cache?.delete(creatorId)
    yield cached
    return
  }
  let pageUrls: string[]
  try {
    const pag = await ctx.fetchJson<{ body?: unknown }>(
      `${API}/post.paginateCreator?creatorId=${encodeURIComponent(creatorId)}`,
      { headers: apiHeaders }
    )
    pageUrls = extractPageUrls(pag.body)
  } catch (err) {
    ctx.log('error', `post.paginateCreator failed for ${creatorId}`, err)
    return
  }
  for (const pageUrl of pageUrls) {
    ctx.signal.throwIfAborted()
    try {
      const page = await ctx.fetchJson<{ body?: unknown }>(pageUrl, { headers: apiHeaders })
      const items = extractPageItems(page.body)
      yield items
      if (pastPeriod(ctx, items)) return
    } catch (err) {
      ctx.log('warn', `post.listCreator page failed for ${creatorId}`, err)
    }
  }
}

/**
 * Whether a listed post is worth a post.info fetch: not restricted (the viewer's
 * plan doesn't cover it, so its body is null — nothing to download) and not
 * known to fall outside the run's period.
 */
function wanted(ctx: ServiceContext, item: FanboxListingItem): boolean {
  return item.isRestricted !== true && maybeInPeriod(item.publishedDatetime, ctx.period)
}

/**
 * The listing is newest-first, so once a whole page is older than the period's
 * start, later pages are too: stop paging. A whole page (rather than the first
 * old post) keeps a stray out-of-order entry from ending the walk early.
 */
function pastPeriod(ctx: ServiceContext, items: FanboxListingItem[]): boolean {
  if (ctx.period?.from === undefined || items.length === 0) return false
  return items.every((it) => periodPosition(it.publishedDatetime, ctx.period) === 'before')
}

/** VERIFY: subset of a post.listHome item. */
interface RawHomeItem {
  id: string
  creatorId: string
  publishedDatetime?: string
  isRestricted?: boolean
}

async function fetchPostDetail(ctx: ServiceContext, postId: string): Promise<Post | null> {
  try {
    // post.info -> `{ body: { post: <post> } }` (FANBOX moved the post under
    // `body.post`; extractRawPost also accepts the older `body`-is-the-post form).
    const res = await ctx.fetchJson<{ body?: unknown }>(
      `${API}/post.info?postId=${encodeURIComponent(postId)}`,
      { headers: apiHeaders }
    )
    const raw = extractRawPost(res.body)
    return raw ? normalizePost(raw) : null
  } catch (err) {
    ctx.log('warn', `post.info ${postId} failed`, err)
    return null
  }
}
