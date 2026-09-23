/**
 * LE LETTURE DEL WORKFLOW (22 set 2026).
 *
 * ## Perché non c'erano
 * `resolvers/workflowQueries.ts` stava al 12,6%. È il file da cui la pagina di
 * un ticket sa a che punto è, quali mosse può fare e che strada ha percorso —
 * e porta tre decisioni che erano costate ognuna un difetto, tutte spiegate a
 * parole e nessuna verificata:
 *
 *  1. **il conteggio per step non fa N+1**: i field resolver degli N passi di
 *     una definizione partono nello stesso tick, e la prima chiamata fa
 *     l'unica query mentre le altre aspettano la sua promessa. Ma non è una
 *     cache: `setImmediate` la butta via, perché un `refetch` dopo
 *     un'eliminazione deve rileggere il grafo;
 *  2. **quale definizione vince** quando un tenant ne ha due attive per la
 *     stessa entità: la generica, poi la versione più alta. Il `LIMIT 1` era
 *     senza `ORDER BY`, quindi le etichette ballavano fra due caricamenti;
 *  3. **una richiesta che richiede approvazione non offre le transizioni che
 *     la salterebbero**: quel filtro stava sulla query degli incident — dove
 *     non filtrava mai — e mancava dove serviva, quindi «Prendi in carico» si
 *     vedeva e veniva rifiutato solo al clic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

const txRun = vi.fn()
vi.mock('../ci-utils.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withSession: (fn: (s: unknown) => unknown) => fn({
    executeRead: (w: (tx: unknown) => unknown) => w({ run: txRun }),
  }),
}))

const getAvailableTransitions = vi.fn()
vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: { getAvailableTransitions: (...a: unknown[]) => getAvailableTransitions(...a) },
}))

const loadTransitionRows = vi.fn()
const mapWorkflowDefinition = vi.fn((wd: Record<string, unknown>) => ({ id: wd['id'], mapped: true }))
vi.mock('../workflowMapping.js', () => ({
  loadTransitionRows: (...a: unknown[]) => loadTransitionRows(...a),
  mapWorkflowDefinition: (...a: unknown[]) => mapWorkflowDefinition(...(a as [Record<string, unknown>])),
}))

const requestApprovalWouldBeSkipped = vi.fn()
// The named-approval gate (lib/ticketApprovalGate.test.ts): here it lets everything through, and says who asked.
const transitionsOpenToApproval = vi.fn(async (_s: unknown, _t: string, _i: string, trs: unknown[], _o: boolean) => trs)
vi.mock('../../../lib/ticketApprovalGate.js', () => ({
  transitionsOpenToApproval: (...a: unknown[]) => (transitionsOpenToApproval as (...x: unknown[]) => unknown)(...a),
}))
vi.mock('../../../lib/requestApproval.js', () => ({
  requestApprovalWouldBeSkipped: (...a: unknown[]) => requestApprovalWouldBeSkipped(...a),
}))

const q = await import('../workflowQueries.js')

const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'admin', permissions: new Set() } as never

/** Un `Record` di neo4j: `get(chiave)`. */
const rec = (campi: Record<string, unknown>) => ({ get: (k: string) => campi[k] ?? null })
/** Un nodo, come lo restituisce il driver. */
const nodo = (props: Record<string, unknown>) => ({ properties: props })

async function codice(fn: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await fn(); return { code: 'NESSUN RIFIUTO', message: '' } } catch (e) {
    const g = e as GraphQLError
    return { code: String(g.extensions?.['code'] ?? 'THROWN'), message: g.message }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  txRun.mockResolvedValue({ records: [] })
  loadTransitionRows.mockResolvedValue([])
  getAvailableTransitions.mockResolvedValue([])
  requestApprovalWouldBeSkipped.mockResolvedValue(false)
})

// ══════════════════════════════════════════════════════════════════════════════
describe('i mappatori', () => {
  it('`mapWI` porta fuori i nomi dello schema, non quelli del grafo', () => {
    expect(q.mapWI({ id: 'wi1', current_step: 'triage', status: 'active', created_at: 'a', updated_at: 'b' }))
      .toEqual({ id: 'wi1', currentStep: 'triage', status: 'active', createdAt: 'a', updatedAt: 'b' })
  })

  it('`mapExec`: una durata assente resta null, un Integer di Neo4j diventa un numero', () => {
    const base = { id: 'e1', step_name: 's', entered_at: 'a', triggered_by: 'u', trigger_type: 'manual' }
    expect(q.mapExec(base)).toMatchObject({ durationMs: null, exitedAt: null, notes: null })
    expect(q.mapExec({ ...base, duration_ms: { toNumber: () => 1500 } }).durationMs).toBe(1500)
    // E un numero JS con la virgola si arrotonda: i millisecondi sono interi.
    expect(q.mapExec({ ...base, duration_ms: 1500.7 }).durationMs).toBe(1501)
  })
})

