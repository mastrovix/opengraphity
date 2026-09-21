/**
 * UN TICKET COMPILATO IERI SI RILEGGE CON LE DOMANDE DI IERI.
 *
 * È la promessa centrale dell'ondata 1 dei moduli — «il ticket porta la sua
 * revisione, così il modulo di ieri resta ricostruibile senza duplicare un
 * solo valore» — e non era pinnata da niente: `formAnswersOf` e
 * `catalogFormRevision` non avevano un solo riferimento in tutta la suite
 * (revisione del 17 set 2026). Se la copia congelata smettesse di essere
 * scritta o letta, un ticket di un anno prima si rileggerebbe con le domande
 * di oggi: risposte giuste accanto a domande sbagliate, senza un errore.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CatalogFormDefinition } from '@opengraphity/types'

/** Le revisioni congelate, per numero: le decide ogni caso. */
let revisioni: Record<number, CatalogFormDefinition> = {}
let libreriaRighe: Array<Record<string, unknown>> = []
const queryFatte: string[] = []

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close: vi.fn() })),
  runQuery: vi.fn(async (_s: unknown, query: string, params: Record<string, unknown>) => {
    queryFatte.push(query)
    if (query.includes('CatalogFormRevision')) {
      const def = revisioni[Number(params['revision'])]
      return def ? [{ definition: JSON.stringify(def) }] : []
    }
    if (query.includes('MATCH (f:FormField')) return libreriaRighe
    return []
  }),
  runQueryOne: vi.fn(async () => null),
}))
vi.mock('../vocabularyEntries.js', () => ({ loadVocabularyEntries: vi.fn(async () => ({ values: ['production', 'staging'], labels: { production: { it: 'Produzione' } }, colors: {} })) }))
vi.mock('../tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'it'), languageForUser: vi.fn(async () => 'it') }))
vi.mock('../metamodelScript.js', () => ({ runValidationScript: vi.fn(async () => null), runFormulaScript: vi.fn(async () => ({ ok: true, value: null })) }))
vi.mock('../logger.js', () => ({ logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) } }))

const { formAnswersOf } = await import('../catalogForm.js')

const session = {} as never

const riga = (name: string, fieldType: string, label: string, over: Record<string, unknown> = {}) => ({
  id: name, name, fieldType, label, labels: JSON.stringify({ it: label }),
  help: null, helps: null, required: false, vocabulary: fieldType === 'enum' ? 'environment' : null,
  validationScript: null, formula: null, tableDefinition: null, inList: false,
  createdAt: null, updatedAt: null, ...over,
})

const sezione = (campi: string[]): CatalogFormDefinition['sections'] =>
  [{ id: 's1', title: { it: 'S' }, items: campi.map((f) => ({ field: f })) }]

beforeEach(() => {
  queryFatte.length = 0
  // La libreria di OGGI: ha anche un campo che la revisione 1 non conosceva.
  libreriaRighe = [
    riga('modello', 'text', 'Modello richiesto'),
    riga('ambiente', 'enum', 'Ambiente'),
    riga('centro_di_costo', 'text', 'Centro di costo'),
  ]
  revisioni = {
    // Ieri: due domande.
    1: { version: 1, revision: 1, sections: sezione(['modello', 'ambiente']) },
    // Oggi: tre, e una in meno di ieri non c'è.
    2: { version: 1, revision: 2, sections: sezione(['modello', 'centro_di_costo']) },
  }
})

const ticket = (revision: number, props: Record<string, unknown>) =>
  ({ id: 'req-1', catalogItemId: 'voce-1', formRevision: revision, props })

describe('formAnswersOf: le domande della revisione del ticket', () => {
  it('un ticket della revisione 1 si rilegge con le domande della 1, non con quelle di oggi', async () => {
    const out = await formAnswersOf(session, 't1', ticket(1, { modello: 'ThinkPad', ambiente: 'production', centro_di_costo: 'CC-9' }))
    expect(out.map((a) => a.name)).toEqual(['modello', 'ambiente'])
    // `centro_di_costo` è sul nodo, ma quella domanda nella revisione 1 non
    // esisteva: mostrarla sarebbe attribuire al ticket una risposta che nessuno
    // gli ha chiesto.
    expect(out.map((a) => a.name)).not.toContain('centro_di_costo')
  })

  it('e un ticket della revisione 2 vede le SUE, anche se una di ieri non c\'è più', async () => {
    const out = await formAnswersOf(session, 't1', ticket(2, { modello: 'MacBook', ambiente: 'staging', centro_di_costo: 'CC-1' }))
    expect(out.map((a) => a.name)).toEqual(['modello', 'centro_di_costo'])
  })

  it('la revisione si legge per numero: è così che la copia congelata serve a qualcosa', async () => {
    await formAnswersOf(session, 't1', ticket(1, { modello: 'X' }))
    expect(queryFatte.some((q) => q.includes('CatalogFormRevision'))).toBe(true)
  })

  it('il valore si legge con l\'etichetta del Dizionario, come ovunque', async () => {
    const out = await formAnswersOf(session, 't1', ticket(1, { modello: 'X', ambiente: 'production' }))
    const ambiente = out.find((a) => a.name === 'ambiente')!
    expect(ambiente.value).toBe('production')
    expect(ambiente.displayValue).toBe('Produzione')
  })

  it('senza revisione o senza voce non ci sono risposte da rileggere', async () => {
    expect(await formAnswersOf(session, 't1', { id: 'r', catalogItemId: null, formRevision: 1, props: {} })).toEqual([])
    expect(await formAnswersOf(session, 't1', { id: 'r', catalogItemId: 'voce-1', formRevision: null, props: {} })).toEqual([])
  })

  it('se la copia congelata manca si restituisce vuoto — e NON in silenzio (va nei log)', async () => {
    revisioni = {}
    const out = await formAnswersOf(session, 't1', ticket(7, { modello: 'X' }))
    expect(out).toEqual([])
  })

  it('dal portale si rileggono solo le voci offerte agli utenti finali', async () => {
    revisioni = {
      1: {
        version: 1, revision: 1,
        sections: [{ id: 's1', title: { it: 'S' }, items: [
          { field: 'modello' },
          { field: 'centro_di_costo', endUser: false },
        ] }],
      },
    }
    const staff = await formAnswersOf(session, 't1', ticket(1, { modello: 'X', centro_di_costo: 'CC-1' }))
    expect(staff.map((a) => a.name)).toEqual(['modello', 'centro_di_costo'])
    const utente = await formAnswersOf(session, 't1', ticket(1, { modello: 'X', centro_di_costo: 'CC-1' }), { endUser: true })
    expect(utente.map((a) => a.name)).toEqual(['modello'])
  })
})
