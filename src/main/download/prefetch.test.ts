import { describe, expect, it } from 'vitest'
import { prefetchOne } from './prefetch'

async function* numbers(n: number, log: string[]): AsyncGenerator<number> {
  try {
    for (let i = 1; i <= n; i++) {
      log.push(`fetch ${i}`)
      yield i
    }
  } finally {
    log.push('closed')
  }
}

describe('prefetchOne', () => {
  it('yields every item in order, resolved', async () => {
    const out: string[] = []
    for await (const v of prefetchOne(numbers(3, []), async (n) => `p${n}`)) out.push(v)
    expect(out).toEqual(['p1', 'p2', 'p3'])
  })

  it('starts fetching the next item before the current one is processed', async () => {
    const log: string[] = []
    for await (const v of prefetchOne(numbers(3, log), async (n) => n)) {
      // Let the in-flight lookahead run while this item is being "downloaded".
      await new Promise((r) => setTimeout(r, 0))
      log.push(`process ${v}`)
    }
    expect(log).toEqual([
      'fetch 1',
      'fetch 2',
      'process 1',
      'fetch 3',
      'process 2',
      // The lookahead finds the end of the source while item 3 is processed.
      'closed',
      'process 3'
    ])
  })

  it('surfaces a resolve error when that item is reached', async () => {
    const out: number[] = []
    const run = async (): Promise<void> => {
      for await (const v of prefetchOne(numbers(3, []), async (n) => {
        if (n === 2) throw new Error('boom')
        return n
      })) {
        out.push(v)
      }
    }
    await expect(run()).rejects.toThrow('boom')
    expect(out).toEqual([1])
  })

  it('closes the source when the consumer stops early', async () => {
    const log: string[] = []
    for await (const v of prefetchOne(numbers(5, log), async (n) => n)) {
      if (v === 2) break
    }
    expect(log.at(-1)).toBe('closed')
    expect(log.filter((l) => l.startsWith('fetch'))).toEqual(['fetch 1', 'fetch 2', 'fetch 3'])
  })
})
