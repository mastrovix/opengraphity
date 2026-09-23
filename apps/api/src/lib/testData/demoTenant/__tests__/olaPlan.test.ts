/**
 * The OLA/UC contracts of the demo (tour of 23 Sep 2026). Until a contract
 * had a zone of its own, the generator could give contracts only to the
 * teams in the tenant's zone: a team in Singapore counted on its 9-18
 * calendar in Rome's hours would have been six or seven hours off. Now every
 * region's teams can have one, and a contract whose calendar is read in
 * another zone carries that zone.
 */
import { describe, it, expect } from 'vitest'
import { Rng } from '../random.js'
import { DAY, HOUR } from '../clock.js'
import { OlaFacts, calibratedTarget, planOlaContracts } from '../olaPlan.js'
import type { ConfigPlan, PlannedCalendar } from '../config.js'
import type { PeoplePlan, PlannedTeam } from '../people.js'

const NOW = Date.parse('2026-09-23T06:00:00Z')
const START = NOW - 365 * DAY

const calendar = (region: string, timeZone: string): PlannedCalendar => ({
  id: `cal-${region}`, name: `Business Hours ${region}`, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', holidays: [], region, timeZone,
})
const CAL_IT = calendar('Italy', 'Europe/Rome')
const CAL_APAC = calendar('APAC', 'Asia/Singapore')

const team = (id: string, region: string, sourcing: 'internal' | 'external'): PlannedTeam =>
  ({ id, name: `SUP_Service Desk ${region}`, type: 'support', isChangeManager: false, region, sourcing, area: 'Service Desk' }) as unknown as PlannedTeam

/** A concluded ticket that the team held for `hours`, starting on a working morning (UTC). */
function trail(teamId: string, i: number, hours: number) {
  const start = Date.parse('2026-03-02T01:00:00Z') + (i % 20) * 7 * DAY
  return {
    createdAtMs: start, resolvedAtMs: start + hours * HOUR, completedAtMs: null, teamId,
    segments: [{ team_id: teamId, started_at: new Date(start).toISOString(), ended_at: new Date(start + hours * HOUR).toISOString() }],
  }
}

describe('the contracts of the demo', () => {
  // Two internal desks — the first OLA counts round the clock, the second on business hours — and a supplier in APAC (a UC always counts on business hours).
  const teams = [team('t-it', 'Italy', 'internal'), team('t-apac', 'APAC', 'internal'), team('t-apac-ext', 'APAC', 'external')]
  const facts = new OlaFacts()
  for (const t of teams) for (let i = 0; i < 60; i++) facts.add('incident', trail(t.id, i, 4) as never)
  const people = { teams, users: [] } as unknown as PeoplePlan
  const config = { calendars: [CAL_IT, CAL_APAC], calendar: CAL_IT } as unknown as ConfigPlan
  const olas = planOlaContracts(new Rng('ola'), people, config, facts, 'Europe/Rome', START, NOW)
  const of = (teamId: string) => olas.find((o) => o.teamId === teamId)!

  it('a team outside the tenant\'s zone gets contracts too', () => {
    expect(olas.map((o) => o.teamId).sort()).toEqual(['t-apac', 't-apac-ext', 't-it'])
  })

  it('a contract on business hours carries its calendar\'s zone when it is not the tenant\'s; the others count in the tenant\'s', () => {
    // The supplier in APAC: business hours on the APAC calendar, read in Singapore.
    expect(of('t-apac-ext')).toMatchObject({ type: 'uc', calendarId: CAL_APAC.id, timezone: 'Asia/Singapore' })
    // Business hours on the tenant's own calendar: no zone of its own.
    const onHours = olas.filter((o) => o.type === 'ola' && o.calendarId !== null)
    expect(onHours.map((o) => [o.calendarId, o.timezone])).toEqual([[CAL_IT.id, null]])
    // Round the clock: no hours to place, no zone.
    for (const o of olas.filter((x) => x.calendarId === null)) expect(o.timezone).toBeNull()
    expect(olas.filter((x) => x.calendarId === null)).toHaveLength(1)
  })
})

describe('calibratedTarget', () => {
  it('measures in the contract\'s zone: the same hours are a working day in Singapore and a morning in Rome', () => {
    // 01:00-09:00 UTC on weekdays: 09:00-17:00 in Singapore, 03:00-11:00 in Rome.
    const tickets = Array.from({ length: 30 }, (_, i) => {
      const t = trail('t', i, 8)
      return { createdAt: new Date(t.createdAtMs).toISOString(), concludedAt: new Date(t.resolvedAtMs).toISOString(), currentTeamId: 't',
        segments: [{ teamId: 't', startedAt: t.segments[0]!.started_at, endedAt: t.segments[0]!.ended_at, inferred: false }] }
    })
    const cal = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', holidays: [] }
    const inSingapore = calibratedTarget(tickets, 't', START, true, cal, 'Europe/Rome', NOW, 'Asia/Singapore')
    const inRome = calibratedTarget(tickets, 't', START, true, cal, 'Europe/Rome', NOW, null)
    expect(inSingapore?.minutes).toBe(480)
    expect(inRome?.minutes).toBe(120)
  })
})
