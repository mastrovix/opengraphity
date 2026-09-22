/**
 * OLA/UC attainment: the edges the main suite does not walk.
 *
 * The same measure feeds the OLA report, the ticket's OLA panel and the
 * breach alerts, so an edge that goes wrong here goes wrong in all three:
 *  - a contract scoped to ONE ticket type must cover exactly that type;
 *  - a deploy-plan window that has not started yet is "scheduled", with the
 *    deadline counted from the window start (not from now);
 *  - work done before the window counts zero, it is not negative time;
 *  - an unreadable date fails loud, naming what it was (a silent NaN would
 *    report every ticket as met);
 *  - the read queries refuse changes (measured on their tasks) and unknown
 *    types, and are always scoped by tenant.
 */
import { describe, it, expect, vi } from 'vitest'

// @opengraphity/sla loads the driver at import: keep this pure test off the network.
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(), getDriver: vi.fn() }))

import {
  olaEntityTypes, olaTeamMeasure, evaluateOLATeamTickets,
  olaConcludedTicketsCypher, olaTicketFactsCypher, type OLATicketFacts,
} from '../olaAttainment.js'

const TEAM = 'team-net'
const contract = { teamId: TEAM, createdAt: null, resolveMinutes: 120, businessHours: false, calendar: null }
const seg = (startedAt: string, endedAt: string | null, inferred = false) => ({ teamId: TEAM, startedAt, endedAt, inferred })
const ticket = (over: Partial<OLATicketFacts>): OLATicketFacts =>
  ({ createdAt: '2026-09-15T08:00:00Z', concludedAt: null, currentTeamId: TEAM, segments: [], ...over })

describe('olaEntityTypes', () => {
  it('a single ticket type covers exactly that type', () => {
    expect(olaEntityTypes('problem')).toEqual(['problem'])
  })
})

describe('olaTeamMeasure — windows and dates', () => {
  it('before the window starts the task is "scheduled", deadline counted from the window start', () => {
    const m = olaTeamMeasure(
      ticket({ segments: [seg('2026-09-15T08:00:00Z', null)], startsAt: '2026-09-16T10:00:00Z' }),
      contract, 'UTC', new Date('2026-09-15T09:00:00Z'),
    )
    expect(m).toMatchObject({ applies: true, state: 'scheduled', usedMinutes: 0, remainingMinutes: 120 })
    expect(m.deadline).toBe('2026-09-16T12:00:00.000Z')
  })

  it('inside the window only the time since the window start counts', () => {
    const m = olaTeamMeasure(
      ticket({ segments: [seg('2026-09-15T08:00:00Z', null)], startsAt: '2026-09-15T09:30:00Z' }),
      contract, 'UTC', new Date('2026-09-15T10:00:00Z'),
    )
    expect(m).toMatchObject({ state: 'running', usedMinutes: 30, remainingMinutes: 90, deadline: '2026-09-15T11:30:00.000Z' })
  })

  it('done before the window opened: counts zero, and is met', () => {
    const m = olaTeamMeasure(
      ticket({ segments: [seg('2026-09-15T08:00:00Z', '2026-09-15T09:00:00Z')], concludedAt: '2026-09-15T09:00:00Z', startsAt: '2026-09-15T12:00:00Z' }),
      contract, 'UTC', new Date('2026-09-15T13:00:00Z'),
    )
    expect(m).toMatchObject({ applies: true, state: 'met', usedMinutes: 0, deadline: null })
  })

  it('an open segment starting at "now" still counts as held (the ticket just arrived)', () => {
    const now = new Date('2026-09-15T08:00:00Z')
    const m = olaTeamMeasure(ticket({ segments: [seg('2026-09-15T08:00:00Z', null)] }), contract, 'UTC', now)
    expect(m).toMatchObject({ applies: true, state: 'running', usedMinutes: 0, remainingMinutes: 120 })
  })

  it.each([
    ['conclusion', { concludedAt: 'yesterday' }],
    ['segment start', { segments: [seg('garbage', null)] }],
    ['segment end', { segments: [seg('2026-09-15T08:00:00Z', 'garbage')] }],
    ['window start', { startsAt: 'garbage' }],
  ])('an unreadable %s fails loud', (what, over) => {
    expect(() => olaTeamMeasure(ticket(over as Partial<OLATicketFacts>), contract, 'UTC'))
      .toThrow(new RegExp(`unreadable ${what}`))
  })

  it('an unreadable contract creation date fails loud', () => {
    expect(() => olaTeamMeasure(ticket({}), { ...contract, createdAt: 'nope' }, 'UTC'))
      .toThrow(/unreadable contract creation "nope"/)
  })
})

describe('evaluateOLATeamTickets', () => {
  it('open tickets and tickets the contract does not apply to are not evaluated', () => {
    const now = new Date('2026-09-15T12:00:00Z')
    const open = ticket({ segments: [seg('2026-09-15T08:00:00Z', null)] })
    const other = ticket({ concludedAt: '2026-09-15T09:00:00Z', currentTeamId: 'x', segments: [] })
    const met = ticket({ concludedAt: '2026-09-15T09:00:00Z', segments: [seg('2026-09-15T08:00:00Z', '2026-09-15T09:00:00Z')] })
    expect(evaluateOLATeamTickets([open, other, met], contract, 'UTC', now)).toEqual({ evaluated: 1, met: 1, breached: 0, inferred: 0 })
  })
})

describe('read queries', () => {
  it('olaTicketFactsCypher reads the ticket by id within the tenant, using the type conclusion field', () => {
    const q = olaTicketFactsCypher('service_request')
    expect(q).toContain('MATCH (e:ServiceRequest {id: $entityId, tenant_id: $tenantId})')
    expect(q).toContain('e.completed_at AS concludedAt')
  })

  it.each([
    ['olaTicketFactsCypher', olaTicketFactsCypher],
    ['olaConcludedTicketsCypher', olaConcludedTicketsCypher],
  ])('%s refuses an unknown type and a change (measured on its tasks)', (_name, fn) => {
    expect(() => fn('asset')).toThrow(/unknown ticket type "asset"/)
    expect(() => fn('change')).toThrow(/measured on its tasks/)
  })
})
