/**
 * B0-3 (D-24 / B-10): la scheda «Aperti» del portale e il contatore della home
 * devono avere UNA definizione sola di «aperto», presa dal dato dei passi
 * (`is_open`, `is_initial`, `is_terminal`, `category`) e non dai nomi.
 *
 * Prima: `myTickets(status: 'open')` confrontava `i.status = 'open'`, un nome
 * di passo che nessun workflow definisce (di fabbrica il passo iniziale è
 * `new`) → scheda sempre vuota; il contatore invece contava i passi
 * `isInitial` → un terzo insieme ancora diverso.
 *
 * Ogni test usa un tenant diverso: `loadSteps` ha una cache per
 * tenant+entità che sopravvive fra i test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'

const mockSession = {
  executeRead:  vi.fn(),
  executeWrite: vi.fn(),
  close:        vi.fn().mockResolvedValue(undefined),
}

vi.mock('@opengraphity/neo4j', async () => {
  const actual = await vi.importActual<typeof import('@opengraphity/neo4j')>('@opengraphity/neo4j')
  return { ...actual, getSession: vi.fn() }
})
vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: { createInstance: vi.fn(), transition: vi.fn(), getAvailableTransitions: vi.fn(), registerCondition: vi.fn() },
}))
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/publishEvent.js', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }))

const { portalResolvers } = await import('../portal.js')
const { stepStatusClasses, getStepNamesByClass, TICKET_STATUS_CLASSES } = await import('../../../lib/workflowHelpers.js')

const myTickets     = portalResolvers.Query.myTickets
const myTicketStats = portalResolvers.Query.myTicketStats

const ctxFor = (tenantId: string): GraphQLContext =>
  ({ tenantId, userId: 'user-1', userEmail: 'user@test.io', role: 'end_user' })

const rec = (map: Record<string, unknown>) => ({ get: (k: string) => (k in map ? map[k] : null) })

interface Step { name: string; isInitial?: boolean; isTerminal?: boolean; isOpen?: boolean; category?: string | null }

/** I passi di fabbrica di «Incident Management» (come c-one dal vivo). */
const FACTORY_STEPS: Step[] = [
  { name: 'new',         isInitial: true,  isOpen: true,  category: 'active' },
  { name: 'assigned',                      isOpen: true,  category: 'active' },
  { name: 'in_progress',                   isOpen: true,  category: 'active' },
  { name: 'pending',                       isOpen: true,  category: 'waiting' },
  { name: 'escalated',                     isOpen: true,  category: 'escalated' },
  { name: 'resolved',    isTerminal: true, isOpen: false, category: 'resolved' },
  { name: 'closed',      isTerminal: true, isOpen: false, category: 'closed' },
]

/**
 * Sessione che risponde alla lettura dei passi con `steps`, ai conteggi con
 * `counts` (status → numero) e alla lista con le righe corrispondenti.
 */
function primeSession(steps: Step[], counts: Record<string, number> = {}) {
  const calls: Array<{ cypher: string; params: Record<string, unknown> }> = []
  const tx = {
    run: vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
      calls.push({ cypher, params })
      if (cypher.includes('WorkflowDefinition')) {
        return { records: steps.map((s) => rec({
          name: s.name,
          isInitial:  s.isInitial  ?? false,
          isTerminal: s.isTerminal ?? false,
          isOpen:     s.isOpen     ?? true,
          category:   s.category   ?? null,
          stepOrder:  null,
        })) }
      }
      if (cypher.includes('count(i) AS total')) {
        const statuses = params['statuses'] as string[] | null
        const total = Object.entries(counts)
          .filter(([status]) => !statuses || statuses.includes(status))
          .reduce((acc, [, n]) => acc + n, 0)
        return { records: [rec({ total })] }
      }
      if (cypher.includes('RETURN i.status AS status, count(i) AS cnt')) {
        return { records: Object.entries(counts).map(([status, cnt]) => rec({ status, cnt })) }
      }
      // lista dei ticket
      const statuses = params['statuses'] as string[] | null
      const rows = Object.entries(counts)
        .filter(([status]) => !statuses || statuses.includes(status))
        .flatMap(([status, n]) => Array.from({ length: n }, (_v, i) => rec({
          props: { id: `${status}-${i}`, title: 't', status, priority: 'high', category: 'other', created_at: 'c', updated_at: 'u' },
          assignedTeam: null,
        })))
      return { records: rows }
    }),
  }
  mockSession.executeRead.mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx))
  mockSession.executeWrite.mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx))
  return { calls, tx }
}

