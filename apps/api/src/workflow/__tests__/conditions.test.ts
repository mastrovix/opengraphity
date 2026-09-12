/**
 * Il registro delle condizioni di transizione e il vocabolario che il
 * disegnatore offre devono coincidere (revisione delle otto ondate · B·M-4).
 *
 * Il difetto: il pannello delle transizioni offriva un campo di testo con un
 * segnaposto su un registro **chiuso** di cinque condizioni. Un refuso —
 * `all_assessment_complete` invece di `all_assessments_complete` — si salvava
 * senza un fiato e trasformava quell'arco in un muro: il motore risponde
 * «Condizione di transizione sconosciuta» a ogni tentativo e il ticket non si
 * muove più.
 *
 * Adesso il vocabolario sta in `@opengraphity/types`, il server lo valida in
 * scrittura e il web ne fa una tendina. Questo test è il legame che impedisce
 * alle due liste di divergere: chi aggiunge un evaluator senza aggiungere il
 * nome (o viceversa) lo scopre qui, non in produzione su un arco bloccato.
 */
import { describe, it, expect } from 'vitest'
import { WORKFLOW_TRANSITION_CONDITIONS } from '@opengraphity/types'
import { CHANGE_CONDITIONS } from '../conditions.js'

/** Registrata dal motore stesso, non da `conditions.ts`. */
const ENGINE_BUILTINS = ['rootCause != null']

describe('registro delle condizioni ↔ vocabolario del disegnatore', () => {
  it('ogni condizione offerta dal disegnatore ha un evaluator', () => {
    const registrate = [...Object.keys(CHANGE_CONDITIONS), ...ENGINE_BUILTINS]
    const orfane = WORKFLOW_TRANSITION_CONDITIONS.filter((c) => !registrate.includes(c))
    expect(orfane,
      `queste condizioni sono offerte dal disegnatore ma nessuno le sa valutare: ` +
      `chi le scegliesse bloccherebbe l'arco — ${orfane.join(', ')}`).toEqual([])
  })

  it('ogni evaluator registrato è offerto dal disegnatore', () => {
    const nascoste = Object.keys(CHANGE_CONDITIONS)
      .filter((c) => !(WORKFLOW_TRANSITION_CONDITIONS as readonly string[]).includes(c))
    expect(nascoste,
      `queste condizioni esistono nel motore ma il disegnatore non le offre, quindi nessuno può ` +
      `configurarle: aggiungile a WORKFLOW_TRANSITION_CONDITIONS — ${nascoste.join(', ')}`).toEqual([])
  })

  it('ogni evaluator ha un messaggio di fallimento non vuoto', () => {
    for (const [name, { failureMessage }] of Object.entries(CHANGE_CONDITIONS)) {
      expect(failureMessage.trim(), `${name} senza messaggio: l'utente vedrebbe un rifiuto muto`).not.toBe('')
    }
  })
})
