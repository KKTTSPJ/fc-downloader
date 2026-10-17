import { describe, expect, it } from 'vitest'
import {
  campaignIdCandidates,
  campaignMatchesRef,
  campaignToCreator,
  creatorsFromCurrentUser,
  creatorsFromStream,
  mergeCreators,
  parseCreatorRef,
  type JsonApiResource
} from './creators'

const campaign = (id: string, name = `Creator ${id}`): JsonApiResource => ({
  id,
  type: 'campaign',
  attributes: {
    name,
    url: `https://www.patreon.com/example${id}`,
    avatar_photo_url: `https://example.invalid/a${id}.png`
  }
})
const link = (type: string, id: string, campaignId: string): JsonApiResource => ({
  id,
  type,
  relationships: { campaign: { data: { id: campaignId, type: 'campaign' } } }
})

describe('creatorsFromCurrentUser', () => {
  it('marks pledged campaigns paid and membership-only ones free', () => {
    const out = creatorsFromCurrentUser([
      link('pledge', 'p1', '100'),
      link('member', 'm1', '100'),
      link('member', 'm2', '200'),
      campaign('100'),
      campaign('200')
    ])
    expect(out.map((c) => [c.creatorId, c.supporting])).toEqual([
      ['100', true],
      ['200', false]
    ])
    expect(out[0]).toMatchObject({
      serviceId: 'patreon',
      name: 'Creator 100',
      pageUrl: 'https://www.patreon.com/example100',
      iconUrl: 'https://example.invalid/a100.png'
    })
  })

  it('treats campaigns without linkage as paid and tolerates no included', () => {
    expect(creatorsFromCurrentUser([campaign('100')])[0].supporting).toBe(true)
    expect(creatorsFromCurrentUser(undefined)).toEqual([])
  })
})

describe('creatorsFromStream + mergeCreators', () => {
  it('collects followed campaigns as free, de-duped, paid entries winning', () => {
    const paid = creatorsFromCurrentUser([campaign('100')])
    const page1 = creatorsFromStream([campaign('100'), campaign('300'), { id: '9', type: 'post' }])
    const page2 = creatorsFromStream([campaign('300'), campaign('400')])
    const out = mergeCreators(paid, page1, page2)
    expect(out.map((c) => [c.creatorId, c.supporting])).toEqual([
      ['100', true],
      ['300', false],
      ['400', false]
    ])
  })

  it('falls back to a placeholder name', () => {
    expect(creatorsFromStream([{ id: '5', type: 'campaign' }])[0].name).toBe('campaign-5')
  })
})

describe('parseCreatorRef', () => {
  const page = (vanity: string): object => ({
    kind: 'page',
    url: `https://www.patreon.com/${vanity}`,
    vanity
  })
  it.each([
    ['https://www.patreon.com/examplecreator', page('examplecreator')],
    ['https://www.patreon.com/c/examplecreator/posts', page('examplecreator')],
    ['https://patreon.com/cw/examplecreator', page('examplecreator')],
    [
      'https://www.patreon.com/user?u=123',
      { kind: 'page', url: 'https://www.patreon.com/user?u=123', userId: '123' }
    ],
    ['https://www.patreon.com/posts/some-title-98765', { kind: 'post', postId: '98765' }],
    ['https://www.patreon.com/posts/98765?utm_source=x', { kind: 'post', postId: '98765' }],
    ['https://www.patreon.com/profile/creators?c=4242', { kind: 'campaign', campaignId: '4242' }]
  ])('%s', (url, ref) => {
    expect(parseCreatorRef(url)).toEqual(ref)
  })

  it.each([
    'https://www.patreon.com/home',
    'https://www.patreon.com/settings/memberships',
    'https://www.patreon.com/',
    'https://www.patreon.com/posts/no-id-here',
    'https://www.patreon.com/pricing',
    'https://www.patreon.com/profile?u=',
    'https://www.patreon.com/user',
    'http://www.patreon.com/examplecreator',
    'https://example.com/examplecreator',
    'https://www.patreon.com.evil.invalid/examplecreator',
    'not a url'
  ])('rejects %s', (url) => {
    expect(parseCreatorRef(url)).toBeNull()
  })
})

