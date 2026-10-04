import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PERIOD_PREF,
  maybeInPeriod,
  periodPosition,
  periodRangeFromPref,
  periodToMs
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
