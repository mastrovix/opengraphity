/**
 * THE DEMO TENANT'S TIME: THREE YEARS UP TO NOW (23 Sep 2026).
 *
 * Everything the generator writes happens inside [start, now]: a CI is
 * created before the tickets that name it, a ticket before its first
 * transition, a transition before the next. The clock only answers "when",
 * in UTC milliseconds; the local working hours of the tenant come from its
 * timezone, because an incident opened at 3 a.m. Rome time on a Sunday is
 * possible but rare, and a demo where every ticket is opened at 3 a.m. is not.
 */
import type { Rng } from './random.js'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

export class DemoClock {
  readonly startMs: number

  constructor(readonly nowMs: number, readonly years: number, readonly timeZone: string) {
    if (!Number.isFinite(nowMs)) throw new Error('DemoClock: "now" is not a valid instant')
    if (!Number.isInteger(years) || years < 1) throw new Error('DemoClock: "years" must be a positive integer')
    // Validates the zone once, here, instead of failing on the ten-thousandth ticket.
    new Intl.DateTimeFormat('en-GB', { timeZone })
    const start = new Date(nowMs)
    start.setUTCFullYear(start.getUTCFullYear() - years)
    this.startMs = start.getTime()
    this.parts = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' })
  }

  private readonly parts: Intl.DateTimeFormat

  iso(ms: number): string {
    return new Date(ms).toISOString()
  }

  /** Local weekday (0 = Sunday) and hour of an instant in the tenant's zone. */
  local(ms: number): { weekday: number; hour: number } {
    const p = this.parts.formatToParts(new Date(ms))
    const wd = p.find((x) => x.type === 'weekday')!.value
    const hour = Number(p.find((x) => x.type === 'hour')!.value)
    return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd), hour }
  }

  isWorkingTime(ms: number): boolean {
    const { weekday, hour } = this.local(ms)
    return weekday >= 1 && weekday <= 5 && hour >= 8 && hour < 19
  }

  /** Uniform in [from, to). */
  between(rng: Rng, fromMs: number, toMs: number): number {
    if (!(toMs > fromMs)) return fromMs
    return Math.floor(fromMs + rng.next() * (toMs - fromMs))
  }

  /**
   * An instant in [from, to) that is usually inside working hours: people open
   * tickets and move them while at work. `offHours` is the share that is not
   * (weekends, nights: on-call, monitoring, the portal).
   */
  workInstant(rng: Rng, fromMs: number, toMs: number, offHours = 0.12): number {
    if (!(toMs > fromMs)) return fromMs
    if (rng.chance(offHours)) return this.between(rng, fromMs, toMs)
    for (let attempt = 0; attempt < 24; attempt++) {
      const ms = this.between(rng, fromMs, toMs)
      if (this.isWorkingTime(ms)) return ms
    }
    // A window with no working hour at all (a weekend night): take it as it is.
    return this.between(rng, fromMs, toMs)
  }

  /**
   * The moment a piece of work that takes `durationMs` finishes after
   * `fromMs`, never past `capMs`. Work that would end after "now" is cut at
   * the cap by the caller's choice of state, not stretched into the future.
   */
  after(fromMs: number, durationMs: number, capMs = this.nowMs): number {
    return Math.min(fromMs + Math.max(MINUTE, Math.round(durationMs)), capMs)
  }
}
