import { describe, expect, it } from 'vitest'
import type { Creator } from '@shared/types'
import { mergeAddedCreators } from './creators'

const c = (creatorId: string, extra: Partial<Creator> = {}): Creator => ({
  serviceId: 'patreon',
  creatorId,
  name: `Creator ${creatorId}`,
  ...extra
})

describe('mergeAddedCreators', () => {
  it('appends added creators the listing missed, flagged as added', () => {
    const out = mergeAddedCreators([c('1', { supporting: true })], [c('2', { supporting: false })])
    expect(out).toEqual([c('1', { supporting: true }), c('2', { supporting: false, added: true })])
  })

  it('keeps the listing entry when the listing also finds an added creator', () => {
    const out = mergeAddedCreators([c('1', { supporting: true })], [c('1', { supporting: false })])
    expect(out).toEqual([c('1', { supporting: true })])
  })

  it('handles no added creators', () => {
    expect(mergeAddedCreators([c('1')], undefined)).toEqual([c('1')])
  })

  it('drops added creators with an unsafe id and off-site page URLs', () => {
    const out = mergeAddedCreators(
      [],
      [
        c('..'),
        c(''),
        c('a/b'),
        c('7', { pageUrl: 'https://www.patreon.com/examplecreator' }),
        c('8', { pageUrl: 'https://example.invalid/x' })
      ]
    )
    expect(out.map((x) => [x.creatorId, x.pageUrl])).toEqual([
      ['7', 'https://www.patreon.com/examplecreator'],
      ['8', undefined]
    ])
  })
})
