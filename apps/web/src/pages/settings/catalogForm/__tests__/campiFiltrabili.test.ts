/**
 * QUALI CAMPI OFFRE IL FILTRO DI UN CAMPO «riferimento alla CMDB» (19 set 2026).
 *
 * L'editor deve offrire ESATTAMENTE quello che il server accetterà: i campi
 * comuni a ogni CI più le proprietà dei tipi scelti (`assertFiltroCI` in
 * `apps/api/src/graphql/resolvers/catalogForm.ts` costruisce lo stesso
 * insieme). Offrire di più vuol dire un salvataggio rifiutato con una regola
 * che sembrava legittima; offrire di meno, un filtro che non si può scrivere.
 */
import { describe, it, expect } from 'vitest'
import { campiFiltrabili } from '../FieldEditor'

const ETICHETTE = { nome: 'Nome', stato: 'Stato', ambiente: 'Ambiente', salute: 'Salute', creato: 'Creato il' }

const TIPI = [
  { name: 'server', label: 'Server', fields: [
    { name: 'manufacturer', label: 'Costruttore', fieldType: 'string' },
    { name: 'criticality', label: 'Criticità', fieldType: 'enum', enumValues: ['alta', 'bassa'] },
    { name: 'created_by', label: 'Creato da', fieldType: 'string', isSystem: true },
  ] },
  { name: 'database', label: 'Database', fields: [
    { name: 'engine', label: 'Motore', fieldType: 'string' },
    { name: 'manufacturer', label: 'Costruttore', fieldType: 'string' },
  ] },
]

describe('campiFiltrabili', () => {
  it('senza tipi scelti offre i comuni più le proprietà di tutti i tipi, una volta sola', () => {
    // I comuni nell'ordine in cui si leggono in una lista CMDB, poi le
    // proprietà in ordine di ETICHETTA (Costruttore, Criticità, Motore) —
    // perché è l'etichetta che chi configura legge nella tendina.
    expect(campiFiltrabili(TIPI, [], ETICHETTE).map((c) => c.key)).toEqual(
      ['name', 'status', 'environment', 'health', 'createdAt', 'manufacturer', 'criticality', 'engine'],
    )
  })

  it('con un tipo scelto offre solo le sue proprietà: fuori da quel tipo il campo non esiste', () => {
    const chiavi = campiFiltrabili(TIPI, ['database'], ETICHETTE).map((c) => c.key)
    expect(chiavi).toContain('engine')
    expect(chiavi).not.toContain('criticality')
  })

  it('i campi di sistema non si filtrano: il server li esclude, l’editor non li offre', () => {
    expect(campiFiltrabili(TIPI, ['server'], ETICHETTE).map((c) => c.key)).not.toContain('created_by')
  })

  it('un vocabolario diventa una tendina di valori, non una casella di testo', () => {
    const criticita = campiFiltrabili(TIPI, ['server'], ETICHETTE).find((c) => c.key === 'criticality')
    expect(criticita?.type).toBe('enum')
    expect(criticita?.options?.map((o) => o.value)).toEqual(['alta', 'bassa'])
  })

  it('una data resta una data: gli operatori sono quelli del tempo', () => {
    expect(campiFiltrabili([], [], ETICHETTE).find((c) => c.key === 'createdAt')?.type).toBe('date')
  })
})
