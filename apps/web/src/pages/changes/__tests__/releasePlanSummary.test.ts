/**
 * IL PIANO COMPLESSIVO DI UNA CHANGE, in ordine di data.
 *
 * Quello che si pinna qui è l'ORDINE e la CONTA, perché sono le due cose che
 * un errore rende plausibili invece che visibili: un elenco ordinato male si
 * legge come un piano diverso, e un inviluppo che somma una data illeggibile
 * dà `NaN` senza dirlo.
 */
import { describe, it, expect } from 'vitest'
import type { AffectedCI, DeployStep } from '@/types/change'
import { riepilogoRilascio, contaFinestreDistinte } from '../releasePlanSummary'

const w = (start: string, end: string) => ({ start, end })

const passo = (title: string, val: [string, string], rel: [string, string]): DeployStep =>
  ({ title, validationWindow: w(...val), releaseWindow: w(...rel) })

/** Un CI impattato col suo piano. Gli assessment contano solo per l'avanzamento. */
const ci = (
  name: string,
  steps: DeployStep[],
  over: { taskCode?: string; pianoStato?: string; assess?: [string, string]; supportGroup?: string } = {},
): AffectedCI => {
  const [funz, tecn] = over.assess ?? ['completed', 'completed']
  return {
    ciPhase: 'assessment', riskScore: 3,
    ci: {
      id: `ci-${name}`, name, type: 'server', environment: 'production',
      ownerGroup: null,
      supportGroup: over.supportGroup ? { id: 't1', name: over.supportGroup } : null,
    },
    assessmentOwner:   { id: 'a1', code: 'TASK1', responderRole: 'owner',   status: funz, score: 3, completedBy: null, completedAt: null, assignedTeam: null, assignee: null, responses: [] },
    assessmentSupport: { id: 'a2', code: 'TASK2', responderRole: 'support', status: tecn, score: 3, completedBy: null, completedAt: null, assignedTeam: null, assignee: null, responses: [] },
    deployPlan: {
      id: `dp-${name}`, code: over.taskCode ?? `TASK-${name}`, status: over.pianoStato ?? 'completed',
      steps, completedBy: null, completedAt: null, assignedTeam: null, assignee: null,
    },
    validation: null, deployment: null, review: null,
  } as unknown as AffectedCI
}

describe('il piano complessivo è una cronologia', () => {
  it('mette in fila le finestre di TUTTI i CI, non un CI per volta', () => {
    const r = riepilogoRilascio([
      // Il secondo CI rilascia PRIMA del primo: se l'elenco seguisse l'ordine
      // dei CI invece delle date, questo test sarebbe l'unico a dirlo.
      ci('srv-app-01', [passo('Deploy 4.2', ['2026-09-22T20:00:00Z', '2026-09-22T21:00:00Z'], ['2026-09-22T22:00:00Z', '2026-09-22T23:00:00Z'])]),
      ci('db-prod-01', [passo('Backup',     ['2026-09-21T01:00:00Z', '2026-09-21T01:30:00Z'], ['2026-09-21T02:00:00Z', '2026-09-21T03:00:00Z'])]),
    ])
    expect(r.voci.map((v) => `${v.ciName}/${v.tipo}`)).toEqual([
      'db-prod-01/validation', 'db-prod-01/release',
      'srv-app-01/validation', 'srv-app-01/release',
    ])
  })

  it('ogni voce porta tipo, task e CI: è così che si reclama un piano', () => {
    const r = riepilogoRilascio([
      ci('srv-app-01', [passo('Stop servizi', ['2026-09-21T20:00:00Z', '2026-09-21T21:00:00Z'], ['2026-09-21T22:00:00Z', '2026-09-21T23:00:00Z'])], { taskCode: 'TASK00000042' }),
    ])
    expect(r.voci).toHaveLength(2)
    expect(r.voci[0]).toMatchObject({ tipo: 'validation', taskCode: 'TASK00000042', ciName: 'srv-app-01', stepTitle: 'Stop servizi' })
    expect(r.voci[1]).toMatchObject({ tipo: 'release',    taskCode: 'TASK00000042', ciName: 'srv-app-01' })
  })

  it('a pari ora la validazione viene prima del rilascio, non a caso', () => {
    const r = riepilogoRilascio([
      ci('x', [passo('P', ['2026-09-21T22:00:00Z', '2026-09-21T22:30:00Z'], ['2026-09-21T22:00:00Z', '2026-09-21T23:00:00Z'])]),
    ])
    expect(r.voci.map((v) => v.tipo)).toEqual(['validation', 'release'])
  })

  it('l\'inviluppo guarda i RILASCI, non le validazioni', () => {
    const r = riepilogoRilascio([
      // La validazione comincia alle 18: se entrasse nell'inviluppo, «cosa va
      // in produzione da quando» direbbe due ore prima del vero.
      ci('x', [passo('P', ['2026-09-21T18:00:00Z', '2026-09-21T19:00:00Z'], ['2026-09-21T20:00:00Z', '2026-09-21T21:00:00Z'])]),
    ])
    expect(r.inviluppo).toEqual({ start: '2026-09-21T20:00:00.000Z', end: '2026-09-21T21:00:00.000Z' })
  })
})

