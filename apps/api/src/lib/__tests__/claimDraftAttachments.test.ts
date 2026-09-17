/**
 * I FILE DELLA BOZZA SI RECLAMANO SOLO PER LE DOMANDE CHE IL MODULO HA FATTO.
 *
 * Il difetto, riprodotto dal vivo su `c-test` il 17 set 2026: nel portale si
 * carica un file sul campo «Preventivo» di «Nuovo portatile», si chiude il
 * modulo con Annulla, si invia «Nuovo mouse» — una voce SENZA modulo e senza
 * campi allegato — e la richiesta del mouse si porta dietro il file dell'altra,
 * `field_name` compreso. Causa: si reclamavano tutti gli `:Attachment` della
 * bozza, senza guardare il campo, e la bozza nasceva una volta per apertura di
 * pagina invece che per voce.
 *
 * `claimDraftAttachments` non aveva NESSUN test (nemmeno un riferimento in
 * tutta la suite), che è il motivo per cui il difetto è arrivato fino a un
 * browser. Qui si tengono ferme le tre cose che contano: il campo, chi ha
 * caricato, e il fatto che i file lasciati indietro si CONTANO invece di
 * sparire in silenzio.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface Chiamata { query: string; params: Record<string, unknown> }
const chiamate: Chiamata[] = []
/** Quante righe risponde la prossima query, nell'ordine in cui arrivano. */
let conteggi: number[] = []

vi.mock('@opengraphity/neo4j', () => ({
  runQuery: vi.fn(async (_s: unknown, query: string, params: Record<string, unknown>) => {
    chiamate.push({ query, params })
    return [{ n: conteggi.shift() ?? 0 }]
  }),
  getSession: vi.fn(),
}))
vi.mock('../vocabularyEntries.js', () => ({ loadVocabularyEntries: vi.fn(async () => ({ values: [], labels: {}, colors: {} })) }))
vi.mock('../tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'it') }))
vi.mock('../metamodelScript.js', () => ({ runValidationScript: vi.fn(async () => null), runFormulaScript: vi.fn(async () => ({ ok: true, value: null })) }))

const { claimDraftAttachments } = await import('../catalogForm.js')

const session = {} as never

describe('claimDraftAttachments', () => {
  beforeEach(() => { chiamate.length = 0; conteggi = [] })

  it('reclama solo i file dei campi allegato passati, e conta gli altri', async () => {
    conteggi = [1, 2]
    const esito = await claimDraftAttachments(session, 't1', 'bozza-1', 'service_request', 'req-1', 'u1', ['preventivo'])
    expect(esito).toEqual({ claimed: 1, leftBehind: 2 })
    expect(chiamate).toHaveLength(2)
    expect(chiamate[0]!.query).toContain('a.field_name IN $fields')
    expect(chiamate[0]!.query).toContain('SET a.entity_type = $entityType')
    expect(chiamate[0]!.params).toMatchObject({ tenantId: 't1', draftId: 'bozza-1', entityId: 'req-1', userId: 'u1', fields: ['preventivo'] })
  })

  it('il conto di quelli lasciati guarda i file NON chiesti da nessun campo', async () => {
    conteggi = [0, 3]
    await claimDraftAttachments(session, 't1', 'bozza-1', 'service_request', 'req-1', 'u1', ['preventivo'])
    expect(chiamate[1]!.query).toContain("NOT coalesce(a.field_name, '') IN $fields")
  })

  /*
   * È il caso riprodotto dal vivo: RICH-000019 «Nuovo mouse», nessun modulo,
   * nessun campo allegato — e un file caricato per un'altra voce.
   */
  it('SICUREZZA: senza campi allegato non si reclama niente', async () => {
    conteggi = [0, 1]
    const esito = await claimDraftAttachments(session, 't1', 'bozza-1', 'service_request', 'req-1', 'u1', [])
    expect(esito.claimed).toBe(0)
    expect(esito.leftBehind).toBe(1)
    expect(chiamate[0]!.params['fields']).toEqual([])
  })

  it('SICUREZZA: si reclamano solo i file di chi sta creando la richiesta', async () => {
    conteggi = [1, 0]
    await claimDraftAttachments(session, 't1', 'bozza-1', 'service_request', 'req-1', 'u1', ['preventivo'])
    for (const c of chiamate) {
      expect(c.query).toContain('a.uploaded_by = $userId')
      // Il ripiego «oppure nessun utente» apriva il controllo a chiunque
      // avesse indovinato l'identificativo della bozza: non c'è più.
      expect(c.query).not.toContain('$userId IS NULL')
    }
  })

  it('la bozza si legge per il suo tipo di entità, non per il ticket', async () => {
    conteggi = [0, 0]
    await claimDraftAttachments(session, 't1', 'bozza-1', 'service_request', 'req-1', 'u1', ['x'])
    expect(chiamate[0]!.params['draftType']).toBe('form_draft')
  })
})
