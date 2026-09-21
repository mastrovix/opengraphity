/**
 * «Crea senza SLA» toglie il ticket dagli avvisi di configurazione: la
 * decisione è dello staff, che vede l'avviso nel form. Dal portale si rifiuta.
 */
import { describe, it, expect } from 'vitest'
import { assertMayAcknowledgeNoSla } from '../slaAcknowledgement.js'
import { perms } from './testPermissions.js'

describe('assertMayAcknowledgeNoSla', () => {
  it('lo staff può accettare', () => {
    for (const role of ['admin', 'operator', 'viewer'] as const) {
      expect(() => assertMayAcknowledgeNoSla({ permissions: perms(role) }, true)).not.toThrow()
    }
  })
  it('un utente del portale no: rifiuto esplicito, non ignorato', () => {
    expect(() => assertMayAcknowledgeNoSla({ permissions: perms('end_user') }, true)).toThrow(/Only staff/)
  })
  it('senza accettazione nessun controllo, per nessun ruolo', () => {
    expect(() => assertMayAcknowledgeNoSla({ permissions: perms('end_user') }, undefined)).not.toThrow()
    expect(() => assertMayAcknowledgeNoSla({ permissions: perms('end_user') }, false)).not.toThrow()
  })
})
