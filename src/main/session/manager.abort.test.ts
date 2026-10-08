import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** A fake Electron ClientRequest: like the real one, abort() emits only 'abort'. */
class FakeRequest extends EventEmitter {
  setHeader(): void {}
  write(): void {}
  end(): void {}
  abort(): void {
    this.emit('abort')
  }
}
const requests: FakeRequest[] = []

vi.mock('electron', () => ({
  net: {
    request: () => {
      const r = new FakeRequest()
      requests.push(r)
      return r
    }
  },
  session: { fromPartition: () => ({}) }
}))

const { requestFor } = await import('./manager')
const { resetThrottle } = await import('./throttle')

afterEach(() => {
  requests.length = 0
  resetThrottle()
})

describe('requestFor cancellation', () => {
  it('rejects when the signal aborts an in-flight request (instead of hanging)', async () => {
    const ac = new AbortController()
    const pending = requestFor('fanbox', 'https://example.invalid/a', { signal: ac.signal })
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    ac.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects at once for an already-aborted signal', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(
      requestFor('fanbox', 'https://example.invalid/b', { signal: ac.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('still resolves a normal response', async () => {
    const pending = requestFor('fanbox', 'https://example.invalid/c')
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: object }
    res.statusCode = 200
    res.headers = {}
    requests[0].emit('response', res)
    res.emit('data', Buffer.from('{"ok":true}'))
    res.emit('end')
    await expect((await pending).json()).resolves.toEqual({ ok: true })
  })
})