beforeEach(() => { vi.clearAllMocks() })

// ── La classificazione, dal dato ──────────────────────────────────────────────

describe('stepStatusClasses — classi dedotte dai metadata, non dai nomi', () => {
  const row = (s: Step) => ({
    name: s.name, isInitial: s.isInitial ?? false, isTerminal: s.isTerminal ?? false,
    isOpen: s.isOpen ?? true, category: s.category ?? null, stepOrder: null,
  })

  it('i passi di fabbrica si distribuiscono su open / in_progress / resolved / closed', () => {
    const byName = Object.fromEntries(FACTORY_STEPS.map((s) => [s.name, stepStatusClasses(row(s))]))
    expect(byName['new']).toEqual(['open'])
    expect(byName['assigned']).toEqual(['open', 'in_progress'])
    expect(byName['pending']).toEqual(['open', 'in_progress'])
    expect(byName['escalated']).toEqual(['open', 'in_progress'])
    expect(byName['resolved']).toEqual(['resolved'])
    expect(byName['closed']).toEqual(['closed'])
  })

  it('un passo RINOMINATO dal cliente resta nella sua classe (nessun nome è cablato)', () => {
    expect(stepStatusClasses(row({ name: 'preso in carico', isOpen: true, category: 'active' })))
      .toEqual(['open', 'in_progress'])
    expect(stepStatusClasses(row({ name: 'archiviato', isTerminal: true, isOpen: false, category: 'closed' })))
      .toEqual(['closed'])
  })

  it('getStepNamesByClass: due definizioni attive → unione dei nomi per classe', async () => {
    primeSession([...FACTORY_STEPS, { name: 'security_review', isOpen: true, category: 'active' }])
    const byClass = await getStepNamesByClass(mockSession as never, 'tenant-union', 'incident')
    expect(byClass.open).toEqual(['new', 'assigned', 'in_progress', 'pending', 'escalated', 'security_review'])
    expect(byClass.in_progress).toEqual(['assigned', 'in_progress', 'pending', 'escalated', 'security_review'])
    expect(byClass.resolved).toEqual(['resolved'])
    expect(byClass.closed).toEqual(['closed'])
  })
})

// ── myTickets: la scheda «Aperti» ────────────────────────────────────────────

