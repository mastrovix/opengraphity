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
vi.mock('../db.js', () => ({
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

const { scriviProposta, fingerprintOf, purgaLeChiuse } = await import('../proposals.js')

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

  // Review of 23 Sep 2026: a closed proposal held its fingerprint for ever.
  it('1b · una RIFIUTATA torna quando la regola del rifiuto lo permette, e il vecchio nodo chiuso lascia il posto', async () => {
    finto.esistente = { status: 'rejected' }
    finto.lapide = { grade: 3, at: new Date(Date.now() - 60 * 86_400_000).toISOString() }
    const esito = await scriviProposta(proposta(200))
    expect(esito.scritta).toBe(true)
    expect(finto.scritte[0]).toMatchObject({ closed: ['rejected', 'expired'] })
  })

  it('1c · una rifiutata di recente resta fuori, e il nodo resta', async () => {
    finto.esistente = { status: 'rejected' }
    finto.lapide = { grade: 3, at: new Date().toISOString() }
    expect(await scriviProposta(proposta(10))).toEqual({ scritta: false, motivo: 'rifiutata_di_recente' })
    expect(finto.scritte).toHaveLength(0)
  })

  it('1d · una SCADUTA torna se le prove ci sono ancora (nessuna lapide: scadere non è rifiutare)', async () => {
    finto.esistente = { status: 'expired' }
    expect((await scriviProposta(proposta())).scritta).toBe(true)
  })

  it('1e · accettata o «non ora» tengono ancora il posto', async () => {
    for (const status of ['accepted', 'not_now']) {
      finto.esistente = { status }
      expect(await scriviProposta(proposta())).toEqual({ scritta: false, motivo: 'gia_presente' })
    }
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

describe('the caps are for advice, not for faults (26 Sep 2026)', () => {
  const guasto = () => ({
    tenantId: 't1', area: 'operations' as const, kind: 'proposal.operationsCIHealthOutOfStep',
    params: { count: '1' }, scope: 'ci:health:2026-09-26', cause: 'ci:health',
    evidence: { n: 1, windowDays: 1, refs: [] },
    action: { type: 'ci.recompute_health', params: { ciIds: ['c1'] } },
  })

  it('an operational remedy is written even with the page full and two already born today', async () => {
    finto.aperte = 5
    finto.oggi = 2
    expect((await scriviProposta(guasto())).scritta).toBe(true)
  })

  it('a customer\'s report is not dropped by the cap either: a customer unheard is worse than one more line', async () => {
    finto.aperte = 5
    finto.oggi = 2
    const report = { ...proposta(), area: 'platform' as const, kind: 'proposal.platformCustomerReport', action: null,
      reportSource: { tenantId: 'acme', problemId: 'p1', problemNumber: 'PRB1' } }
    expect((await scriviProposta(report)).scritta).toBe(true)
  })

  it('and it does not take the analysts\' slots: the counts leave the operational ones out', async () => {
    const spia = vi.spyOn(await import('../db.js'), 'runQueryOne')
    await scriviProposta(proposta())
    const conteggio = spia.mock.calls.map((c) => c[1] as string).find((q) => q.includes('AS aperte'))!
    expect(conteggio).toContain("WHERE p.area <> 'operations'")
    spia.mockRestore()
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

// Review of 23 Sep 2026: PROPOSAL_RETENTION_MONTHS was declared and never used.
describe('la purga delle chiuse', () => {
  it('toglie accettate, rifiutate e scadute decise da più di 12 mesi', async () => {
    await purgaLeChiuse('t1', new Date('2026-09-23T00:00:00.000Z'))
    expect(finto.scritte[0]).toEqual({ tenantId: 't1', limite: '2025-09-23T00:00:00.000Z' })
  })
})