describe('quante istanze stanno su questo passo — e perché non è N+1', () => {
  const passo = (name: string) => ({ definitionId: 'wd1', name })

  it('N passi della stessa definizione fanno UNA query sola', async () => {
    txRun.mockResolvedValue({ records: [rec({ name: 'a', n: 3 }), rec({ name: 'b', n: 0 })] })
    const [a, b] = await Promise.all([
      q.workflowStepCurrentInstances(passo('a'), null, ctx),
      q.workflowStepCurrentInstances(passo('b'), null, ctx),
    ])
    expect([a, b]).toEqual([3, 0])
    expect(txRun).toHaveBeenCalledTimes(1)
  })

  it('NON è una cache: al giro dopo si rilegge il grafo', async () => {
    // Il giro precedente puo' aver lasciato la sua promessa in sospeso: si
    // aspetta il `setImmediate` che la butta via, altrimenti questo test
    // misurerebbe la coda dell'altro.
    await new Promise((r) => setImmediate(r))
    txRun.mockClear()
    txRun.mockResolvedValue({ records: [rec({ name: 'a', n: 3 })] })
    expect(await q.workflowStepCurrentInstances(passo('a'), null, ctx)).toBe(3)
    // `setImmediate` ha buttato via la promessa: un refetch dopo
    // un'eliminazione deve vedere il numero nuovo.
    await new Promise((r) => setImmediate(r))
    txRun.mockResolvedValue({ records: [rec({ name: 'a', n: 0 })] })
    expect(await q.workflowStepCurrentInstances(passo('a'), null, ctx)).toBe(0)
    expect(txRun).toHaveBeenCalledTimes(2)
  })

  it('un passo senza definizione, o non in quella definizione, si DICE: non si risponde zero', async () => {
    expect((await codice(() => q.workflowStepCurrentInstances({ definitionId: null, name: 'x' }, null, ctx))).message)
      .toContain('has no definition_id')

    txRun.mockResolvedValue({ records: [rec({ name: 'altro', n: 1 })] })
    const r = await codice(() => q.workflowStepCurrentInstances(passo('x'), null, ctx))
    expect(r.code).toBe('CONFLICT')
    expect(r.message).toContain('not found in definition wd1')
  })

  it('zero istanze è un numero, non un\'assenza', async () => {
    txRun.mockResolvedValue({ records: [rec({ name: 'a', n: 0 })] })
    expect(await q.workflowStepCurrentInstances(passo('a'), null, ctx)).toBe(0)
  })
})

describe('quale definizione vince quando ce ne sono due attive', () => {
  it('la generica prima, poi la versione più alta — e il LIMIT 1 ha un ORDER BY', async () => {
    txRun.mockResolvedValue({ records: [rec({ wd: nodo({ id: 'wd1' }), steps: [] })] })
    await q.workflowDefinition(null, { entityType: 'incident' }, ctx)
    // Senza i commenti: quello sopra la query CITA il «LIMIT 1 senza ORDER BY»
    // di prima, e confrontare le posizioni col commento dentro misurerebbe la
    // spiegazione invece della query.
    const cypher = String(txRun.mock.calls[0]![0]).replace(/\/\/[^\n]*/g, '')
    expect(cypher).toContain('ORDER BY (wd.category IS NULL) DESC, wd.version DESC, wd.name')
    expect(cypher.indexOf('ORDER BY')).toBeLessThan(cypher.indexOf('LIMIT 1'))
  })

  it('nessuna definizione: null, non un oggetto vuoto', async () => {
    expect(await q.workflowDefinition(null, { entityType: 'incident' }, ctx)).toBeNull()
    expect(await q.workflowDefinitionById(null, { id: 'wd9' }, ctx)).toBeNull()
  })
})

describe('le etichette dei passi: si leggono da TUTTE le definizioni attive', () => {
  it('a parità di nome vince la prima — l\'ordine è quello della query, generica e versione alta', async () => {
    txRun.mockResolvedValue({ records: [
      rec({ name: 'submitted', label: 'Inviata', labels: null }),
      rec({ name: 'submitted', label: 'Submitted', labels: null }),
      rec({ name: 'closed', label: null, labels: null }),
    ] })
    const out = await q.workflowStepLabels(null, { entityType: 'service_request' }, ctx) as Array<Record<string, unknown>>
    expect(out.map((s) => [s['name'], s['label']])).toEqual([
      ['submitted', 'Inviata'],
      // Senza etichetta si mostra il nome: meglio il nome interno che niente.
      ['closed', 'closed'],
    ])
  })
})

