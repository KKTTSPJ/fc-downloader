import { describe, expect, it } from 'vitest'
import type { Post } from '@shared/types'
import type { ServiceContext } from '../types'
import type { PeriodMs } from '@shared/period'
import { fanboxService } from './index'

const API = 'https://api.fanbox.cc'
const PAGE1 = `${API}/post.listCreator?creatorId=c1&page=1`
const PAGE2 = `${API}/post.listCreator?creatorId=c1&page=2`

/** Fake context serving a synthetic two-page listing; records every URL hit. */
function fakeCtx(opts: { completed?: string[]; period?: PeriodMs } = {}): {
  ctx: ServiceContext
  hits: string[]
} {
  const hits: string[] = []
  const routes: Record<string, unknown> = {
    [`${API}/post.paginateCreator?creatorId=c1`]: { body: { pageUrls: [PAGE1, PAGE2] } },
    [PAGE1]: {
      body: {
        posts: [
          { id: '101', isRestricted: false, publishedDatetime: '2025-03-01T00:00:00+09:00' },
          { id: '102', isRestricted: true, publishedDatetime: '2025-02-01T00:00:00+09:00' }
        ]
      }
    },
    [PAGE2]: { body: { posts: [{ id: '103', publishedDatetime: '2025-01-01T00:00:00+09:00' }] } }
  }
  for (const id of ['101', '102', '103']) {
    routes[`${API}/post.info?postId=${id}`] = {
      body: {
        post: {
          id,
          title: `post ${id}`,
          creatorId: 'c1',
          publishedDatetime: '2025-01-01T00:00:00+09:00',
          type: 'image',
          body:
            id === '102'
              ? null
              : {
                  images: [
                    {
                      id: `img${id}`,
                      extension: 'png',
                      originalUrl: `https://example.invalid/${id}.png`
                    }
                  ]
                }
        }
      }
    }
  }
  const ctx: ServiceContext = {
    signal: new AbortController().signal,
    log: () => undefined,
    ...(opts.period ? { period: opts.period } : {}),
    async fetchJson<T>(url: string): Promise<T> {
      hits.push(url)
      if (!(url in routes)) throw new Error(`unexpected ${url}`)
      return routes[url] as T
    },
    async fetchText(): Promise<string> {
      throw new Error('unused')
    },
    ...(opts.completed
      ? {
          completedPostStub: (creatorId: string, postId: string): Post | null =>
            opts.completed!.includes(postId)
              ? {
                  serviceId: 'fanbox',
                  creatorId,
                  postId,
                  title: 'stub',
                  postedAt: '',
                  year: 2025,
                  month: 1,
                  url: '',
                  files: []
                }
              : null
        }
      : {})
  }
  return { ctx, hits }
}

async function collect(it: AsyncIterable<Post>): Promise<Post[]> {
  const out: Post[] = []
  for await (const p of it) out.push(p)
  return out
}

describe('fanboxService listing', () => {
  it('skips the post.info fetch for restricted posts', async () => {
    const { ctx, hits } = fakeCtx()
    const posts = await collect(fanboxService.listPosts(ctx, 'c1'))
    expect(posts.map((p) => p.postId)).toEqual(['101', '103'])
    expect(hits).not.toContain(`${API}/post.info?postId=102`)
  })

  it('counts only accessible posts and reuses that listing in listPosts', async () => {
    const { ctx, hits } = fakeCtx()
    expect(await fanboxService.countPosts!(ctx, 'c1')).toBe(2)
    const listingHits = hits.length
    const posts = await collect(fanboxService.listPosts(ctx, 'c1'))
    expect(posts.map((p) => p.postId)).toEqual(['101', '103'])
    // Only post.info calls after counting — no second walk of the pages.
    expect(hits.slice(listingHits)).toEqual([
      `${API}/post.info?postId=101`,
      `${API}/post.info?postId=103`
    ])
    // The cached listing is one-shot: a later listPosts walks the pages again.
    hits.length = 0
    await collect(fanboxService.listPosts(ctx, 'c1'))
    expect(hits).toContain(PAGE1)
  })

  it('reports listing-page progress while counting', async () => {
    const { ctx } = fakeCtx()
    const calls: Array<[number, number]> = []
    ctx.progress = (done, total) => calls.push([done, total])
    await fanboxService.countPosts!(ctx, 'c1')
    expect(calls).toEqual([
      [0, 2],
      [1, 2],
      [2, 2]
    ])
  })

  it('yields the ledger stub instead of fetching an already-downloaded post', async () => {
    const { ctx, hits } = fakeCtx({ completed: ['101'] })
    const posts = await collect(fanboxService.listPosts(ctx, 'c1'))
    expect(posts.map((p) => [p.postId, p.title])).toEqual([
      ['101', 'stub'],
      ['103', 'post 103']
    ])
    expect(hits).not.toContain(`${API}/post.info?postId=101`)
  })
})

describe('fanboxService period filter', () => {
  const ms = (iso: string): number => Date.parse(iso)

  it('skips posts newer than the period without fetching them', async () => {
    const { ctx, hits } = fakeCtx({ period: { to: ms('2025-02-15T00:00:00+09:00') } })
    expect(await fanboxService.countPosts!(ctx, 'c1')).toBe(1)
    const posts = await collect(fanboxService.listPosts(ctx, 'c1'))
    expect(posts.map((p) => p.postId)).toEqual(['103'])
    expect(hits).not.toContain(`${API}/post.info?postId=101`)
  })

  it('stops paging once a whole page is older than the period', async () => {
    const { ctx, hits } = fakeCtx({ period: { from: ms('2025-03-15T00:00:00+09:00') } })
    expect(await fanboxService.countPosts!(ctx, 'c1')).toBe(0)
    expect(await collect(fanboxService.listPosts(ctx, 'c1'))).toEqual([])
    expect(hits).not.toContain(PAGE2)
    expect(hits.some((u) => u.includes('post.info'))).toBe(false)
  })

  it('also stops early without the cached listing', async () => {
    const { ctx, hits } = fakeCtx({ period: { from: ms('2025-03-15T00:00:00+09:00') } })
    expect(await collect(fanboxService.listPosts(ctx, 'c1'))).toEqual([])
    expect(hits).not.toContain(PAGE2)
  })
})
