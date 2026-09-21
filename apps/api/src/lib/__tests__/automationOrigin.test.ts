/**
 * L'ORIGINE DI UN'AUTOMAZIONE E LA SBARRA DELL'ACCENSIONE
 * (20 set 2026, prerequisito dell'ondata 6).
 *
 * Il rilievo della revisione era: «automazione disattivata riapre
 * `execute_script` / `call_webhook`». Il ragionamento dietro: una proposta
 * crea un'automazione spenta e innocua, poi qualcuno ne cambia le azioni,
 * poi qualcuno la accende — e a quel punto nessun controllo guarda più che
 * cosa contiene. Il momento pericoloso non è la creazione: è l'ACCENSIONE.
 *
 * Questi test tengono ferma quella sbarra.
 */
import { describe, it, expect } from 'vitest'
import {
  tipiDelleAzioni, assertAzioniAmmesseDaProposta, assertAccensioneAmmessa, origineDi,
} from '../automationOrigin.js'
import { AZIONI_AMMESSE_DA_PROPOSTA, PROPOSAL_FORBIDDEN_ACTION_TYPES } from '@opengraphity/types'

const json = (tipi: string[]) => JSON.stringify(tipi.map((t) => ({ type: t, params: {} })))

describe('che cosa un\'automazione nata da una proposta può contenere', () => {
  it('le quattro dell\'allowlist passano', () => {
    expect(() => assertAzioniAmmesseDaProposta(json([...AZIONI_AMMESSE_DA_PROPOSTA]))).not.toThrow()
  })

  it.each(PROPOSAL_FORBIDDEN_ACTION_TYPES)('«%s» non passa MAI', (vietato) => {
    expect(() => assertAzioniAmmesseDaProposta(json([vietato]))).toThrow(/may only contain/)
  })

  it('e non passa nemmeno nascosta in mezzo a quelle buone', () => {
    expect(() => assertAzioniAmmesseDaProposta(json(['set_field', 'execute_script', 'create_comment'])))
      .toThrow(/execute_script/)
  })

  it('un\'azione del catalogo generale ma FUORI dall\'allowlist ristretta non passa', () => {
    // `assign_user` e `set_priority` sono azioni legittime di un'automazione
    // scritta a mano. L'allowlist delle proposte è più stretta apposta.
    expect(() => assertAzioniAmmesseDaProposta(json(['assign_user']))).toThrow(/assign_user/)
    expect(() => assertAzioniAmmesseDaProposta(json(['set_priority']))).toThrow(/set_priority/)
  })

  it('l\'errore NOMINA l\'azione: chi legge deve sapere quale, non che «qualcosa non va»', () => {
    expect(() => assertAzioniAmmesseDaProposta(json(['call_webhook'])))
      .toThrow(/it contains: call_webhook/)
  })
})

describe('un\'automazione che non sappiamo leggere non si accende', () => {
  it.each([
    ['un JSON rotto',            '{non json'],
    ['un oggetto invece di una lista', '{"type":"set_field"}'],
    ['un\'azione senza tipo',    '[{"params":{}}]'],
    ['un tipo vuoto',            '[{"type":""}]'],
    ['un numero al posto del JSON', 42],
  ])('%s alza, non passa', (_nome, grezzo) => {
    expect(() => tipiDelleAzioni(grezzo)).toThrow()
  })

  it('il vuoto invece è vuoto, e va bene: un\'automazione senza azioni non fa niente', () => {
    expect(tipiDelleAzioni(null)).toEqual([])
    expect(tipiDelleAzioni('')).toEqual([])
    expect(tipiDelleAzioni('[]')).toEqual([])
  })
})

describe('la sbarra si applica SOLO a chi è nato da una proposta', () => {
  it('un\'automazione scritta a mano può contenere quello che il catalogo generale permette', () => {
    // Chi la scrive è un amministratore che sa cosa sta facendo, e ha i suoi
    // permessi. La sbarra ristretta non è per lui.
    expect(() => assertAccensioneAmmessa('manual', json(['execute_script']))).not.toThrow()
  })

  it('una nata da una proposta no, nemmeno se qualcuno l\'ha modificata dopo', () => {
    expect(() => assertAccensioneAmmessa('ai_proposal', json(['execute_script']))).toThrow()
  })

  it('e se è nata da una proposta ed è ancora pulita, si accende', () => {
    expect(() => assertAccensioneAmmessa('ai_proposal', json(['set_field']))).not.toThrow()
  })
})

describe('l\'origine letta dal nodo', () => {
  it('quella dichiarata, quando c\'è', () => {
    expect(origineDi({ origin: 'ai_proposal' })).toBe('ai_proposal')
    expect(origineDi({ origin: 'manual' })).toBe('manual')
  })

  it('un nodo di prima di questo campo l\'ha scritto una persona: non esisteva altro modo', () => {
    expect(origineDi({})).toBe('manual')
  })

  it('e un valore che non conosciamo vale `manual`, il comportamento di prima', () => {
    // Non `ai_proposal`: nel dubbio non si applica una sbarra che ferma
    // un'automazione di qualcuno, si torna a com'era.
    expect(origineDi({ origin: 'qualcosa_di_nuovo' })).toBe('manual')
  })
})
