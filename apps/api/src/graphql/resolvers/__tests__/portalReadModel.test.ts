/**
 * Il portale legge i suoi ticket con Cypher proprie: ogni parametro che una
 * query nomina deve arrivare davvero (revisione del 14 set 2026).
 *
 *  - IT-6: lo storico del ticket usava `$tenantId` ma passava solo `{ id }` —
 *    Neo4j rifiuta la query, e il dettaglio di ogni ticket del portale falliva.
 *    Nessun test lo vedeva perché i mock non guardavano i parametri.
 *  - IT-5: il team si cercava con `[:ASSIGNED_TO]->(:Team)`, ma l'assegnazione
 *    a un gruppo è `ASSIGNED_TO_TEAM`: «Assegnato a» era sempre vuoto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'

const runs: { cypher: string; params: Record<string, unknown> }[] = []
const ticketProps = {
  id: 'inc-1', number: 'INC00000001', title: 'Stampante', status: 'new', severity: 'high', category: 'hardware',
  created_by: 'user-1', created_at: 'a', updated_at: 'b',
}

function answer(cypher: string) {
  if (cypher.includes('count(i) AS total')) return [{ get: () => 1 }]
  if (cypher.includes('STEP_HISTORY')) return [{ get: (k: string) => ({ fromStep: null, toStep: 'new', triggeredAt: 't', triggeredBy: 'user-1' } as Record<string, unknown>)[k] }]
  if (cypher.includes('RETURN properties(i) AS props')) {
    return [{ get: (k: string) => (k === 'props' ? ticketProps : k === 'assignedTeam' ? 'Service Desk' : null) }]
  }
  return []
}

const session = {
  executeRead: vi.fn(async (fn: (tx: unknown) => unknown) => fn({
    run: async (cypher: string, params: Record<string, unknown>) => {
      runs.push({ cypher, params })
      return { records: answer(cypher) }
    },
  })),
}

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(), toNumber: (v: unknown) => Number(v ?? 0) }))
vi.mock('../../../lib/tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'en') }))
// Verifica «Cosa resta cablato», ondata 1: le severità offerte nel portale.
vi.mock('../../../lib/portalSeverityOptions.js', () => import('../../../lib/__tests__/portalSeverityOptionsFake.js'))
vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: { createInstance: vi.fn(), transition: vi.fn(), getAvailableTransitions: vi.fn() } }))
vi.mock('../ci-utils.js', () => ({ withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(session)) }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))
vi.mock('../../../lib/publishEvent.js', () => ({ publishEvent: vi.fn() }))
vi.mock('../../../lib/vocabularyEntries.js', () => ({ loadVocabularyEntries: vi.fn(async () => ({ values: ['hardware', 'security'], labels: { security: { it: 'Sicurezza', en: 'Security' } }, colors: {} })) }))
vi.mock('../../../lib/workflowHelpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/workflowHelpers.js')>()),
  getWorkflowSteps: vi.fn(async () => [
    { name: 'new', label: 'New', labels: [{ language: 'it', label: 'Nuovo' }], isInitial: true, isTerminal: false, isOpen: true, category: 'active', purpose: null, stepOrder: 1 },
  ]),
  getStepNamesByClass: vi.fn(async () => ({ open: ['new'], in_progress: [], resolved: [], closed: [] })),
}))

const { portalResolvers } = await import('../portal.js')
const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'u@x', role: 'end_user' }

/** Ogni `$nome` della Cypher ha il suo parametro. */
function expectAllParamsBound() {
  expect(runs.length).toBeGreaterThan(0)
  for (const r of runs) {
    const names = [...new Set([...r.cypher.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!))]
    for (const n of names) expect(r.params, `$${n} in:\n${r.cypher}`).toHaveProperty(n)
  }
}

beforeEach(() => { runs.length = 0 })

