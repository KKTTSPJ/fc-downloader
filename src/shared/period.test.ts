import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PERIOD_PREF,
  MAX_PERIOD_DAYS,
  isPeriodPrefIncomplete,
  SYNC_OVERLAP_MS,
  maybeInPeriod,
  nextSyncMark,
  periodPosition,
  periodRangeFromPref,
  periodToMs,
  syncPeriod
} from './period'

const now = new Date('2026-10-04T12:00:00Z')

describe('periodRangeFromPref', () => {
  it('is undefined for "all" or no pref', () => {
    expect(periodRangeFromPref(undefined, now)).toBeUndefined()
    expect(periodRangeFromPref(DEFAULT_PERIOD_PREF, now)).toBeUndefined()
  })

  it('makes "recent" relative to now', () => {
    const r = periodRangeFromPref({ ...DEFAULT_PERIOD_PREF, mode: 'recent', days: 7 }, now)
    expect(r).toEqual({ from: '2026-09-27T12:00:00.000Z' })
  })

  it('caps the day count so a huge entry stays a valid date', () => {
    const r = periodRangeFromPref({ ...DEFAULT_PERIOD_PREF, mode: 'recent', days: 1e12 }, now)
    expect(r).toEqual({
      from: new Date(now.getTime() - MAX_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString()
    })
  })

  it('ignores an invalid day count', () => {
    expect(
      periodRangeFromPref({ ...DEFAULT_PERIOD_PREF, mode: 'recent', days: 0 }, now)
    ).toBeUndefined()
  })

  it('makes a range inclusive of its end date (local midnights)', () => {
    const r = periodRangeFromPref(
      { ...DEFAULT_PERIOD_PREF, mode: 'range', from: '2026-01-10', to: '2026-01-12' },
      now
    )
    expect(r).toEqual({
      from: new Date(2026, 0, 10).toISOString(),
      to: new Date(2026, 0, 13).toISOString()
    })
  })

  it('allows an open-ended range and swaps reversed dates', () => {
    expect(
      periodRangeFromPref({ ...DEFAULT_PERIOD_PREF, mode: 'range', from: '2026-01-10' }, now)
    ).toEqual({ from: new Date(2026, 0, 10).toISOString(), to: undefined })
    expect(
      periodRangeFromPref(
        { ...DEFAULT_PERIOD_PREF, mode: 'range', from: '2026-01-12', to: '2026-01-10' },
        now
      )
    ).toEqual({
      from: new Date(2026, 0, 10).toISOString(),
      to: new Date(2026, 0, 13).toISOString()
    })
    expect(periodRangeFromPref({ ...DEFAULT_PERIOD_PREF, mode: 'range' }, now)).toBeUndefined()
  })
})

describe('isPeriodPrefIncomplete', () => {
  it('flags only a range with neither date set', () => {
    expect(isPeriodPrefIncomplete({ ...DEFAULT_PERIOD_PREF, mode: 'range' })).toBe(true)
    expect(isPeriodPrefIncomplete({ ...DEFAULT_PERIOD_PREF, mode: 'range', from: 'bad' })).toBe(
      true
    )
    expect(
      isPeriodPrefIncomplete({ ...DEFAULT_PERIOD_PREF, mode: 'range', to: '2026-01-10' })
    ).toBe(false)
    expect(isPeriodPrefIncomplete(DEFAULT_PERIOD_PREF)).toBe(false)
    expect(isPeriodPrefIncomplete(undefined)).toBe(false)
  })
})

describe('periodPosition', () => {
  const p = periodToMs({ from: '2026-01-10T00:00:00Z', to: '2026-01-20T00:00:00Z' })

  it('places timestamps relative to [from, to)', () => {
    expect(periodPosition('2026-01-09T23:59:59Z', p)).toBe('before')
    expect(periodPosition('2026-01-10T00:00:00Z', p)).toBe('in')
    expect(periodPosition('2026-01-19T23:59:59Z', p)).toBe('in')
    expect(periodPosition('2026-01-20T00:00:00Z', p)).toBe('after')
  })

  it('keeps posts with a missing/unparseable date', () => {
    expect(periodPosition(undefined, p)).toBe('unknown')
    expect(maybeInPeriod('not a date', p)).toBe(true)
  })

  it('treats no period as everything in range', () => {
    expect(maybeInPeriod('2000-01-01T00:00:00Z', undefined)).toBe(true)
    expect(periodToMs(undefined)).toBeUndefined()
  })
})

describe('since-last-sync helpers', () => {
  const mark = '2026-09-01T00:00:00.000Z'

  it('leaves sinceSync to the engine (no run-wide range, never "incomplete")', () => {
    const pref = { ...DEFAULT_PERIOD_PREF, mode: 'sinceSync' as const }
    expect(periodRangeFromPref(pref, now)).toBeUndefined()
    expect(isPeriodPrefIncomplete(pref)).toBe(false)
  })

  it("starts a creator's walk an overlap before its mark, or walks all without one", () => {
    expect(syncPeriod(mark)).toEqual({ from: Date.parse(mark) - SYNC_OVERLAP_MS })
    expect(syncPeriod(undefined)).toBeUndefined()
    expect(syncPeriod('garbage')).toBeUndefined()
  })

  const clean = { coveredFromMark: true, incomplete: false, previous: mark }

  it('advances to the newest post seen after a clean, covering walk', () => {
    expect(nextSyncMark({ ...clean, newestSeen: '2026-09-10T00:00:00Z' })).toBe(
      '2026-09-10T00:00:00.000Z'
    )
    expect(
      nextSyncMark({ ...clean, previous: undefined, newestSeen: '2026-09-10T00:00:00Z' })
    ).toBe('2026-09-10T00:00:00.000Z')
  })

  it('never advances over a gap: failed/skipped posts or a walk not reaching the mark', () => {
    const newestSeen = '2026-09-10T00:00:00Z'
    expect(nextSyncMark({ ...clean, incomplete: true, newestSeen })).toBeUndefined()
    expect(nextSyncMark({ ...clean, coveredFromMark: false, newestSeen })).toBeUndefined()
  })

  it('keeps the mark when nothing newer was seen', () => {
    expect(nextSyncMark({ ...clean, newestSeen: undefined })).toBeUndefined()
    expect(nextSyncMark({ ...clean, newestSeen: '2026-08-01T00:00:00Z' })).toBeUndefined()
  })
})
