import { describe, expect, it } from 'vitest'
import {
  creatorsFromCurrentUser,
  creatorsFromStream,
  extractCampaignId,
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
  it.each([
    [
      'https://www.patreon.com/examplecreator',
      { kind: 'page', url: 'https://www.patreon.com/examplecreator' }
    ],
    [
      'https://www.patreon.com/c/examplecreator/posts',
      { kind: 'page', url: 'https://www.patreon.com/examplecreator' }
    ],
    [
      'https://patreon.com/cw/examplecreator',
      { kind: 'page', url: 'https://www.patreon.com/examplecreator' }
    ],
    [
      'https://www.patreon.com/user?u=123',
      { kind: 'page', url: 'https://www.patreon.com/user?u=123' }
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
    'https://example.com/examplecreator',
    'https://www.patreon.com.evil.invalid/examplecreator',
    'not a url'
  ])('rejects %s', (url) => {
    expect(parseCreatorRef(url)).toBeNull()
  })
})

describe('extractCampaignId', () => {
  it('reads the Next.js bootstrap', () => {
    const data = {
      props: {
        pageProps: { bootstrapEnvelope: { pageBootstrap: { campaign: { data: { id: '111' } } } } }
      }
    }
    const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></html>`
    expect(extractCampaignId(html)).toBe('111')
  })

  it('reads a JSON-escaped streamed payload fragment', () => {
    const html = String.raw`self.__next_f.push([1,"{\"value\":{\"campaign\":{\"data\":{\"id\":\"222\",\"type\":\"campaign\"}}}}"])`
    expect(extractCampaignId(html)).toBe('222')
  })

  it('reads a plain bootstrap and a campaign self link', () => {
    expect(
      extractCampaignId('window.patreon = {"bootstrap": {"campaign": {"data": {"id": "333"}}}}')
    ).toBe('333')
    expect(extractCampaignId('"self": "https://www.patreon.com/api/campaigns/444"')).toBe('444')
  })

  it('returns null when absent', () => {
    expect(extractCampaignId('<html>nothing</html>')).toBeNull()
  })
})
