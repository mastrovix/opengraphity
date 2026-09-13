/**
 * «Crea senza SLA» toglie il ticket dagli avvisi di configurazione: la
 * decisione è dello staff, che vede l'avviso nel form. Dal portale si rifiuta.
 */
import { describe, it, expect } from 'vitest'
import { assertMayAcknowledgeNoSla } from '../slaAcknowledgement.js'

describe('assertMayAcknowledgeNoSla', () => {
  it('lo staff può accettare', () => {
    for (const role of ['admin', 'operator', 'viewer'] as const) {
      expect(() => assertMayAcknowledgeNoSla({ role }, true)).not.toThrow()
    }
  })
  it('un utente del portale no: rifiuto esplicito, non ignorato', () => {
    expect(() => assertMayAcknowledgeNoSla({ role: 'end_user' }, true)).toThrow(/Only staff/)
  })
  it('senza accettazione nessun controllo, per nessun ruolo', () => {
    expect(() => assertMayAcknowledgeNoSla({ role: 'end_user' }, undefined)).not.toThrow()
    expect(() => assertMayAcknowledgeNoSla({ role: 'end_user' }, false)).not.toThrow()
  })
})
