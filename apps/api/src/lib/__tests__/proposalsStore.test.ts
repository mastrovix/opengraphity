/**
 * LE QUATTRO PORTE DAVANTI A UNA PROPOSTA NUOVA (20 set 2026).
 *
 * Ogni porta chiusa qui è un difetto che sarebbe uscito dal vivo:
 *  - senza la prima, le prove nuove di stanotte resetterebbero una decisione
 *    già presa;
 *  - senza la seconda, il prodotto riproporrebbe ogni notte ciò che qualcuno
 *    ha rifiutato — e quella persona non capirebbe perché;
 *  - senza la terza, cinque proposte diventano venti e la pagina non la legge
 *    più nessuno;
 *  - senza la quarta, una notte fortunata riempie il tetto e blocca la pagina
 *    per una settimana.
 *
 * E la porta che NON c'è: il tetto vale sulle aperte e sulle rimandate, mai
 * sulle decise. Contare anche quelle vorrebbe dire che un cliente che lavora
 * — cioè che decide — smette di ricevere proposte.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const finto = vi.hoisted(() => ({
  esistente: null as { status: string } | null,
  lapide:    null as { grade: number; at: string } | null,
  aperte:    0,
  oggi:      0,
  scritte:   [] as Array<Record<string, unknown>>,
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({ close: async () => undefined, executeWrite: async () => undefined }),
}))
vi.mock('../../graphql/resolvers/ci-utils.js', () => ({
  runQueryOne: async (_s: unknown, q: string) => {
    if (q.includes('MATCH (p:Proposal {tenant_id: $tenantId, area: $area, fingerprint')) return finto.esistente
    if (q.includes(':ProposalRejection')) return finto.lapide
    if (q.includes('AS aperte')) return { aperte: finto.aperte, oggi: finto.oggi }
    return null
  },
  runQuery: async (_s: unknown, _q: string, p: Record<string, unknown>) => {
    finto.scritte.push(p)
    return [{
      id: 'p1', tenantId: p['tenantId'], area: p['area'], kind: p['kind'],
      params: p['params'], fingerprint: p['fingerprint'], evidence: p['evidence'],
      evidenceGrade: p['grade'], occurrences: p['n'], windowDays: p['windowDays'],
      action: p['action'], rationale: null, rationaleLanguage: null,
      status: 'open', createdAt: p['now'],
      decidedAt: null, decidedBy: null, rejectedKind: null, rejectedNote: null,
      notNowUntil: null, auditEntryId: null, executionError: null, undoState: null, undone: false,
    }]
  },
}))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { scriviProposta, fingerprintOf } = await import('../proposals.js')

const proposta = (n = 10) => ({
  tenantId: 't1', area: 'configuration' as const,
  kind: 'proposal.portalSeveritiesStale', params: { values: 'blocker' },
  scope: 'portal_severities',
  evidence: { n, windowDays: 0, refs: [] },
  action: { type: 'portal_severities.remove_stale', params: {} },
})

beforeEach(() => {
  finto.esistente = null; finto.lapide = null
  finto.aperte = 0; finto.oggi = 0; finto.scritte = []
})

describe('l\'impronta', () => {
  it('è il SOGGETTO, non le prove: due notti con numeri diversi danno la stessa', () => {
    expect(fingerprintOf('configuration', 'k', 'portal_severities'))
      .toBe('configuration:k:portal_severities')
  })
})

describe('le quattro porte', () => {
  it('scrive quando è tutto libero', async () => {
    const esito = await scriviProposta(proposta())
    expect(esito.scritta).toBe(true)
  })

  it('1 · NON riscrive se esiste già con quell\'impronta', async () => {
    finto.esistente = { status: 'open' }
    const esito = await scriviProposta(proposta())
    expect(esito).toEqual({ scritta: false, motivo: 'gia_presente' })
    expect(finto.scritte).toHaveLength(0)
  })

  it('2 · NON ripropone ciò che è stato rifiutato di recente', async () => {
    finto.lapide = { grade: 3, at: new Date().toISOString() }
    const esito = await scriviProposta(proposta(10))
    expect(esito).toEqual({ scritta: false, motivo: 'rifiutata_di_recente' })
  })

  it('2b · ma RITORNA se è passato il tempo e le prove sono cambiate di fascia', async () => {
    finto.lapide = { grade: 3, at: new Date(Date.now() - 60 * 86_400_000).toISOString() }
    const esito = await scriviProposta(proposta(200))
    expect(esito.scritta).toBe(true)
  })

  it('3 · si ferma al tetto delle aperte', async () => {
    finto.aperte = 5
    const esito = await scriviProposta(proposta())
    expect(esito).toEqual({ scritta: false, motivo: 'tetto_aperte' })
  })

  it('4 · si ferma al tetto giornaliero, anche con slot liberi', async () => {
    finto.aperte = 0
    finto.oggi = 2
    const esito = await scriviProposta(proposta())
    expect(esito).toEqual({ scritta: false, motivo: 'tetto_giornaliero' })
  })
})

describe('quello che finisce sul nodo', () => {
  it('la FASCIA delle prove si scrive insieme al conteggio: serve al ritorno dopo un rifiuto', async () => {
    await scriviProposta(proposta(47))
    expect(finto.scritte[0]?.['grade']).toBe(5)
    expect(finto.scritte[0]?.['n']).toBe(47)
  })

  it('parametri e prove si salvano come JSON, il titolo NON si salva', async () => {
    await scriviProposta(proposta())
    const scritto = finto.scritte[0]!
    expect(String(scritto['params'])).toContain('blocker')
    expect(Object.keys(scritto)).not.toContain('title')
  })
})
