/**
 * requestMeanOpenDays — how long a request stays open by the generator's own
 * model, what the verification measures the open requests against.
 *
 * Why it matters: on 24 Sep 2026 the verification expected 911 open requests
 * from a global lifetime the generator had stopped following, and failed a
 * tenant whose 147 open requests were exactly what the models give. Here the
 * formula is held to the model itself: twenty thousand timelines drawn with
 * `requestTimeline`, weighted by demand as the generator draws them.
 */
import { describe, it, expect } from 'vitest'
import { Rng } from '../random.js'
import { DAY } from '../clock.js'
import { requestMeanOpenDays, requestTimeline } from '../serviceRequests.js'
import { DEMO_CATALOG } from '../catalogContent.js'

describe('requestMeanOpenDays', () => {
  it('matches the mean open time of the timelines the generator draws', () => {
    const rng = new Rng('request-open-days')
    const weighted = DEMO_CATALOG.map((it) => [it, it.demand] as const)
    let total = 0
    const n = 20_000
    for (let i = 0; i < n; i++) {
      const spec = rng.weighted(weighted)
      const t = requestTimeline(rng, spec, 0)
      // Open until closed; a rejected request ends at the decision.
      total += (t.rejected ? t.decisionAtMs! : t.closedAtMs) / DAY
    }
    const simulated = total / n
    const formula = requestMeanOpenDays(DEMO_CATALOG)
    // The formula leaves out the rejections (they end earlier) and the caps: close, not equal.
    expect(formula / simulated).toBeGreaterThan(0.85)
    expect(formula / simulated).toBeLessThan(1.25)
  })

  it('gives the order of magnitude the demo tenant shows: about a hundred open requests, not nine hundred', () => {
    const open = (120_000 / (3 * 365)) * requestMeanOpenDays(DEMO_CATALOG)
    expect(open).toBeGreaterThan(60)
    expect(open).toBeLessThan(250)
  })

  it('a catalog without demand is an error, not a division by zero', () => {
    expect(() => requestMeanOpenDays([])).toThrow(/no demand/)
  })
})
