/**
 * IL GUARDIANO CHE IL CODICE CITAVA E CHE NON ESISTEVA (20 set 2026, ondata 4).
 *
 * `packages/types/src/proposals.ts` dice, sopra `PROPOSAL_FORBIDDEN_ACTION_TYPES`:
 * «Il guardiano `proposalForbiddenActions.test.ts` tiene ferma la lista».
 * Quel file non c'era. Trovato leggendo il codice prima di aggiungere il primo
 * analista con un modello dentro — cioè esattamente il momento in cui quella
 * lista smette di essere teorica.
 *
 * Un commento che nomina un guardiano inesistente è peggio di nessun commento:
 * chi legge crede che qualcuno stia controllando.
 */
import { describe, it, expect } from 'vitest'
import {
  PROPOSAL_ACTION_TYPES, PROPOSAL_FORBIDDEN_ACTION_TYPES, isProposalActionType,
} from '@opengraphity/types'
import { assertAzioneAmmessa } from '../proposalActions.js'

describe('il catalogo è chiuso', () => {
  it('un tipo che non è nel catalogo viene rifiutato', () => {
    expect(() => assertAzioneAmmessa('qualunque_cosa', {})).toThrow(/closed catalogue/)
  })

  it('e i vietati non sono nel catalogo, ovviamente', () => {
    for (const vietato of PROPOSAL_FORBIDDEN_ACTION_TYPES) {
      expect(isProposalActionType(vietato), `«${vietato}» non deve essere un'azione valida`).toBe(false)
    }
  })

  it('le voci ammesse oggi sono quelle dichiarate, e sono poche apposta', () => {
    // Se questo elenco cresce senza che qualcuno ci pensi, il catalogo ha
    // smesso di essere chiuso e ha cominciato a essere un elenco. Questo
    // test è caduto quando è entrata la seconda voce — che è esattamente il
    // suo mestiere: costringere chi la aggiunge a dichiararla qui.
    expect(PROPOSAL_ACTION_TYPES).toEqual([
      'portal_severities.remove_stale',
      'automation.create_disabled',
      'enum_value_labels.fill',
    ])
  })
})

describe('i tre vietati non passano NEMMENO ANNIDATI', () => {
  it.each(PROPOSAL_FORBIDDEN_ACTION_TYPES)('«%s» nei parametri di primo livello', (vietato) => {
    expect(() => assertAzioneAmmessa('portal_severities.remove_stale', { azione: vietato }))
      .toThrow(/never carry/)
  })

  it.each(PROPOSAL_FORBIDDEN_ACTION_TYPES)('«%s» dentro una lista di azioni di un\'automazione', (vietato) => {
    // Il caso che il commento nomina: una proposta che crea un'automazione le
    // cui azioni contengono un vietato. La proposta è ammessa, il suo carico no.
    expect(() => assertAzioneAmmessa('portal_severities.remove_stale', {
      automazione: { nome: 'x', azioni: [{ tipo: 'set_field' }, { tipo: vietato }] },
    })).toThrow(/never carry/)
  })

  it.each(PROPOSAL_FORBIDDEN_ACTION_TYPES)('«%s» in fondo a un annidamento profondo', (vietato) => {
    expect(() => assertAzioneAmmessa('portal_severities.remove_stale', {
      a: { b: { c: { d: [{ e: { f: vietato } }] } } },
    })).toThrow(/never carry/)
  })

  it('anche come CHIAVE, non solo come valore', () => {
    expect(() => assertAzioneAmmessa('portal_severities.remove_stale', { execute_script: 'no' }))
      .toThrow(/never carry/)
  })
})

describe('quello che invece deve passare', () => {
  it('un\'azione del catalogo con parametri innocui', () => {
    expect(assertAzioneAmmessa('portal_severities.remove_stale', {})).toBe('portal_severities.remove_stale')
    expect(assertAzioneAmmessa('portal_severities.remove_stale', { nota: 'tolgo due severità' }))
      .toBe('portal_severities.remove_stale')
  })

  it('una parola che CONTIENE un vietato ma non lo è — il controllo è per sottostringa, e va saputo', () => {
    // Documenta il comportamento reale invece di fingere che sia più fine di
    // così: `JSON.stringify(params).includes(vietato)` prende anche
    // «non_execute_script». È un falso positivo, ed è la parte giusta in cui
    // sbagliare: rifiuta una proposta legittima invece di lasciarne passare
    // una pericolosa.
    expect(() => assertAzioneAmmessa('portal_severities.remove_stale', { nota: 'non_execute_script' }))
      .toThrow(/never carry/)
  })
})
