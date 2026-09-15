/**
 * Un contratto OLA/UC misura il tempo in cui il ticket è stato del suo team
 * (secondo giro UI del 15 set 2026, decisione del proprietario). Prima (V-17)
 * contava dall'apertura del ticket, col team che il ticket aveva alla fine.
 */
import { describe, it, expect } from 'vitest'
import { evaluateOLATeamTickets, olaConcludedTicketsCypher, olaEntityTypes, olaTeamMeasure, type OLATicketFacts } from '../olaAttainment.js'

const RETE = 'team-rete'
const SD = 'team-sd'
const contract = { teamId: RETE, createdAt: '2026-09-01T00:00:00Z', resolveMinutes: 240, businessHours: false, calendar: null }
const seg = (teamId: string, startedAt: string, endedAt: string | null, inferred = false) => ({ teamId, startedAt, endedAt, inferred })
const ticket = (over: Partial<OLATicketFacts>): OLATicketFacts => ({ createdAt: '2026-09-15T08:00:00Z', concludedAt: null, currentTeamId: RETE, segments: [], ...over })

describe('olaTeamMeasure — il tempo del team', () => {
  it('il tempo prima dell\'arrivo al team non si conta: 3 ore al Service Desk, 1 ora a Rete → rispettato', () => {
    const m = olaTeamMeasure(ticket({
      concludedAt: '2026-09-15T12:00:00Z',
      segments: [seg(SD, '2026-09-15T08:00:00Z', '2026-09-15T11:00:00Z'), seg(RETE, '2026-09-15T11:00:00Z', null)],
    }), contract, 'UTC')
    expect(m).toMatchObject({ applies: true, usedMinutes: 60, state: 'met', inferred: false })
  })

  it('più passaggi dallo stesso team si sommano', () => {
    const m = olaTeamMeasure(ticket({
      concludedAt: '2026-09-15T20:00:00Z', currentTeamId: SD,
      segments: [seg(RETE, '2026-09-15T08:00:00Z', '2026-09-15T10:00:00Z'), seg(SD, '2026-09-15T10:00:00Z', '2026-09-15T12:00:00Z'), seg(RETE, '2026-09-15T12:00:00Z', '2026-09-15T15:00:00Z'), seg(SD, '2026-09-15T15:00:00Z', null)],
    }), contract, 'UTC')
    expect(m).toMatchObject({ usedMinutes: 300, state: 'breached' })
  })

  it('aperto e del team: in corso, con la scadenza calcolata su quello che resta', () => {
    const m = olaTeamMeasure(ticket({ segments: [seg(RETE, '2026-09-15T08:00:00Z', null)] }), contract, 'UTC', new Date('2026-09-15T09:00:00Z'))
    expect(m).toMatchObject({ state: 'running', usedMinutes: 60, remainingMinutes: 180, deadline: '2026-09-15T12:00:00.000Z' })
  })

  it('aperto, passato ad altri entro l\'obiettivo: passato ad altri; oltre: violato anche se ora è di altri', () => {
    const handed = ticket({ currentTeamId: SD, segments: [seg(RETE, '2026-09-15T08:00:00Z', '2026-09-15T09:00:00Z'), seg(SD, '2026-09-15T09:00:00Z', null)] })
    expect(olaTeamMeasure(handed, contract, 'UTC', new Date('2026-09-15T20:00:00Z')).state).toBe('handed_off')
    const late = ticket({ currentTeamId: SD, segments: [seg(RETE, '2026-09-15T08:00:00Z', '2026-09-15T13:00:00Z'), seg(SD, '2026-09-15T13:00:00Z', null)] })
    expect(olaTeamMeasure(late, contract, 'UTC', new Date('2026-09-15T20:00:00Z')).state).toBe('breached')
  })

  it('arrivato al team già oltre l\'apertura: conta solo da quando il team lo ha (il vecchio V-17 lo dava violato)', () => {
    const m = olaTeamMeasure(ticket({ concludedAt: '2026-09-16T08:30:00Z', segments: [seg(SD, '2026-09-15T08:00:00Z', '2026-09-16T08:00:00Z'), seg(RETE, '2026-09-16T08:00:00Z', null)] }), contract, 'UTC')
    expect(m).toMatchObject({ usedMinutes: 30, state: 'met' })
  })

  it('non conta: il team non l\'ha mai avuto, o solo prima che il contratto esistesse', () => {
    expect(olaTeamMeasure(ticket({ currentTeamId: SD, segments: [seg(SD, '2026-09-15T08:00:00Z', null)] }), contract, 'UTC')).toMatchObject({ applies: false, reason: 'other_team' })
    const old = ticket({ createdAt: '2026-08-01T08:00:00Z', concludedAt: '2026-08-01T10:00:00Z', segments: [seg(RETE, '2026-08-01T08:00:00Z', null)] })
    expect(olaTeamMeasure(old, contract, 'UTC')).toMatchObject({ applies: false, reason: 'before_contract' })
  })

  it('in orario di servizio: le ore fuori calendario non si contano', () => {
    const cal = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', holidays: [] }
    const m = olaTeamMeasure(ticket({ concludedAt: '2026-09-21T10:00:00Z', segments: [seg(RETE, '2026-09-18T16:00:00Z', null)] }), { ...contract, businessHours: true, calendar: cal }, 'UTC')
    expect(m).toMatchObject({ usedMinutes: 120, state: 'met' })
  })

  it('un tratto ricostruito si dice (inferred)', () => {
    expect(olaTeamMeasure(ticket({ concludedAt: '2026-09-15T09:00:00Z', segments: [seg(RETE, '2026-09-15T08:00:00Z', null, true)] }), contract, 'UTC').inferred).toBe(true)
  })

  it('un contratto senza team (dato vecchio) conta dall\'apertura del ticket', () => {
    expect(olaTeamMeasure(ticket({ concludedAt: '2026-09-15T13:00:00Z', currentTeamId: SD, segments: [] }), { ...contract, teamId: null }, 'UTC'))
      .toMatchObject({ applies: true, usedMinutes: 300, state: 'breached', inferred: true })
  })
})

