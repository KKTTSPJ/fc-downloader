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
})
