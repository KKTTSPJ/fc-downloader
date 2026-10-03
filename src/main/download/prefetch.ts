/**
 * Iterate `source` (mapped through `resolve`) while keeping the NEXT item's
 * fetch in flight as soon as the current one is handed out, so a post's
 * metadata request (and its politeness-throttle wait) overlaps the previous
 * post's file downloads instead of running strictly after them. Only one item
 * is ever fetched ahead, so the metadata request rate is unchanged — it is
 * still bounded by the throttle. A prefetch error surfaces when that item is
 * reached, exactly as it would without the lookahead.
 */
export async function* prefetchOne<T, R>(
  source: AsyncIterable<T>,
  resolve: (item: T) => Promise<R>
): AsyncGenerator<R> {
  const it = source[Symbol.asyncIterator]()
  const fetchNext = async (): Promise<{ value: R } | null> => {
    const r = await it.next()
    return r.done ? null : { value: await resolve(r.value) }
  }
  let pending = fetchNext()
  // Handled when awaited below; this only keeps an abort that rejects it
  // mid-download from being reported as an unhandled rejection.
  pending.catch(() => undefined)
  let finished = false
  try {
    for (;;) {
      const next = await pending
      if (!next) {
        finished = true
        return
      }
      pending = fetchNext()
      pending.catch(() => undefined)
      yield next.value
    }
  } finally {
    if (!finished) {
      // Stopped early (cancel/error): let the in-flight fetch settle, then
      // close the source so its cleanup runs.
      await pending.catch(() => undefined)
      await it.return?.()
    }
  }
}