describe('evaluateOLATeamTickets e letture', () => {
  it('conta solo i conclusi su cui il contratto vale, e quanti con tratti ricostruiti', () => {
    const r = evaluateOLATeamTickets([
      ticket({ concludedAt: '2026-09-15T09:00:00Z', segments: [seg(RETE, '2026-09-15T08:00:00Z', null)] }),
      ticket({ concludedAt: '2026-09-15T14:00:00Z', segments: [seg(RETE, '2026-09-15T08:00:00Z', null, true)] }),
      ticket({ concludedAt: null, segments: [seg(RETE, '2026-09-15T08:00:00Z', null)] }),
      ticket({ concludedAt: '2026-09-15T09:00:00Z', currentTeamId: SD, segments: [seg(SD, '2026-09-15T08:00:00Z', null)] }),
    ], contract, 'UTC')
    expect(r).toEqual({ evaluated: 2, met: 1, breached: 1, inferred: 1 })
  })

  it('la lettura del report prende i ticket che il team ha avuto (tratti), non quelli che ha alla fine', () => {
    const c = olaConcludedTicketsCypher('incident')
    expect(c).toContain('EXISTS { (e)-[:TEAM_SEGMENT]->(:TicketTeamSegment {team_id: $teamId}) }')
    expect(c).not.toContain('created_at >= $contractCreatedAt')
    expect(olaConcludedTicketsCypher('service_request')).toContain('e.completed_at')
  })

  it('«any» copre i quattro tipi di ticket; un ambito sconosciuto è un errore', () => {
    expect(olaEntityTypes('any').sort()).toEqual(['change', 'incident', 'problem', 'service_request'])
    expect(() => olaEntityTypes('kb_article')).toThrow(/not a ticket type/)
  })
})
