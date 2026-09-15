/**
 * Secondo giro UI del 15 set 2026 · V-17: il report OLA/UC contava per ogni
 * contratto tutti i ticket conclusi, di qualunque team, misurati 24×7.
 */
import { describe, it, expect } from 'vitest'
import { evaluateOLATickets, olaTicketState, olaConcludedTicketsCypher, olaEntityTypes } from '../olaAttainment.js'

const CAL = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', holidays: [] }

describe('olaAttainment', () => {
  it('la lettura filtra per team del contratto e per nascita dopo il contratto', () => {
    const c = olaConcludedTicketsCypher('incident')
    expect(c).toContain('MATCH (e:Incident {tenant_id: $tenantId})')
    expect(c).toContain('(e)-[:ASSIGNED_TO_TEAM]->(:Team {id: $teamId, tenant_id: $tenantId})')
    expect(c).toContain('e.created_at >= $contractCreatedAt')
    expect(c).toContain('e.resolved_at >= $cutoff')
    expect(olaConcludedTicketsCypher('service_request')).toContain('e.completed_at')
  })

  it('«any» copre i quattro tipi di ticket; un ambito sconosciuto è un errore', () => {
    expect(olaEntityTypes('any').sort()).toEqual(['change', 'incident', 'problem', 'service_request'])
    expect(olaEntityTypes('problem')).toEqual(['problem'])
    expect(() => olaEntityTypes('kb_article')).toThrow(/not a ticket type/)
  })

  it('24×7: rispettato se concluso entro l\'obiettivo', () => {
    const r = evaluateOLATickets([
      { createdAt: '2026-09-14T08:00:00Z', concludedAt: '2026-09-14T15:00:00Z' },  // 7 h
      { createdAt: '2026-09-14T08:00:00Z', concludedAt: '2026-09-14T17:00:00Z' },  // 9 h
    ], { resolveMinutes: 480, businessHours: false, calendar: null }, 'UTC')
    expect(r).toEqual({ evaluated: 2, met: 1, breached: 1 })
  })

  it('col calendario del contratto: 8 h lavorative da lunedì 16:00 scadono martedì 16:00', () => {
    const t = [{ createdAt: '2026-09-14T16:00:00Z', concludedAt: '2026-09-15T15:30:00Z' }]  // lun → mar, 7 h 30 lavorative
    expect(evaluateOLATickets(t, { resolveMinutes: 480, businessHours: true, calendar: CAL }, 'UTC')).toEqual({ evaluated: 1, met: 1, breached: 0 })
    // lo stesso ticket misurato 24×7 (23 h 30) sarebbe violato: era il difetto
    expect(evaluateOLATickets(t, { resolveMinutes: 480, businessHours: false, calendar: null }, 'UTC')).toEqual({ evaluated: 1, met: 0, breached: 1 })
  })

  it('date illeggibili: errore, non un ticket contato', () => {
    expect(() => evaluateOLATickets([{ createdAt: 'boh', concludedAt: '2026-09-15T00:00:00Z' }], { resolveMinutes: 60, businessHours: false, calendar: null }, 'UTC')).toThrow(/unreadable ticket dates/)
  })
})

describe('olaTicketState — il riquadro OLA/UC del ticket (secondo giro UI del 15 set 2026)', () => {
  const contract = { resolveMinutes: 240, businessHours: false, calendar: null }
  it('concluso entro la scadenza: rispettato, con la scadenza calcolata', () => {
    expect(olaTicketState({ createdAt: '2026-09-15T08:00:00.000Z', concludedAt: '2026-09-15T11:00:00.000Z' }, contract, 'Europe/Rome'))
      .toEqual({ deadline: '2026-09-15T12:00:00.000Z', state: 'met' })
  })
  it('concluso dopo la scadenza: violato', () => {
    expect(olaTicketState({ createdAt: '2026-09-15T08:00:00.000Z', concludedAt: '2026-09-15T13:00:00.000Z' }, contract, 'Europe/Rome').state).toBe('breached')
  })
  it('aperto: in corso prima della scadenza, violato dopo', () => {
    const t = { createdAt: '2026-09-15T08:00:00.000Z', concludedAt: null }
    expect(olaTicketState(t, contract, 'Europe/Rome', new Date('2026-09-15T10:00:00.000Z')).state).toBe('running')
    expect(olaTicketState(t, contract, 'Europe/Rome', new Date('2026-09-15T12:30:00.000Z')).state).toBe('breached')
  })
})