describe('myTickets — status è una classe, tradotta nei passi del tenant', () => {
  it('«Aperti» elenca i ticket nei passi aperti del workflow (mai `i.status = \'open\'`)', async () => {
    const { calls } = primeSession(FACTORY_STEPS, { new: 3, assigned: 2, resolved: 1, closed: 10 })

    const out = await myTickets(null, { status: 'open' }, ctxFor('tenant-open'))

    const list = calls.find((c) => c.cypher.includes('SKIP toInteger($offset)'))!
    expect(list.cypher).toContain('i.status IN $statuses')
    expect(list.cypher).not.toContain("i.status = $status")
    expect(list.params['statuses']).toEqual(['new', 'assigned', 'in_progress', 'pending', 'escalated'])
    // 3 in `new` + 2 in `assigned`: la scheda NON è più vuota
    expect(out.total).toBe(5)
    expect(out.items).toHaveLength(5)
  })

  it('«In corso» esclude il passo iniziale; «Chiusi» è il terminale non risolto', async () => {
    const p1 = primeSession(FACTORY_STEPS, { new: 3, assigned: 2 })
    await myTickets(null, { status: 'in_progress' }, ctxFor('tenant-prog'))
    expect(p1.calls.find((c) => c.cypher.includes('SKIP'))!.params['statuses'])
      .toEqual(['assigned', 'in_progress', 'pending', 'escalated'])

    const p2 = primeSession(FACTORY_STEPS, { closed: 4 })
    await myTickets(null, { status: 'closed' }, ctxFor('tenant-closed'))
    expect(p2.calls.find((c) => c.cypher.includes('SKIP'))!.params['statuses']).toEqual(['closed'])
  })

  it('senza status nessun filtro (statuses = null)', async () => {
    const { calls } = primeSession(FACTORY_STEPS, { new: 1, closed: 1 })
    const out = await myTickets(null, {}, ctxFor('tenant-all'))
    expect(calls.find((c) => c.cypher.includes('SKIP'))!.params['statuses']).toBeNull()
    expect(out.total).toBe(2)
  })

  it('una classe inventata è un errore che nomina le classi ammesse (mai una lista vuota)', async () => {
    primeSession(FACTORY_STEPS)
    const err = await myTickets(null, { status: 'in_lavorazione' }, ctxFor('tenant-bad'))
      .then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).message).toContain(TICKET_STATUS_CLASSES.join(', '))
    expect((err as GraphQLError).message).toContain('in_lavorazione')
  })

  it('fail-loud: se nessun passo del tenant è aperto, lo dice invece di mostrare zero righe', async () => {
    primeSession([
      { name: 'archiviato', isInitial: true, isTerminal: true, isOpen: false, category: 'closed' },
    ], { archiviato: 7 })

    const err = await myTickets(null, { status: 'open' }, ctxFor('tenant-noopen'))
      .then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).message).toMatch(/declares no step in the "open" class/)
    expect((err as GraphQLError).extensions['code']).toBe('BAD_USER_INPUT')
  })
})

// ── I due numeri coincidono ──────────────────────────────────────────────────

describe('myTicketStats — lo stesso insieme di passi della scheda', () => {
  it('il contatore «Aperti» della home è lo stesso numero della scheda «Aperti»', async () => {
    const counts = { new: 3, assigned: 2, in_progress: 4, pending: 1, resolved: 5, closed: 10 }

    primeSession(FACTORY_STEPS, counts)
    const stats = await myTicketStats(null, {}, ctxFor('tenant-match'))

    primeSession(FACTORY_STEPS, counts)
    const list = await myTickets(null, { status: 'open' }, ctxFor('tenant-match'))

    expect(stats.open).toBe(10)          // 3 + 2 + 4 + 1
    expect(list.total).toBe(stats.open)  // ← il difetto era esattamente questo
    expect(stats.inProgress).toBe(7)     // senza il passo iniziale
    expect(stats.resolved).toBe(15)      // risolti + chiusi, come prima
    expect(stats.total).toBe(25)
  })

  /**
   * Un ticket in un passo che il workflow attivo non classifica non finirebbe
   * in nessuno dei tre contatori restando però nel totale: la home mostrerebbe
   * «0 aperti, 0 risolti, 3 ticket». È lo stesso silenzio della scheda vuota,
   * spostato di un numero — quindi è un errore che nomina gli stati.
   */
  it('uno stato che nessuna classe del tenant contiene → errore che lo nomina, non un contatore muto', async () => {
    primeSession(FACTORY_STEPS, { new: 3, in_attesa_di_terzi: 2 })
    const err = await myTicketStats(null, {}, ctxFor('tenant-drift')).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).message).toMatch(/in_attesa_di_terzi \(2\)/)
    expect((err as GraphQLError).message).toMatch(/non appartengono a nessuna classe/)
  })
})