describe('le letture legate a un ticket', () => {
  it('un incident senza workflow: `null` per l\'istanza, `[]` per le mosse, `[]` per la storia', async () => {
    expect(await q.incidentWorkflow(null, { incidentId: 'i1' }, ctx)).toBeNull()
    expect(await q.incidentAvailableTransitions(null, { incidentId: 'i1' }, ctx)).toEqual([])
    expect(await q.incidentWorkflowHistory(null, { incidentId: 'i1' }, ctx)).toEqual([])
    expect(getAvailableTransitions).not.toHaveBeenCalled()
  })

  it('col workflow: le mosse le chiede al MOTORE, non le indovina', async () => {
    txRun.mockResolvedValue({ records: [rec({ instanceId: 'wi1' })] })
    getAvailableTransitions.mockResolvedValue([{ toStep: 'in_progress' }])
    expect(await q.incidentAvailableTransitions(null, { incidentId: 'i1' }, ctx)).toEqual([{ toStep: 'in_progress' }])
    expect(getAvailableTransitions.mock.calls[0]![1]).toBe('wi1')
  })

  it('la storia esce in ordine di ingresso, e ogni riga passa dal mappatore', async () => {
    txRun.mockResolvedValue({ records: [
      rec({ exec: nodo({ id: 'e1', step_name: 'new', entered_at: '1', triggered_by: 'u', trigger_type: 'manual' }) }),
    ] })
    const out = await q.incidentWorkflowHistory(null, { incidentId: 'i1' }, ctx) as Array<Record<string, unknown>>
    expect(out[0]).toMatchObject({ id: 'e1', stepName: 'new' })
    expect(String(txRun.mock.calls[0]![0])).toContain('ORDER BY exec.entered_at ASC')
  })

  it('il tenant sta in OGNI lettura, anche in quelle di campo', async () => {
    await q.incidentWorkflowInstance({ id: 'i1' }, null, ctx)
    await q.changeWorkflowInstance({ id: 'c1' }, null, ctx)
    await q.serviceRequestWorkflowInstance({ id: 'r1' }, null, ctx)
    for (const [cypher, params] of txRun.mock.calls as Array<[string, Record<string, unknown>]>) {
      expect(String(cypher)).toContain('tenant_id: $tenantId')
      expect(params['tenantId']).toBe('t1')
    }
  })
})

describe('una richiesta che richiede approvazione non offre le mosse che la salterebbero', () => {
  beforeEach(() => {
    txRun.mockResolvedValue({ records: [rec({ instanceId: 'wi1' })] })
    getAvailableTransitions.mockResolvedValue([{ toStep: 'in_progress' }, { toStep: 'approval' }])
  })

  it('la mossa che salterebbe l\'approvazione si toglie PRIMA, non si rifiuta al clic', async () => {
    requestApprovalWouldBeSkipped.mockImplementation(async (_s: unknown, _t: string, _i: string, passo: string) =>
      passo === 'in_progress')
    const out = await q.serviceRequestAvailableTransitionsField({ id: 'r1' }, null, ctx) as Array<Record<string, unknown>>
    expect(out).toEqual([{ toStep: 'approval' }])
  })

  it('se non c\'è niente da saltare escono tutte', async () => {
    const out = await q.serviceRequestAvailableTransitionsField({ id: 'r1' }, null, ctx) as unknown[]
    expect(out).toHaveLength(2)
  })

  it('e il filtro NON sta sugli incident: lì le mosse escono come le dà il motore', async () => {
    const out = await q.incidentAvailableTransitionsField({ id: 'i1' }, null, ctx) as unknown[]
    expect(out).toHaveLength(2)
    expect(requestApprovalWouldBeSkipped).not.toHaveBeenCalled()
    // The gate of a NAMED approval is on incidents too (review of 23 Sep 2026).
    expect(transitionsOpenToApproval).toHaveBeenCalledWith(expect.anything(), ctx.tenantId, expect.any(String), expect.any(Array), expect.any(Boolean))
  })
})

describe('l\'elenco delle definizioni', () => {
  it('per difetto solo le attive', async () => {
    await q.workflowDefinitions(null, {}, ctx)
    expect((txRun.mock.calls[0]![1] as Record<string, unknown>)['includeInactive']).toBe(false)
  })

  it('`includeInactive`: senza, una copia appena duplicata — che nasce SPENTA — era invisibile a ogni pagina', async () => {
    await q.workflowDefinitions(null, { includeInactive: true }, ctx)
    expect((txRun.mock.calls[0]![1] as Record<string, unknown>)['includeInactive']).toBe(true)
  })

  it('ogni definizione porta le sue transizioni', async () => {
    txRun.mockResolvedValue({ records: [
      rec({ wd: nodo({ id: 'wd1' }), steps: [] }),
      rec({ wd: nodo({ id: 'wd2' }), steps: [] }),
    ] })
    const out = await q.workflowDefinitions(null, {}, ctx) as unknown[]
    expect(out).toHaveLength(2)
    expect(loadTransitionRows.mock.calls.map((c) => c[1])).toEqual(['wd1', 'wd2'])
  })
})
