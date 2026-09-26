/**
 * LE REGOLE DELLE PROPOSTE che non devono cambiare per sbaglio (20 set 2026).
 *
 * Tre di queste regole sono nate da altrettanti rilievi della revisione, e
 * senza un test tornerebbero a rompersi senza che nessuno se ne accorga:
 * la fascia delle prove (che rende eseguibile «le prove sono cambiate in modo
 * sostanziale»), il raffreddamento del rifiuto, e l'elenco dei tipi d'azione
 * che una proposta non può portare mai.
 */
import { describe, it, expect } from 'vitest'
import {
  evidenceGrade, proposalMayReturn,
  PROPOSAL_FORBIDDEN_ACTION_TYPES, PROPOSAL_ACTION_TYPES,
  PROPOSAL_OPEN_STATUSES, PROPOSAL_STATUSES,
  PROPOSAL_REJECTION_COOLDOWN_DAYS,
  isProposalActionType,
} from '../proposals.js'

describe('la fascia delle prove', () => {
  it('cresce per RADDOPPI, non per unità: è questo che la rende utile', () => {
    expect(evidenceGrade(1)).toBe(0)
    expect(evidenceGrade(47)).toBe(5)
    expect(evidenceGrade(52)).toBe(5)   // 47 → 52 è la stessa fascia
    expect(evidenceGrade(190)).toBe(7)  // 47 → 190 no
  })

  it('zero e i numeri storti non fanno esplodere niente', () => {
    expect(evidenceGrade(0)).toBe(0)
    expect(evidenceGrade(-3)).toBe(0)
    expect(evidenceGrade(Number.NaN)).toBe(0)
  })
})

describe('quando una proposta rifiutata può tornare', () => {
  const rifiutata = new Date('2026-01-01T00:00:00Z')
  const dopo = (giorni: number) => new Date(rifiutata.getTime() + giorni * 86_400_000)

  it('NON torna prima del raffreddamento, nemmeno con prove molto più forti', () => {
    expect(proposalMayReturn({
      rejectedGrade: 5, currentN: 5000, rejectedAt: rifiutata, now: dopo(PROPOSAL_REJECTION_COOLDOWN_DAYS - 1),
    })).toBe(false)
  })

  it('NON torna se le prove sono cresciute ma dentro la stessa fascia', () => {
    // È il caso che, senza la fascia, la farebbe tornare ogni notte.
    expect(proposalMayReturn({
      rejectedGrade: 5, currentN: 52, rejectedAt: rifiutata, now: dopo(90),
    })).toBe(false)
  })

  it('torna quando è passato il tempo E le prove sono cambiate di fascia', () => {
    expect(proposalMayReturn({
      rejectedGrade: 5, currentN: 190, rejectedAt: rifiutata, now: dopo(31),
    })).toBe(true)
  })

  it('prove più DEBOLI non la fanno tornare', () => {
    expect(proposalMayReturn({
      rejectedGrade: 7, currentN: 12, rejectedAt: rifiutata, now: dopo(365),
    })).toBe(false)
  })
})

describe('il catalogo chiuso', () => {
  /**
   * IL CATALOGO È CHIUSO, e allungarlo deve costare una riga QUI.
   *
   * Questo test è nato con una voce sola e ha fatto il suo mestiere: le ondate
   * dopo ne hanno aggiunte due, e lui è diventato rosso. Solo che nessuno lo
   * ha visto, perché `packages/types` non aveva uno script `test` — la
   * cartella `__tests__` c'era e non la lanciava nessuno (22 set 2026).
   *
   * Ogni voce nuova va aggiunta qui a mano, col suo perché a fianco: è il solo
   * modo perché «una proposta può fare questa cosa nuova» sia una decisione e
   * non una riga scivolata dentro.
   */
  it('porta QUATTRO voci, e ognuna è stata una decisione', () => {
    expect(PROPOSAL_ACTION_TYPES).toEqual([
      // Ondata 1: toglie le severità del portale che non si usano più.
      'portal_severities.remove_stale',
      // Ondata 6: la prima che CREA qualcosa — un'automazione, spenta.
      'automation.create_disabled',
      // Ondata 6: l'unica in cui il modello scrive testo che le persone leggono.
      'enum_value_labels.fill',
      // 26 Sep 2026, the running of a tenant: retries failed jobs; verified, not undone.
      'queue.retry_failed',
      // 26 Sep 2026: the four remedies of the graph (lib/operationsGraphRemedies.ts); ticket ids, never a target step.
      'events.reevaluate_stuck',
      'service_map.sync',
      'ci.recompute_health',
      'workflow.resume_automatic',
    ])
  })

  it('SCRIPT, WEBHOOK E TRANSIZIONI non sono mai azioni di una proposta', () => {
    // La lista degli esclusi non si accorcia: se un giorno qualcuno la tocca,
    // questo test cade e chi lo fa deve spiegare perché.
    expect(PROPOSAL_FORBIDDEN_ACTION_TYPES).toContain('execute_script')
    expect(PROPOSAL_FORBIDDEN_ACTION_TYPES).toContain('call_webhook')
    expect(PROPOSAL_FORBIDDEN_ACTION_TYPES).toContain('transition_workflow')
    for (const vietato of PROPOSAL_FORBIDDEN_ACTION_TYPES) {
      expect(isProposalActionType(vietato), vietato).toBe(false)
    }
  })
})

describe('gli stati', () => {
  it('«non ora» occupa uno slot del tetto, le decise no', () => {
    // Se `not_now` non occupasse uno slot, rimandare tutto sarebbe un modo per
    // farsi inondare di proposte.
    expect([...PROPOSAL_OPEN_STATUSES].sort()).toEqual(['not_now', 'open'])
    for (const s of ['accepted', 'rejected', 'expired', 'superseded'] as const) {
      expect(PROPOSAL_OPEN_STATUSES).not.toContain(s)
    }
  })

  it('«scaduta» esiste: senza, cinque proposte ignorate spengono la funzione in silenzio', () => {
    expect(PROPOSAL_STATUSES).toContain('expired')
  })
})
