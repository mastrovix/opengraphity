/**
 * LA CHIAVE CON CUI SI SCRIVE UNA RIGA È QUELLA CON CUI SI CERCA.
 *
 * Il filtro per riga di una tabella era provato con una fixture scritta a mano
 * nella forma esatta che il costruttore dei filtri si aspetta
 * (`filterBuilderList.test.ts`), mentre la funzione che quella forma la
 * PRODUCE — `formTableFilterFields` — non era provata da nessuno: un test che
 * pinna il consumatore e lascia libero il produttore. Se una delle due
 * normalizzasse il nome di colonna (minuscole, trim, prefisso) e l'altra no,
 * NESSUN filtro per riga troverebbe mai niente — ed è già capitato con
 * l'`equals` su una lista e col `contains` sui multi-valore.
 *
 * Qui il giro si chiude con le funzioni vere: si scrive una riga, si legge il
 * campo virtuale del filtro, e si pretende che la proprietà cercata sia la
 * stessa che è stata scritta. Dal 17 set 2026, con la revisione a tappeto.
 */
import { describe, it, expect, vi } from 'vitest'
import { FORM_TABLE_VERSION } from '@opengraphity/types'

const scritture: Array<{ query: string; params: Record<string, unknown> }> = []

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close: vi.fn() })),
  runQuery: vi.fn(async (_s: unknown, query: string, params: Record<string, unknown>) => {
    scritture.push({ query, params }); return []
  }),
  runQueryOne: vi.fn(async () => null),
}))
vi.mock('../vocabularyEntries.js', () => ({ loadVocabularyEntries: vi.fn(async () => ({ values: [], labels: {}, colors: {} })) }))
vi.mock('../tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'it'), languageForUser: vi.fn(async () => 'it') }))
vi.mock('../metamodelScript.js', () => ({ runValidationScript: vi.fn(async () => null), runFormulaScript: vi.fn(async () => ({ ok: true, value: null })) }))

const { writeFormTables, formTableFilterFields, formTableFilterName } = await import('../catalogForm.js')

const session = {} as never

/** Il campo tabella come lo porta la libreria, con due colonne. */
const campoTabella = {
  id: 'f1', name: 'persone_da_abilitare', fieldType: 'table' as const, label: 'Persone da abilitare',
  labels: [], help: null, helps: [], required: false, vocabulary: null,
  validationScript: null, formula: null, inList: false,
  tableDefinition: {
    version: FORM_TABLE_VERSION,
    columns: [
      { name: 'persona', labels: { it: 'Persona' }, fieldType: 'text' as const, vocabulary: null, required: true },
      { name: 'giorni', labels: { it: 'Giorni' }, fieldType: 'number' as const, vocabulary: null, required: false },
    ],
  },
  createdAt: null, updatedAt: null,
} as never

describe('righe di tabella: scrittura e filtro parlano la stessa lingua', () => {
  it('la proprietà scritta sulla riga è quella che il filtro cerca', async () => {
    scritture.length = 0
    await writeFormTables(session, 't1', 'req-1', [
      { field: 'persone_da_abilitare', rows: [{ persona: 'Ada Lovelace', giorni: 3 }] },
    ])
    const scritte = Object.keys(scritture[0]!.params['values'] as Record<string, unknown>)
    expect(scritte).toEqual(['persona', 'giorni'])

    const filtri = formTableFilterFields([campoTabella])
    const cercate = Object.values(filtri).map((d) => d.searchProp)
    // Ogni proprietà cercata è una proprietà scritta: senza, il filtro non
    // troverebbe mai niente e nessun errore lo direbbe.
    for (const prop of cercate) expect(scritte).toContain(prop)
  })

  it('il nome del campo virtuale è `<tabella>__<colonna>`, e lo produce una funzione sola', () => {
    const filtri = formTableFilterFields([campoTabella])
    expect(Object.keys(filtri)).toEqual([
      formTableFilterName('persone_da_abilitare', 'persona'),
      formTableFilterName('persone_da_abilitare', 'giorni'),
    ])
    expect(Object.keys(filtri)).toEqual(['persone_da_abilitare__persona', 'persone_da_abilitare__giorni'])
  })

  it('il filtro cerca le righe DI QUEL CAMPO: la relazione porta il nome della tabella', () => {
    const filtri = formTableFilterFields([campoTabella])
    for (const def of Object.values(filtri)) {
      expect(def.relType).toBe('FORM_TABLE_ROW')
      expect(def.targetLabel).toBe('FormTableRow')
      // Senza questo vincolo due tabelle con una colonna omonima si confondono.
      expect(def.relProps).toEqual({ field: 'persone_da_abilitare' })
    }
  })

  it('la riga porta il tenant e l\'ordine in cui è stata scritta', async () => {
    scritture.length = 0
    await writeFormTables(session, 't1', 'req-1', [
      { field: 'persone_da_abilitare', rows: [{ persona: 'Ada' }, { persona: 'Grace' }] },
    ])
    expect(scritture).toHaveLength(2)
    expect(scritture[0]!.params['index']).toBe(0)
    expect(scritture[1]!.params['index']).toBe(1)
    expect(scritture[0]!.query).toContain('r:FormTableRow {tenant_id: $tenantId}')
    expect(scritture[0]!.params['tenantId']).toBe('t1')
  })

  it('un campo tabella senza colonne non produce filtri (invece di produrne uno rotto)', () => {
    const senzaColonne = { ...(campoTabella as object), tableDefinition: null } as never
    expect(formTableFilterFields([senzaColonne])).toEqual({})
  })
})
