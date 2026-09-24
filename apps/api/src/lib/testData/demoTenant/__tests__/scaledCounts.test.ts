/**
 * scaledDemoCounts — the counts of a smaller demo tenant, shared by the
 * generator's `--scale` and the integration suite against a real Neo4j.
 *
 * Why it matters: a count of zero would leave a tenant without the thing the
 * ratios assume (no support team for a ticket, no server for an incident),
 * and a scale outside (0, 1] would silently build a tenant nobody asked for.
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_DEMO_COUNTS, scaledDemoCounts } from '../options.js'

describe('scaledDemoCounts', () => {
  it('scale 1 is the default tenant', () => {
    expect(scaledDemoCounts(1)).toEqual(DEFAULT_DEMO_COUNTS)
  })

  it('multiplies the volumes and rounds them', () => {
    const c = scaledDemoCounts(0.1)
    expect(c.incidents).toBe(Math.round(DEFAULT_DEMO_COUNTS.incidents * 0.1))
    expect(c.servers).toBe(Math.round(DEFAULT_DEMO_COUNTS.servers * 0.1))
  })

  it('never goes below one, nor below five teams; the catalog and the reports keep their size', () => {
    const c = scaledDemoCounts(0.00001)
    expect(c.incidents).toBe(1)
    expect(c.ownerTeams).toBe(5)
    expect(c.supportTeams).toBe(5)
    expect(c.catalogItems).toBe(DEFAULT_DEMO_COUNTS.catalogItems)
    expect(c.reports).toBe(DEFAULT_DEMO_COUNTS.reports)
  })

  it('a scale outside (0, 1] is refused', () => {
    for (const s of [0, -1, 1.5, Number.NaN]) expect(() => scaledDemoCounts(s)).toThrow(/\(0, 1\]/)
  })
})
