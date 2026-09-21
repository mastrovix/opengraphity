/**
 * LE INTESTAZIONI DELLE COLONNE NELLA LINGUA DI CHI LEGGE (20 set 2026,
 * decisione del proprietario).
 *
 * Il difetto visto nel browser: nel costruttore la colonna si chiamava
 * «Titolo», nella tabella del risultato «TITLE» — e così nel PDF e nel foglio
 * Excel. Le intestazioni le compone il SERVER a partire dall'etichetta del
 * metamodello, che per un campo spedito è quella inglese, e la traduzione
 * stava nei locale del web, dove il server non poteva leggerla.
 *
 * Ora la traduzione è in `packages/types` e la legge anche questo. Il test
 * tiene le due metà della regola: un campo SPEDITO si traduce, un campo
 * RINOMINATO dal cliente no — l'etichetta è sua (F-22).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const entita = vi.hoisted(() => ({ value: [] as unknown[] }))

vi.mock('../navigableGraph.js', () => ({
  getNavigableEntities: async () => entita.value,
}))
vi.mock('../schemaInvalidator.js', () => ({
  registerMetamodelCacheClearer: () => undefined,
}))

const { reportFieldLabels, clearReportFieldLabelsCache } = await import('../reportFieldLabels.js')

beforeEach(() => {
  clearReportFieldLabelsCache()
  entita.value = [{
    neo4jLabel: 'Incident',
    fields: [
      // Spedito col prodotto, etichetta inglese nel grafo.
      { name: 'title', label: 'Title' },
      // Rinominato dal cliente.
      { name: 'description', label: 'Cosa è successo' },
      // Del cliente, il prodotto non lo conosce.
      { name: 'ambiente_uso', label: 'Ambiente' },
      // Senza etichetta: non entra nella mappa (chi legge ripiega sul nome).
      { name: 'senza', label: '' },
    ],
  }]
})

describe('le etichette delle colonne dei report', () => {
  it('un campo SPEDITO si legge nella lingua chiesta', async () => {
    const it_ = await reportFieldLabels('t1', 'it')
    expect(it_.get('Incident.title')).toBe('Titolo')
    const en = await reportFieldLabels('t1', 'en')
    expect(en.get('Incident.title')).toBe('Title')
  })

  it('un campo RINOMINATO dal cliente resta col suo nome, in ogni lingua', async () => {
    expect((await reportFieldLabels('t1', 'en')).get('Incident.description')).toBe('Cosa è successo')
    expect((await reportFieldLabels('t1', 'it')).get('Incident.description')).toBe('Cosa è successo')
  })

  it('un campo che il prodotto non spedisce è del cliente per definizione', async () => {
    expect((await reportFieldLabels('t1', 'it')).get('Incident.ambiente_uso')).toBe('Ambiente')
  })

  it("un'etichetta vuota non entra: meglio il nome interno di un'intestazione bianca", async () => {
    expect((await reportFieldLabels('t1', 'it')).has('Incident.senza')).toBe(false)
  })

  /**
   * La cache è per tenant E per lingua: con una chiave sola, il primo a
   * chiedere il report avrebbe deciso la lingua di tutti gli altri.
   */
  it('le due lingue non si sovrascrivono in cache', async () => {
    expect((await reportFieldLabels('t1', 'it')).get('Incident.title')).toBe('Titolo')
    expect((await reportFieldLabels('t1', 'en')).get('Incident.title')).toBe('Title')
    expect((await reportFieldLabels('t1', 'it')).get('Incident.title')).toBe('Titolo')
  })
})
