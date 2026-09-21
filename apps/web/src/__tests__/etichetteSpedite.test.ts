/**
 * LE ETICHETTE SPEDITE HANNO UNA CASA SOLA (20 set 2026, decisione del
 * proprietario).
 *
 * Erano nei locale del web (`metamodel.shipped.*`), dove il SERVER non poteva
 * leggerle: la stessa tabella di report aveva le colonne «Titolo» e «Numero»
 * nel costruttore e «TITLE» e «NUMBER» nel risultato, nel PDF e nell'Excel.
 * Ora stanno in `packages/types`, e le leggono tutti e due.
 *
 * Il rischio del cambio non è il cambio: è che fra un mese qualcuno rimetta
 * le stesse frasi nei locale «perché lì è più comodo tradurre», e le due
 * copie ricomincino a divergere in silenzio — che è esattamente il difetto
 * appena chiuso. Questo test lo impedisce.
 */
import { describe, it, expect } from 'vitest'
import { SHIPPED_LABELS, shippedLabelIn } from '@opengraphity/types'
import italiano from '@/i18n/locales/it.json'
import inglese from '@/i18n/locales/en.json'

describe('le etichette spedite stanno in un posto solo', () => {
  it('i locale NON hanno più una copia di `metamodel.shipped`', () => {
    for (const locale of [italiano, inglese]) {
      const metamodel = (locale as unknown as { metamodel?: Record<string, unknown> }).metamodel
      expect(metamodel?.['shipped']).toBeUndefined()
    }
  })

  it('ogni etichetta spedita ha le due lingue, e non sono la stessa parola per caso', () => {
    for (const [kind, voci] of Object.entries(SHIPPED_LABELS)) {
      for (const [name, v] of Object.entries(voci)) {
        expect(v.en, `${kind}.${name} in inglese`).toBeTruthy()
        expect(v.it, `${kind}.${name} in italiano`).toBeTruthy()
      }
    }
  })

  it('si traduce solo finché l\'etichetta è ancora quella spedita', () => {
    // Spedita: si traduce.
    expect(shippedLabelIn('field', 'title', 'Title', 'it')).toBe('Titolo')
    // Rinominata dal cliente: è sua, in ogni lingua (F-22).
    expect(shippedLabelIn('field', 'title', 'Oggetto', 'it')).toBe('Oggetto')
    expect(shippedLabelIn('field', 'title', 'Oggetto', 'en')).toBe('Oggetto')
    // Un campo che il prodotto non spedisce è del cliente per definizione.
    expect(shippedLabelIn('field', 'ambiente_uso', 'Ambiente', 'en')).toBe('Ambiente')
    // Una lingua che il prodotto non spedisce non cancella l'etichetta.
    expect(shippedLabelIn('field', 'title', 'Title', 'de')).toBe('Title')
    // Senza etichetta resta il nome interno, che è meglio del vuoto.
    expect(shippedLabelIn('field', 'sconosciuto', null, 'it')).toBe('sconosciuto')
  })
})
