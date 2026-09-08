/**
 * A-05: inbound webhook token comparison is constant-time and tolerant of
 * corrupt stored hashes (never matches, never throws).
 */
import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'

vi.mock('@opengraphity/neo4j', () => ({ runQuery: vi.fn(), runQueryOne: vi.fn(), getSession: vi.fn() }))
vi.mock('../../services/incidentService.js', () => ({ createIncident: vi.fn() }))
vi.mock('../../services/problemService.js', () => ({ createProblem: vi.fn() }))

import { tokenMatches } from '../webhooks-inbound.js'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

describe('tokenMatches', () => {
  it('matches the sha256 of the presented token', () => {
    expect(tokenMatches('abc', sha('abc'))).toBe(true)
    expect(tokenMatches('abc', sha('abc').toUpperCase())).toBe(true)
  })

  it('rejects a different token', () => {
    expect(tokenMatches('abd', sha('abc'))).toBe(false)
  })

  it.each(['', 'nothex', sha('abc').slice(0, 63), sha('abc') + '0'])('rejects corrupt stored hash %j without throwing', (stored) => {
    expect(tokenMatches('abc', stored)).toBe(false)
  })
})