describe('le finestre distinte', () => {
  const f = (da: string, a: string) => ({ da: Date.parse(da), a: Date.parse(a) })

  it('due finestre adiacenti sono UN blocco: per chi approva è un fermo continuo', () => {
    expect(contaFinestreDistinte([
      f('2026-09-21T22:00:00Z', '2026-09-21T23:00:00Z'),
      f('2026-09-21T23:00:00Z', '2026-09-22T00:00:00Z'),
    ])).toBe(1)
  })

  it('un buco in mezzo fa due blocchi', () => {
    expect(contaFinestreDistinte([
      f('2026-09-21T22:00:00Z', '2026-09-21T23:00:00Z'),
      f('2026-09-21T23:30:00Z', '2026-09-22T00:00:00Z'),
    ])).toBe(2)
  })

  it('una finestra dentro l\'altra non aggiunge un blocco', () => {
    expect(contaFinestreDistinte([
      f('2026-09-21T22:00:00Z', '2026-09-22T02:00:00Z'),
      f('2026-09-21T23:00:00Z', '2026-09-22T00:00:00Z'),
    ])).toBe(1)
  })

  it('nessuna finestra, nessun blocco (e non uno)', () => {
    expect(contaFinestreDistinte([])).toBe(0)
  })

  it('tre CI in tre notti diverse: il riepilogo lo dice, l\'inviluppo da solo no', () => {
    const r = riepilogoRilascio([
      ci('a', [passo('P', ['2026-09-21T20:00:00Z', '2026-09-21T21:00:00Z'], ['2026-09-21T22:00:00Z', '2026-09-21T23:00:00Z'])]),
      ci('b', [passo('P', ['2026-09-23T20:00:00Z', '2026-09-23T21:00:00Z'], ['2026-09-23T22:00:00Z', '2026-09-23T23:00:00Z'])]),
      ci('c', [passo('P', ['2026-09-25T20:00:00Z', '2026-09-25T21:00:00Z'], ['2026-09-25T22:00:00Z', '2026-09-25T23:00:00Z'])]),
    ])
    expect(r.finestreDistinte).toBe(3)
    // L'inviluppo copre quattro giorni, ma il fermo vero è di tre ore in tutto.
    expect(r.inviluppo).toEqual({ start: '2026-09-21T22:00:00.000Z', end: '2026-09-25T23:00:00.000Z' })
  })
})

describe('quello che non si può mettere in fila si dice, non si nasconde', () => {
  it('un piano senza passi è elencato col suo task, fuori dalla cronologia', () => {
    const r = riepilogoRilascio([
      ci('srv-app-01', [passo('Deploy', ['2026-09-21T20:00:00Z', '2026-09-21T21:00:00Z'], ['2026-09-21T22:00:00Z', '2026-09-21T23:00:00Z'])]),
      ci('srv-app-02', [], { taskCode: 'TASK00000051', pianoStato: 'pending', supportGroup: 'Team Sistemi' }),
    ])
    expect(r.voci).toHaveLength(2)
    expect(r.senzaDate).toHaveLength(1)
    expect(r.senzaDate[0]).toMatchObject({ ciName: 'srv-app-02', taskCode: 'TASK00000051', vuoto: true, teamName: 'Team Sistemi' })
  })

  it('una data illeggibile non entra nell\'inviluppo: sommarla darebbe NaN in silenzio', () => {
    const r = riepilogoRilascio([
      ci('rotto', [passo('P', ['non-una-data', 'nemmeno'], ['neanche', 'questa'])], { taskCode: 'TASK-R' }),
      ci('buono', [passo('P', ['2026-09-21T20:00:00Z', '2026-09-21T21:00:00Z'], ['2026-09-21T22:00:00Z', '2026-09-21T23:00:00Z'])]),
    ])
    expect(r.voci.every((v) => Number.isFinite(v.inizio))).toBe(true)
    expect(r.inviluppo).toEqual({ start: '2026-09-21T22:00:00.000Z', end: '2026-09-21T23:00:00.000Z' })
    // E il piano rotto non sparisce: ha dei passi, ma date inservibili.
    expect(r.senzaDate[0]).toMatchObject({ ciName: 'rotto', vuoto: false })
  })

  it('una finestra che finisce prima di cominciare si rifiuta, invece di ordinarsi a rovescio', () => {
    const r = riepilogoRilascio([
      ci('x', [passo('P', ['2026-09-21T20:00:00Z', '2026-09-21T21:00:00Z'], ['2026-09-21T23:00:00Z', '2026-09-21T22:00:00Z'])]),
    ])
    expect(r.voci.map((v) => v.tipo)).toEqual(['validation'])
    expect(r.inviluppo).toBeNull()
  })
})

describe('l\'avanzamento si conta task per task', () => {
  it('conta i tre task di OGNI CI impattato, anche di quelli non ancora pianificati', () => {
    const r = riepilogoRilascio([
      ci('a', [passo('P', ['2026-09-21T20:00:00Z', '2026-09-21T21:00:00Z'], ['2026-09-21T22:00:00Z', '2026-09-21T23:00:00Z'])]),
      // Solo il funzionale è chiuso: gli altri due task pesano nel totale.
      ci('b', [], { assess: ['completed', 'pending'], pianoStato: 'pending' }),
    ])
    expect(r.taskTotali).toBe(6)
    expect(r.taskChiusi).toBe(4)
  })

  it('«compilato» e «completato» sono due conte diverse', () => {
    const r = riepilogoRilascio([
      // Ha dei passi ma il task è ancora aperto: si sta lavorando.
      ci('a', [passo('P', ['2026-09-21T20:00:00Z', '2026-09-21T21:00:00Z'], ['2026-09-21T22:00:00Z', '2026-09-21T23:00:00Z'])], { pianoStato: 'in-progress' }),
      ci('b', [passo('P', ['2026-09-22T20:00:00Z', '2026-09-22T21:00:00Z'], ['2026-09-22T22:00:00Z', '2026-09-22T23:00:00Z'])], { pianoStato: 'completed' }),
    ])
    expect(r.pianiCompilati).toBe(2)
    expect(r.pianiCompletati).toBe(1)
  })
})
