/**
 * ESSERE D'ACCORDO (20 set 2026).
 *
 * Nasce da una domanda del proprietario davanti a due proposte di
 * piattaforma: «come faccio ad accettare???». Non poteva. Sei generi su otto
 * non portano un'azione, `acceptProposal` alza `nothingToExecute`, e la
 * pagina mostra «Accetta» solo se c'è un'azione — quindi chi era d'accordo
 * doveva RIFIUTARE per dirlo, piantando anche una lapide di trenta giorni.
 *
 * Due regole qui contano più delle altre:
 *  - «preso atto» esiste SOLO dove «accetta» non arriva, se no sono due
 *    bottoni che dicono quasi la stessa cosa;
 *  - «apri un Problem» esiste solo dove un Problem è la cosa giusta.
 */
import { describe, it, expect } from 'vitest'
import {
  puoPrendereAtto, puoAprireUnProblem, GENERI_DA_PROBLEM, GENERI_OPERATIVI_DA_PROBLEM,
  titoloDelProblem, descrizioneDelProblem, MAX_DESCRIZIONE,
} from '../proposalAgreement.js'

const riga = (e: Record<string, unknown> = {}) => ({
  status: 'open', action: null, kind: 'proposal.platformSharedFault', ...e,
} as never)

describe('«preso atto» riempie il buco, non lo raddoppia', () => {
  it('si può su una proposta aperta senza azione', () => {
    expect(puoPrendereAtto(riga())).toBe(true)
  })

  it('si può anche su una rimandata: «non ora» non è una decisione', () => {
    expect(puoPrendereAtto(riga({ status: 'not_now' }))).toBe(true)
  })

  it('NON si può se la proposta porta un\'azione: quella si accetta eseguendola', () => {
    expect(puoPrendereAtto(riga({ action: { type: 'enum_value_labels.fill', params: {} } }))).toBe(false)
  })

  it.each(['accepted', 'rejected', 'expired', 'superseded'])(
    'NON si può su una già decisa (%s)', (status) => {
      expect(puoPrendereAtto(riga({ status }))).toBe(false)
    })
})

describe('un Problem si apre solo dove un Problem è la cosa giusta', () => {
  it('i tre guasti di piattaforma sì', () => {
    for (const kind of GENERI_DA_PROBLEM) {
      expect(puoAprireUnProblem(riga({ kind })), kind).toBe(true)
    }
  })

  it.each([
    'proposal.dailyWorkSlowStep',
    'proposal.dailyWorkInstantStep',
    'proposal.dailyWorkPairToAutomation',
    'proposal.configMissingLabels',
    'proposal.portalSeveritiesStale',
  ])('«%s» no: non è un guasto, e la lista dei problem resta credibile', (kind) => {
    expect(puoAprireUnProblem(riga({ kind }))).toBe(false)
  })

  it('il catalogo è chiuso e piccolo: aggiungerne uno deve essere un gesto che si vede', () => {
    expect([...GENERI_DA_PROBLEM].sort()).toEqual([
      'proposal.platformErrorSpike',
      'proposal.platformRecurringError',
      'proposal.platformSharedFault',
    ])
  })

  it('a remedy that did not hold (26 Sep 2026): yes — the product tried, and the same thing keeps breaking', () => {
    for (const kind of GENERI_OPERATIVI_DA_PROBLEM) {
      expect(puoAprireUnProblem(riga({ kind })), kind).toBe(true)
    }
    // The remedy itself is not a fault: it is accepted by running it.
    expect(puoAprireUnProblem(riga({ kind: 'proposal.operationsFailedJobs', action: { type: 'queue.retry_failed', params: {} } }))).toBe(false)
  })

  it('and the remedies that did not hold are a set of their own: the platform one also says which Problems go to GitHub', () => {
    expect([...GENERI_OPERATIVI_DA_PROBLEM].sort()).toEqual([
      'proposal.operationsCIHealthOutOfStepNotHeld',
      'proposal.operationsFailedJobsNotHeld',
      'proposal.operationsStaleServiceMapNotHeld',
      'proposal.operationsStuckAlarmsNotHeld',
      'proposal.operationsStuckWorkflowsNotHeld',
    ])
    for (const kind of GENERI_OPERATIVI_DA_PROBLEM) expect(GENERI_DA_PROBLEM.has(kind), kind).toBe(false)
  })

  it('e non si apre su una già decisa', () => {
    expect(puoAprireUnProblem(riga({ status: 'accepted' }))).toBe(false)
  })
})

describe('che cosa finisce nel Problem', () => {
  it('il titolo è fatto di DATI, non della frase della proposta', () => {
    // La frase la compone il browser nella lingua di chi guarda: il server
    // non sa in che lingua leggerà chi aprirà il Problem domani.
    expect(titoloDelProblem({ template: '[bullmq] queue connection error', service: 'opengrafo-api', module: 'bullmq' }))
      .toBe('[bullmq] queue connection error — opengrafo-api · bullmq')
  })

  it('a remedy that did not hold names what keeps breaking, from the data', () => {
    expect(titoloDelProblem({ queue: 'sla-jobs', count: '4' }, 'proposal.operationsFailedJobsNotHeld'))
      .toBe('Jobs keep failing in queue sla-jobs after a retry')
    expect(titoloDelProblem({ map: 'Billing' }, 'proposal.operationsStaleServiceMapNotHeld'))
      .toBe('Service map "Billing" stays behind the CMDB after a synchronization')
  })

  it('no rationale, no model: an operational Problem does not claim a model wrote it', () => {
    const d = descrizioneDelProblem({ rationale: null, occurrences: 4, windowDays: 1, fingerprint: 'f' } as never)
    expect(d).not.toContain('model')
    expect(d).toContain('a remedy of the product did not hold')
  })

  it('senza dati utili non resta un titolo vuoto', () => {
    expect(titoloDelProblem({}).length).toBeGreaterThan(0)
    expect(titoloDelProblem(undefined).length).toBeGreaterThan(0)
  })

  it('il titolo sta nel limite di `createProblem` (500)', () => {
    expect(titoloDelProblem({ template: 'x'.repeat(2000) }).length).toBeLessThanOrEqual(500)
  })

  it('la descrizione dice che la prosa l\'ha scritta un MODELLO', () => {
    const d = descrizioneDelProblem({
      rationale: 'Tre processi sbagliano insieme.', occurrences: 234, windowDays: 1, fingerprint: 'abc',
    } as never)
    expect(d).toContain('Tre processi sbagliano insieme.')
    expect(d).toContain('written by a model')
    // E porta le misure e l'impronta: da qui si risale alla proposta.
    expect(d).toContain('234')
    expect(d).toContain('abc')
  })

  it('una descrizione enorme viene tagliata', () => {
    const d = descrizioneDelProblem({
      rationale: 'x'.repeat(MAX_DESCRIZIONE * 2), occurrences: 1, windowDays: 1, fingerprint: 'f',
    } as never)
    expect(d.length).toBeLessThanOrEqual(MAX_DESCRIZIONE)
  })
})
