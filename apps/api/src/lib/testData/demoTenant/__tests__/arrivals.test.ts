/**
 * WHEN THE TICKETS ARRIVE (22 Sep 2026).
 *
 * edges.test.ts pins the shape of the arrivals (months that move, August
 * empty, exact counts). What is pinned here are the edges of the contract:
 *
 *  - nothing asked, nothing drawn — whatever the window;
 *  - tickets asked for an empty window is a planning mistake, and it fails
 *    loud instead of piling them on one instant;
 *  - a ticket is open while its life is not over (`stillOpen`).
 */
import { describe, it, expect } from 'vitest'
import { Rng } from '../random.js'
import { DAY, HOUR, DemoClock } from '../clock.js'
import { arrivalInstants, stillOpen, type Lifetime } from '../arrivals.js'

const NOW = Date.parse('2026-09-23T10:00:00.000Z')
const clock = new DemoClock(NOW, 3, 'Europe/Rome')

describe('arrivalInstants, at the edges', () => {
  it('nothing asked, nothing drawn — even for a window that is empty', () => {
    expect(arrivalInstants(new Rng('none'), clock, 0, NOW - DAY, NOW)).toEqual([])
    expect(arrivalInstants(new Rng('none'), clock, -3, NOW - DAY, NOW)).toEqual([])
    expect(arrivalInstants(new Rng('none'), clock, 0, NOW, NOW)).toEqual([])
  })

  it('tickets asked for an empty window fail loud', () => {
    expect(() => arrivalInstants(new Rng('empty'), clock, 5, NOW, NOW)).toThrow('arrivalInstants: the window is empty')
    expect(() => arrivalInstants(new Rng('empty'), clock, 5, NOW, NOW - DAY)).toThrow('arrivalInstants: the window is empty')
  })

  it('a window shorter than a month still gets every ticket asked, inside it', () => {
    const at = arrivalInstants(new Rng('short'), clock, 40, NOW - 10 * DAY, NOW)
    expect(at).toHaveLength(40)
    for (const ms of at) {
      expect(ms).toBeGreaterThanOrEqual(NOW - 10 * DAY)
      expect(ms).toBeLessThan(NOW)
    }
  })
})

describe('stillOpen: a ticket is open while its life is not over', () => {
  // Every ticket lasts about a day, none gets stuck.
  const DAYLONG: Lifetime = { medianHours: 24, spread: 0.01, stuckShare: 0, stuckMedianDays: 1 }

  it('one from an hour ago is open, one from a week ago is not: how many are open follows from the durations', () => {
    const created = [NOW - 7 * DAY, NOW - 3 * DAY, NOW - 2 * HOUR, NOW - HOUR]
    expect(stillOpen(new Rng('open'), created, NOW, DAYLONG)).toEqual([false, false, true, true])
  })

  it('the stuck ones last weeks: a ticket of ten days ago is still open only if it got stuck', () => {
    const stuck: Lifetime = { ...DAYLONG, stuckShare: 1, stuckMedianDays: 60 }
    const created = Array.from({ length: 200 }, () => NOW - 10 * DAY)
    expect(stillOpen(new Rng('stuck'), created, NOW, DAYLONG).filter(Boolean)).toHaveLength(0)
    expect(stillOpen(new Rng('stuck'), created, NOW, stuck).filter(Boolean).length).toBeGreaterThan(150)
  })
})
