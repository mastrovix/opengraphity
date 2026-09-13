/**
 * Le domande di assessment: cosa il prodotto accetta (terza revisione).
 *
 * `questionAdmin.ts` non aveva test. Provando un tenant di prova dal browser
 * sono venuti fuori due difetti, uno di dato e uno di portata:
 *
 *  - si salvavano opzioni **senza etichetta** e con punteggio zero. Nella
 *    tendina del task diventano voci bianche, e chi le scegliesse non saprebbe
 *    cosa ha scelto. Dal vivo: tre opzioni salvate, due senza testo, tutte a
 *    zero — e il rischio della change usciva 0 con la fascia vuota;
 *  - una domanda «core» veniva assegnata solo ai tipi CI `scope: 'base'`,
 *    mentre l'interfaccia prometteva «tutti i CI Type attivi»: su un tipo CI
 *    del CLIENTE nessuna change superava l'assessment.
 *
 * La regola dei punteggi (nessuno zero, non tutti uguali) è una regola di
 * dominio decisa dal proprietario del prodotto: un punteggio che non sposta
 * nulla rende la domanda decorativa.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const run = vi.fn<(q: string, p?: Record<string, unknown>) => Promise<{ records: unknown[] }>>()

vi.mock('../../ci-utils.js', () => ({
  withSession: (fn: (s: unknown) => unknown) => fn({
    executeWrite: (w: (tx: unknown) => unknown) => w({ run }),
    executeRead:  (w: (tx: unknown) => unknown) => w({ run }),
  }),
  runQuery:    vi.fn(async () => []),
  runQueryOne: vi.fn(async () => null),
}))
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))

const { createAssessmentQuestion, updateAssessmentQuestion } = await import('../questionAdmin.js')

const ctx = { tenantId: 'c-test', userId: 'u1', userEmail: 'a@b.c', role: 'admin' } as never
const buone = [{ label: 'Sì, provato', score: 1, sortOrder: 0 }, { label: 'No', score: 3, sortOrder: 1 }]
const crea = (input: Record<string, unknown>) =>
  createAssessmentQuestion(null, { input: { text: 'Domanda?', category: 'technical', isCore: true, options: buone, ...input } } as never, ctx)

beforeEach(() => {
  vi.clearAllMocks()
  run.mockResolvedValue({ records: [] })
})

describe('assertQuestionUsable — il testo e le etichette', () => {
  it('un testo vuoto è rifiutato: è ciò che l\'operatore legge nel task', async () => {
    await expect(crea({ text: '   ' })).rejects.toThrow(/question text cannot be empty/i)
  })

  it('un\'opzione SENZA ETICHETTA è rifiutata, e il messaggio dice cosa si vedrebbe', async () => {
    const err = await crea({ options: [{ label: 'No', score: 3, sortOrder: 0 }, { label: '  ', score: 1, sortOrder: 1 }] })
      .then(() => null, (e: Error) => e)
    expect(err).not.toBeNull()
    expect(err!.message).toMatch(/has no text|have no text/)
    expect(err!.message).toMatch(/blank entry/)
  })

  it('due opzioni con lo stesso testo sono rifiutate: il punteggio diventa inspiegabile', async () => {
    await expect(crea({ options: [{ label: 'No', score: 1, sortOrder: 0 }, { label: 'No', score: 3, sortOrder: 1 }] }))
      .rejects.toThrow(/repeat "No"/)
  })

  it('senza opzioni è rifiutata', async () => {
    await expect(crea({ options: [] })).rejects.toThrow(/at least one option/)
  })
})

describe('assertQuestionUsable — i punteggi (regola di dominio)', () => {
  it('NESSUNA risposta puo valere 0', async () => {
    const err = await crea({ options: [{ label: 'Sì', score: 0, sortOrder: 0 }, { label: 'No', score: 3, sortOrder: 1 }] })
      .then(() => null, (e: Error) => e)
    expect(err).not.toBeNull()
    expect(err!.message).toMatch(/must be an integer of 1 or more/)
    // Il messaggio dice cosa fare, non solo cosa è vietato.
    expect(err!.message).toMatch(/the lowest score \(1\), not zero/)
  })

  it('nemmeno un punteggio negativo o frazionario', async () => {
    await expect(crea({ options: [{ label: 'a', score: -2, sortOrder: 0 }, { label: 'b', score: 3, sortOrder: 1 }] }))
      .rejects.toThrow(/must be an integer of 1 or more/)
    await expect(crea({ options: [{ label: 'a', score: 1.5, sortOrder: 0 }, { label: 'b', score: 3, sortOrder: 1 }] }))
      .rejects.toThrow(/integer/)
  })

  it('se TUTTE valgono lo stesso, la domanda non misura niente', async () => {
    const err = await crea({ options: [{ label: 'a', score: 2, sortOrder: 0 }, { label: 'b', score: 2, sortOrder: 1 }] })
      .then(() => null, (e: Error) => e)
    expect(err).not.toBeNull()
    expect(err!.message).toMatch(/Every option is worth 2/)
    expect(err!.message).toMatch(/answering would not change the risk/)
  })

  it('una sola opzione ricade nella stessa regola: la risposta è forzata', async () => {
    await expect(crea({ options: [{ label: 'Confermo', score: 1, sortOrder: 0 }] }))
      .rejects.toThrow(/answering would not change the risk/)
  })

  it('punteggi validi e diversi: passa', async () => {
    await expect(crea({})).resolves.not.toThrow()
  })

  it('la stessa regola vale in MODIFICA, non solo in creazione', async () => {
    // Era il buco: `updateAssessmentQuestion` non guardava le opzioni affatto.
    await expect(updateAssessmentQuestion(null, {
      id: 'q1', input: { options: [{ label: 'x', score: 0, sortOrder: 0 }, { label: 'y', score: 2, sortOrder: 1 }] },
    } as never, ctx)).rejects.toThrow(/must be an integer of 1 or more/)
  })
})

describe('«core» vuol dire tutti i tipi CI del cliente, non solo quelli spediti', () => {
  it('la query di assegnazione non filtra piu su scope=base', async () => {
    await crea({})
    const cypher = run.mock.calls.map((c) => String(c[0])).join('\n---\n')
    // Il filtro corretto: base condivisi + i tipi del tenant.
    expect(cypher).toMatch(/ct\.scope = 'base' OR \(ct\.scope = 'tenant' AND ct\.tenant_id = \$tenantId\)/)
    // E non deve tornare la forma cablata.
    expect(cypher).not.toMatch(/CITypeDefinition \{active: true, scope: 'base'\}/)
  })

  it('esclude il tipo base fittizio `__base__`, che non è un tipo CI reale', async () => {
    await crea({})
    const cypher = run.mock.calls.map((c) => String(c[0])).join('\n')
    expect(cypher).toMatch(/ct\.name <> '__base__'/)
  })
})
