/**
 * UNA SQUADRA CHE VIENE DALLE RISPOSTE (20 set 2026, ondata 4).
 *
 * Il proprietario l'ha detto così: la squadra «viene solitamente scelta in
 * base alle scelte fatte nella form», per esempio «con degli if nel
 * javascript del campo: se Milano allora xxx, se Roma allora yyy».
 *
 * Per farlo, dei RIFERIMENTI — che sono nodi del grafo e non proprietà — ne
 * è entrato uno solo fra i campi calcolabili: la squadra. La formula
 * restituisce il NOME e il server lo risolve in un nodo `Team`.
 *
 * Il punto delicato, e il motivo di questo file: **un nome che non si
 * risolve è un rifiuto**. Se ripiegasse su «nessuna squadra», un refuso
 * nella formula darebbe compiti che non arrivano a nessuno — e nessuno se ne
 * accorgerebbe, perché il ticket nascerebbe benissimo.
 */
import { describe, it, expect } from 'vitest'
import { FORM_FIELD_TYPES_COMPUTABLE, canBeComputed } from '@opengraphity/types'

describe('quali campi può calcolare una formula', () => {
  it('la SQUADRA sì: è quella che decide a chi vanno i compiti', () => {
    expect(canBeComputed('ref_team')).toBe(true)
  })

  /**
   * Gli omonimi. Due «Mario Rossi» esistono in un'azienda, e sbagliare CI è
   * peggio che non sceglierlo: risolvere per nome lì sarebbe una scommessa.
   * Se serviranno sarà una decisione a parte, non un'estensione di sfroso.
   */
  it('la PERSONA e il CI no: per nome non si risolvono con sicurezza', () => {
    expect(canBeComputed('ref_user')).toBe(false)
    expect(canBeComputed('ref_ci')).toBe(false)
  })

  it('gli allegati e le tabelle restano fuori', () => {
    expect(canBeComputed('attachment')).toBe(false)
    expect(canBeComputed('table')).toBe(false)
    expect(canBeComputed('multi_enum')).toBe(false)
    expect(canBeComputed('note')).toBe(false)
  })

  it('l\'elenco non è cresciuto di nascosto', () => {
    expect([...FORM_FIELD_TYPES_COMPUTABLE].sort()).toEqual(
      ['boolean', 'date', 'datetime', 'enum', 'number', 'ref_team', 'text', 'textarea'],
    )
  })
})