describe('portale — read model', () => {
  it('myTicket: ogni parametro nominato arriva (storico compreso)', async () => {
    const t = await portalResolvers.Query.myTicket(null, { id: 'inc-1' }, ctx)
    expect(runs.some((r) => r.cypher.includes('STEP_HISTORY'))).toBe(true)
    expectAllParamsBound()
    expect(t).toMatchObject({ priority: 'high', assignedTeam: 'Service Desk' })
  })

  it('myTicket: le risposte sono i Comment dello staff, solo quelli pubblici (F1)', async () => {
    await portalResolvers.Query.myTicket(null, { id: 'inc-1' }, ctx)
    const q = runs.find((r) => r.cypher.includes('HAS_COMMENT'))
    expect(q, 'nessuna lettura dei commenti').toBeDefined()
    expect(q!.cypher).toContain('-[:HAS_COMMENT]->(c:Comment)')
    expect(q!.cypher).toContain('c.is_internal = false')
    expect(runs.some((r) => r.cypher.includes('EntityComment'))).toBe(false)
  })

  /**
   * Giro nel browser del 14 set 2026: «My tickets» mostrava «I cannot list the
   * tickets of this tab — missing required property 'category'». Un incident
   * aperto da un allarme non ha categoria, com'è legittimo, e UN ticket così
   * faceva fallire l'elenco intero. La categoria è facoltativa: null.
   */
  it('myTickets e myTicket: un incident senza categoria si elenca, con categoria null', async () => {
    const saved = ticketProps.category
    ;(ticketProps as Record<string, unknown>)['category'] = undefined
    try {
      const list = await portalResolvers.Query.myTickets(null, {}, ctx) as { items?: Array<{ category: unknown }> } | Array<{ category: unknown }>
      const items = Array.isArray(list) ? list : (list.items ?? [])
      expect(items[0]).toMatchObject({ category: null })
      await expect(portalResolvers.Query.myTicket(null, { id: 'inc-1' }, ctx)).resolves.toMatchObject({ category: null })
    } finally {
      ticketProps.category = saved
    }
  })

  it('myTickets: ogni parametro nominato arriva', async () => {
    await portalResolvers.Query.myTickets(null, { status: 'open' }, ctx)
    expectAllParamsBound()
  })

  it('il team si legge da ASSIGNED_TO_TEAM, mai da ASSIGNED_TO', async () => {
    await portalResolvers.Query.myTicket(null, { id: 'inc-1' }, ctx)
    await portalResolvers.Query.myTickets(null, {}, ctx)
    const teamQueries = runs.filter((r) => r.cypher.includes('(t:Team)'))
    expect(teamQueries.length).toBe(2)
    for (const q of teamQueries) {
      expect(q.cypher).toContain('[:ASSIGNED_TO_TEAM]->(t:Team)')
      expect(q.cypher).not.toContain('[:ASSIGNED_TO]->(t:Team)')
    }
  })
})

/** Giro nel browser del 14 set 2026: stati «Nuovo» in inglese, storia «start → new», nessun numero, categorie fisse. */
describe('portale — lingua, numero, categorie', () => {
  it('stato e storia nella lingua chiesta; il numero del ticket c\'è', async () => {
    const it_ = await portalResolvers.Query.myTicket(null, { id: 'inc-1', language: 'it' }, ctx) as { statusLabel: string; number: string; history: Array<{ fromLabel: string | null; toLabel: string | null }> }
    expect(it_).toMatchObject({ statusLabel: 'Nuovo', number: 'INC00000001' })
    expect(it_.history[0]).toMatchObject({ fromLabel: null, toLabel: 'Nuovo' })
    const en = await portalResolvers.Query.myTickets(null, { language: 'en' }, ctx) as { items: Array<{ statusLabel: string }> }
    expect(en.items[0]!.statusLabel).toBe('New')
  })

  it('le categorie sono il vocabolario del cliente, con le etichette del Dizionario', async () => {
    const cats = await portalResolvers.Query.ticketCategories(null, { language: 'it' }, ctx)
    expect(cats.map((c: { name: string }) => c.name)).toEqual(['hardware', 'security'])
    expect(cats[1]).toMatchObject({ label: 'Sicurezza' })
  })
})

