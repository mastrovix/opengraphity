/**
 * LA QUERY DELLE IMPOSTAZIONI AI CHIEDE TUTTE LE FUNZIONI.
 *
 * `GET_AI_SETTINGS` elenca i campi a mano (deve restare un documento gql
 * statico: il guardiano dell'API lo legge come testo). Quindi l'elenco può
 * sfasarsi da `AI_FEATURE_KEYS`, e sfasato vuol dire che la sezione
 * Organizzazione → AI rende un interruttore `undefined`: si vede spento, e
 * salvando manderebbe un input che il server rifiuta.
 *
 * Aggiungendo `formDesigner` (19 set 2026) l'elenco delle funzioni era in
 * cinque posti e ne avevo aggiornati tre.
 */
import { describe, it, expect } from 'vitest'
import { print } from 'graphql'
import { GET_AI_SETTINGS } from '../queries'
import { AI_FEATURE_KEYS } from '@/lib/aiFeatures'

describe('GET_AI_SETTINGS', () => {
  it('seleziona esattamente le funzioni di AI_FEATURE_KEYS', () => {
    const testo = print(GET_AI_SETTINGS)
    const dentro = /features\s*\{([^}]*)\}/.exec(testo)?.[1] ?? ''
    const chiesti = dentro.split(/\s+/).filter((x) => x !== '')
    expect(chiesti.sort()).toEqual([...AI_FEATURE_KEYS].sort())
  })
})
