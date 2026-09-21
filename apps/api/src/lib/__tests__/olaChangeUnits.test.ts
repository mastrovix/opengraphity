/**
 * Le misure OLA/UC di una change (secondo giro UI del 15 set 2026, decisioni del
 * proprietario): ogni task di assessment a sé; ogni passo del piano due volte,
 * validazione e rilascio, dall'inizio della sua finestra al test registrato e al
 * deployment eseguito.
 */
import { describe, it, expect } from 'vitest'
import { changeUnitsFromRows, olaUnitAlertKey, assessmentUnitsCypher, deployPlanUnitsCypher } from '../olaChangeUnits.js'
import { olaTeamMeasure } from '../olaAttainment.js'

const TZ = 'UTC'
const rule = (teamId: string, resolveMinutes = 120) => ({ teamId, createdAt: '2026-09-01T00:00:00Z', resolveMinutes, businessHours: false, calendar: null })
const change = { ticketId: 'chg-7', ticketNumber: 'CHG00000007', ticketTitle: 'Rilascio portale' }

const assessment = (over: Record<string, unknown> = {}) => ({
  ...change, id: 'at-1', createdAt: '2026-09-15T10:00:00Z', concludedAt: null, responderRole: 'owner', alerted: [], currentTeamId: 'rete', ciName: 'Portale',
  segments: [{ teamId: 'rete', startedAt: '2026-09-15T10:00:00Z', endedAt: null, inferred: false }], ...over,
})
const plan = (over: Record<string, unknown> = {}) => ({
  ...change, id: 'dp-1', createdAt: '2026-09-15T10:00:00Z', alerted: [], ciName: 'Portale', ownerTeamId: 'app', supportTeamId: 'sistemi',
  steps: JSON.stringify([
    { title: 'Rilascio 2.4', validationWindow: { start: '2026-09-17T07:00:00Z', end: '2026-09-17T09:00:00Z' }, releaseWindow: { start: '2026-09-17T18:00:00Z', end: '2026-09-17T20:00:00Z' } },
    { title: 'Riavvio', validationWindow: { start: '', end: '' }, releaseWindow: { start: '2026-09-17T21:00:00Z', end: '2026-09-17T22:00:00Z' } },
  ]),
  testedAt: null, deployedAt: null, ...over,
})

describe('changeUnitsFromRows', () => {
  it('una misura per assessment; per ogni passo validazione e rilascio, saltando le finestre non pianificate', () => {
    const units = changeUnitsFromRows([assessment()], [plan()])
    expect(units.map((u) => u.key)).toEqual(['assessment:at-1', 'validation:dp-1:0', 'release:dp-1:0', 'release:dp-1:1'])
    const validation = units[1]!
    expect(validation).toMatchObject({ kind: 'validation', startsAt: '2026-09-17T07:00:00Z', currentTeamId: 'app', stepTitle: 'Rilascio 2.4', node: { label: 'DeployPlanTask', id: 'dp-1' } })
    expect(units[2]).toMatchObject({ kind: 'release', startsAt: '2026-09-17T18:00:00Z', currentTeamId: 'sistemi' })
  })

  it('la chiave dell\'avviso: il contratto per l\'assessment, contratto e misura per il piano', () => {
    const [a, v] = changeUnitsFromRows([assessment()], [plan()])
    expect(olaUnitAlertKey('c1', a!)).toBe('c1')
    expect(olaUnitAlertKey('c1', v!)).toBe('c1:validation:dp-1:0')
  })
})

describe('le misure di una change con olaTeamMeasure', () => {
  it('l\'esempio del proprietario: validazione 07:00→08:30 = 1h30, rilascio 18:00→19:10 = 1h10', () => {
    const [v, r] = changeUnitsFromRows([], [plan({ testedAt: '2026-09-17T08:30:00Z', deployedAt: '2026-09-17T19:10:00Z' })])
    expect(olaTeamMeasure(v!, rule('app'), TZ)).toMatchObject({ applies: true, usedMinutes: 90, state: 'met' })
    expect(olaTeamMeasure(r!, rule('sistemi'), TZ)).toMatchObject({ applies: true, usedMinutes: 70, state: 'met' })
    // Il team support non conta sulla validazione, e viceversa.
    expect(olaTeamMeasure(v!, rule('sistemi'), TZ)).toMatchObject({ applies: false, reason: 'other_team' })
  })

  it('prima della finestra il tempo non corre: pianificato, con la scadenza dall\'inizio della finestra', () => {
    const [v] = changeUnitsFromRows([], [plan()])
    const m = olaTeamMeasure(v!, rule('app'), TZ, new Date('2026-09-16T12:00:00Z'))
    expect(m).toMatchObject({ applies: true, usedMinutes: 0, state: 'scheduled', deadline: '2026-09-17T09:00:00.000Z' })
  })

  it('fatto prima della finestra: zero, rispettato', () => {
    const [v] = changeUnitsFromRows([], [plan({ testedAt: '2026-09-15T16:00:00Z' })])
    expect(olaTeamMeasure(v!, rule('app'), TZ)).toMatchObject({ applies: true, usedMinutes: 0, state: 'met' })
  })

  it('dentro la finestra e oltre l\'obiettivo: violato', () => {
    const [v] = changeUnitsFromRows([], [plan()])
    expect(olaTeamMeasure(v!, rule('app', 60), TZ, new Date('2026-09-17T08:30:00Z'))).toMatchObject({ usedMinutes: 90, state: 'breached' })
  })

  it('assessment riassegnato: ogni team il suo tempo', () => {
    const [a] = changeUnitsFromRows([assessment({
      concludedAt: '2026-09-15T14:00:00Z', currentTeamId: 'sistemi',
      segments: [
        { teamId: 'rete', startedAt: '2026-09-15T10:00:00Z', endedAt: '2026-09-15T11:00:00Z', inferred: false },
        { teamId: 'sistemi', startedAt: '2026-09-15T11:00:00Z', endedAt: null, inferred: false },
      ],
    })], [])
    expect(olaTeamMeasure(a!, rule('rete'), TZ)).toMatchObject({ usedMinutes: 60, state: 'met' })
    expect(olaTeamMeasure(a!, rule('sistemi'), TZ)).toMatchObject({ usedMinutes: 180, state: 'breached' })
  })
})

describe('le letture', () => {
  it('aperte: change non conclusa né cancellata, task del team non completato', () => {
    const c = assessmentUnitsCypher('open')
    expect(c).toContain('t.completed_at IS NULL AND c.completed_at IS NULL AND coalesce(c.deleted, false) = false')
    expect(c).toContain('(t)-[:ASSIGNED_TO_TEAM]->(:Team {id: $teamId})')
    expect(deployPlanUnitsCypher('open')).toContain('(v.tested_at IS NULL OR d.deployed_at IS NULL)')
  })
  it('concluse: nel periodo', () => {
    expect(assessmentUnitsCypher('concluded')).toContain('t.completed_at >= $cutoff')
    expect(deployPlanUnitsCypher('concluded')).toContain('(v.tested_at >= $cutoff OR d.deployed_at >= $cutoff)')
  })
})
