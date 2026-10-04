/**
 * Publish-date period for a download run ("only posts from the last N days" /
 * "between these dates"). Shared by both processes — keep it free of
 * Node/Electron/DOM imports.
 */

/** The period form's persisted state (renderer download prefs). */
export interface PeriodPref {
  mode: 'all' | 'recent' | 'range'
  /** `recent`: how many days back from now. */
  days: number
  /** `range`: local calendar dates "YYYY-MM-DD"; empty = open-ended. */
  from: string
  to: string
}

export const DEFAULT_PERIOD_PREF: PeriodPref = { mode: 'all', days: 30, from: '', to: '' }

/** A run's period as sent to the engine: ISO timestamps, `from` inclusive and
 *  `to` exclusive; either end may be absent (open-ended). */
export interface PeriodRange {
  from?: string
  to?: string
}

/** The same period as epoch milliseconds (what adapters compare against). */
export interface PeriodMs {
  from?: number
  to?: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Local midnight at the start of a "YYYY-MM-DD" date, or undefined. */
function localMidnight(date: string, addDays = 0): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return undefined
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + addDays)
}

/**
 * Turn the form state into the run's range, evaluated at `now` (so "last N
 * days" is relative to when the run starts). Undefined = no period filter.
 * A range's `to` date is inclusive: the range ends at the next local midnight.
 */
export function periodRangeFromPref(
  pref: PeriodPref | undefined,
  now: Date
): PeriodRange | undefined {
  if (!pref || pref.mode === 'all') return undefined
  if (pref.mode === 'recent') {
    if (!Number.isFinite(pref.days) || pref.days < 1) return undefined
    return { from: new Date(now.getTime() - Math.floor(pref.days) * DAY_MS).toISOString() }
  }
  // Dates entered in reverse order are taken as the same span.
  const [a, b] =
    pref.from && pref.to && pref.from > pref.to ? [pref.to, pref.from] : [pref.from, pref.to]
  const from = localMidnight(a)
  const to = localMidnight(b, 1)
  if (!from && !to) return undefined
  return { from: from?.toISOString(), to: to?.toISOString() }
}

/** Parse a run's range into epoch ms (unparseable ends are dropped). */
export function periodToMs(range: PeriodRange | undefined): PeriodMs | undefined {
  if (!range) return undefined
  const from = range.from ? Date.parse(range.from) : NaN
  const to = range.to ? Date.parse(range.to) : NaN
  const out: PeriodMs = {}
  if (Number.isFinite(from)) out.from = from
  if (Number.isFinite(to)) out.to = to
  return out.from === undefined && out.to === undefined ? undefined : out
}

/**
 * Where a publish timestamp falls relative to the period: `before` (older than
 * `from`), `after` (at/after `to`), `in`, or `unknown` when the date is missing
 * or unparseable (callers keep those rather than silently dropping them).
 */
export function periodPosition(
  postedAt: string | undefined,
  period: PeriodMs | undefined
): 'in' | 'before' | 'after' | 'unknown' {
  if (!period) return 'in'
  const t = postedAt ? Date.parse(postedAt) : NaN
  if (!Number.isFinite(t)) return 'unknown'
  if (period.from !== undefined && t < period.from) return 'before'
  if (period.to !== undefined && t >= period.to) return 'after'
  return 'in'
}

/** True unless the timestamp is known to fall outside the period. */
export function maybeInPeriod(postedAt: string | undefined, period: PeriodMs | undefined): boolean {
  const pos = periodPosition(postedAt, period)
  return pos === 'in' || pos === 'unknown'
}
