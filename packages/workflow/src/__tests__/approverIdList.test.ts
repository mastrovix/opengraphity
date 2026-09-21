/**
 * `approverIdList` — l'unico lettore delle due forme di `approver_*_ids`
 * (moduli del catalogo, ondata 3).
 *
 * Perché due forme: il disegnatore del workflow tiene i parametri di un'azione
 * come `Record<string, string>` e non può produrre un array, mentre l'API che
 * scrive direttamente il JSON produce una lista. Accettarle entrambe in UN
 * posto è la differenza fra un contratto e un difetto che salta fuori dalla
 * parte sbagliata.
 */
import { describe, it, expect } from 'vitest'
import { approverIdList } from '../actions.js'

describe('approverIdList', () => {
  it('una lista JSON resta com\'è', () => {
    expect(approverIdList(['u-1', 'u-2'])).toEqual(['u-1', 'u-2'])
  })

  it('una stringa separata da virgola diventa una lista, senza spazi', () => {
    expect(approverIdList('u-1, u-2 ,u-3')).toEqual(['u-1', 'u-2', 'u-3'])
  })

  it('assente, vuoto o solo separatori: nessun id — che NON vuol dire nessun approvatore (vale il ruolo)', () => {
    expect(approverIdList(undefined)).toEqual([])
    expect(approverIdList('')).toEqual([])
    expect(approverIdList('   ')).toEqual([])
    expect(approverIdList(',,')).toEqual([])
    expect(approverIdList([])).toEqual([])
  })

  it('i doppioni sparicono: lo stesso approvatore due volte non deve contare due volte in «tutti devono approvare»', () => {
    expect(approverIdList('u-1,u-1,u-2')).toEqual(['u-1', 'u-2'])
    expect(approverIdList(['u-1', 'u-1'])).toEqual(['u-1'])
  })
})