describe('campaignToCreator validation', () => {
  it('drops a campaign whose id is not all digits', () => {
    expect(campaignToCreator({ id: '..', type: 'campaign' }, false)).toBeNull()
    expect(campaignToCreator({ id: '', type: 'campaign' }, false)).toBeNull()
    expect(creatorsFromStream([{ id: '../x', type: 'campaign' }, campaign('7')])).toHaveLength(1)
    expect(creatorsFromCurrentUser([{ id: 'a/b', type: 'campaign' }])).toEqual([])
  })

  it('keeps only an https patreon.com page URL', () => {
    const withUrl = (url: string): string | undefined =>
      campaignToCreator({ id: '1', type: 'campaign', attributes: { url } }, false)?.pageUrl
    expect(withUrl('https://www.patreon.com/examplecreator')).toBe(
      'https://www.patreon.com/examplecreator'
    )
    expect(withUrl('https://patreon.com/c/examplecreator')).toBe(
      'https://patreon.com/c/examplecreator'
    )
    expect(withUrl('http://www.patreon.com/examplecreator')).toBeUndefined()
    expect(withUrl('https://example.invalid/phish')).toBeUndefined()
    expect(withUrl('javascript:alert(1)')).toBeUndefined()
  })
})

describe('campaignIdCandidates', () => {
  it('puts the Next.js bootstrap first', () => {
    const data = {
      props: {
        pageProps: { bootstrapEnvelope: { pageBootstrap: { campaign: { data: { id: '111' } } } } }
      }
    }
    const html =
      String.raw`{\"campaign\":{\"data\":{\"id\":\"999\"` +
      `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`
    expect(campaignIdCandidates(html)).toEqual(['111', '999'])
  })

  it('collects every fragment and self link, de-duplicated and capped', () => {
    const html =
      String.raw`{\"value\":{\"campaign\":{\"data\":{\"id\":\"222\"}}}}` +
      ' window.patreon = {"bootstrap": {"campaign": {"data": {"id": "333"}}}}' +
      ' "self": "https://www.patreon.com/api/campaigns/222"' +
      ' "self": "https://www.patreon.com/api/campaigns/444"' +
      ' "self": "https://www.patreon.com/api/campaigns/555"'
    expect(campaignIdCandidates(html)).toEqual(['222', '333', '444'])
  })

  it('returns nothing when absent', () => {
    expect(campaignIdCandidates('<html>nothing</html>')).toEqual([])
  })
})

describe('campaignMatchesRef', () => {
  const camp = (attrs: Record<string, unknown>, creatorId = '50'): JsonApiResource => ({
    id: '1',
    type: 'campaign',
    attributes: attrs,
    relationships: { creator: { data: { id: creatorId, type: 'user' } } }
  })
  const user: JsonApiResource = {
    id: '50',
    type: 'user',
    attributes: { vanity: 'ownername', url: 'https://www.patreon.com/ownername' }
  }

  it('matches the page vanity against the campaign or its creator', () => {
    expect(
      campaignMatchesRef(camp({ vanity: 'ExampleCreator' }), [], { vanity: 'examplecreator' })
    ).toBe(true)
    expect(
      campaignMatchesRef(camp({ url: 'https://www.patreon.com/c/examplecreator' }), [], {
        vanity: 'examplecreator'
      })
    ).toBe(true)
    expect(campaignMatchesRef(camp({}), [user], { vanity: 'ownername' })).toBe(true)
  })

  it('matches a /user?u= page by the creator id', () => {
    expect(campaignMatchesRef(camp({}), [], { userId: '50' })).toBe(true)
    expect(campaignMatchesRef(camp({}), [], { userId: '51' })).toBe(false)
  })

  it('rejects a campaign id that merely appeared on the page', () => {
    expect(
      campaignMatchesRef(
        camp({ vanity: 'someoneelse', url: 'https://www.patreon.com/someoneelse' }),
        [user],
        {
          vanity: 'examplecreator'
        }
      )
    ).toBe(false)
    expect(campaignMatchesRef(camp({}), [], {})).toBe(false)
  })
})
