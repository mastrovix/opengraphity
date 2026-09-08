/**
 * requestService.createRequest / completeRequest / mapRequest — Neo4j,
 * workflow ed eventi mockati. Pinna: numero REQ + 8 cifre dal contatore
 * atomico (kind "service_request"), stato = step iniziale del workflow,
 * istanza di workflow, REQUESTED_BY, evento request.created con tenant/attore,
 * chiusura tramite transizione dell'engine (mai r.status a mano).
 *
 * La verifica del catalogo (item inesistente / non del tenant → NotFoundError,
 * campi obbligatori → VALIDATION_ERROR) vive nel resolver createServiceRequest:
 * vedi graphql/resolvers/__tests__/serviceRequestCreate.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  session: { executeRead: vi.fn(), executeWrite: vi.fn(), close: vi.fn() },
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession:  vi.fn(),
  runQuery:    vi.fn(),
  runQueryOne: vi.fn(),
  toNumber:    (v: unknown) => (typeof v === 'object' && v !== null && 'toNumber' in v ? (v as { toNumber(): number }).toNumber() : Number(v)),
}))
vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: { createInstance: vi.fn(), transition: vi.fn(), registerCondition: vi.fn() },
}))
vi.mock('../../graphql/resolvers/ci-utils.js', () => ({
  withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(h.session)),
  getSession:  vi.fn(),
}))
vi.mock('../../lib/publishEvent.js', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/workflowHelpers.js', () => ({
  getInitialStepName: vi.fn().mockResolvedValue('submitted'),
  getWorkflowSteps:   vi.fn().mockResolvedValue([]),
}))

const { createRequest, completeRequest, mapRequest } = await import('../requestService.js')
const { runQuery } = await import('@opengraphity/neo4j')
const { workflowEngine } = await import('@opengraphity/workflow')
const { publishEvent } = await import('../../lib/publishEvent.js')
const { getWorkflowSteps } = await import('../../lib/workflowHelpers.js')

const ctx = { tenantId: 'tenant-1', userId: 'user-1' }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

type Call = [string, Record<string, unknown>]
const queriesWith = (needle: string): Call[] =>
  vi.mocked(runQuery).mock.calls
    .map(c => [c[1] as string, c[2] as Record<string, unknown>] as Call)
    .filter(([cypher]) => cypher.includes(needle))

const STEPS = [
  { name: 'submitted', isInitial: true,  isTerminal: false, isOpen: true,  category: null,     stepOrder: 1 },
  { name: 'fulfilled', isInitial: false, isTerminal: true,  isOpen: false, category: 'closed', stepOrder: 2 },
]

beforeEach(() => {
  vi.clearAllMocks()
  h.session.executeWrite.mockResolvedValue({ records: [{ get: () => 5 }] })
  vi.mocked(runQuery).mockImplementation(async (_s: unknown, cypher: string, params?: Record<string, unknown>) => {
    if (cypher.includes('CREATE (r:ServiceRequest')) {
      return [{ props: {
        id: params?.['id'], tenant_id: params?.['tenantId'], number: params?.['number'], title: params?.['title'],
        description: params?.['description'], status: params?.['status'], priority: params?.['priority'], due_date: params?.['dueDate'],
        catalog_item_id: params?.['catalogItemId'], requires_approval: params?.['requiresApproval'],
        created_at: params?.['now'], updated_at: params?.['now'],
      } }]
    }
    if (cypher.includes('HAS_WORKFLOW')) return [{ instanceId: 'wi-sr', step: 'submitted' }]
    if (cypher.includes('SET r.completed_at')) return [{ props: { id: params?.['id'], number: 'REQ00000005', title: 'T', status: 'fulfilled', priority: 'medium', completed_at: params?.['now'] } }]
    return []
  })
  vi.mocked(workflowEngine.createInstance).mockResolvedValue({ id: 'wi-sr' } as never)
  vi.mocked(workflowEngine.transition).mockResolvedValue({ success: true } as never)
  vi.mocked(getWorkflowSteps).mockResolvedValue(STEPS)
})

// ── createRequest ─────────────────────────────────────────────────────────────

describe('createRequest', () => {
  it('numero REQ + 8 cifre dal contatore atomico (kind "service_request", tenant corrente)', async () => {
    await createRequest({ title: 'Nuovo laptop', priority: 'medium' }, ctx)
    expect(h.session.executeWrite).toHaveBeenCalledTimes(1)
    const tx = { run: vi.fn().mockResolvedValue({ records: [{ get: () => 5 }] }) }
    await (h.session.executeWrite.mock.calls[0]![0] as (t: typeof tx) => Promise<unknown>)(tx)
    expect(tx.run.mock.calls[0]![0]).toMatch(/MERGE \(c:Counter \{tenant_id: \$tenantId, kind: \$kind\}\)/)
    expect(tx.run.mock.calls[0]![1]).toEqual({ tenantId: 'tenant-1', kind: 'service_request' })

    const [[, params]] = queriesWith('CREATE (r:ServiceRequest')
    expect(params['number']).toBe('REQ00000005')
    expect(params['number']).toMatch(/^REQ\d{8}$/)
  })

  it('stato iniziale = primo step del workflow service_request (nessun "open" fantasma)', async () => {
    const created = await createRequest({ title: 'T', priority: 'low' }, ctx)
    const [[, params]] = queriesWith('CREATE (r:ServiceRequest')
    expect(params['status']).toBe('submitted')
    expect(created.status).toBe('submitted')
  })

  it('scrive tutti i campi (catalogo, approvazione, scadenza) con default espliciti e restituisce il mapping unico', async () => {
    const created = await createRequest(
      { title: 'VPN', description: 'accesso', priority: 'high', dueDate: '2026-10-01', catalogItemId: 'cat-1', requiresApproval: true }, ctx)
    const [[, params]] = queriesWith('CREATE (r:ServiceRequest')
    expect(params).toMatchObject({
      tenantId: 'tenant-1', title: 'VPN', description: 'accesso', priority: 'high', dueDate: '2026-10-01',
      catalogItemId: 'cat-1', requiresApproval: true,
    })
    expect(params['id']).toMatch(UUID_RE)
    expect(created).toMatchObject({
      id: params['id'], number: 'REQ00000005', tenantId: 'tenant-1', title: 'VPN', description: 'accesso', status: 'submitted',
      priority: 'high', dueDate: '2026-10-01', catalogItemId: 'cat-1', requiresApproval: true, requestedBy: null, assignee: null,
    })

    vi.clearAllMocks()
    const bare = await createRequest({ title: 'T', priority: 'low' }, ctx)
    const [[, p2]] = queriesWith('CREATE (r:ServiceRequest')
    expect(p2).toMatchObject({ description: null, dueDate: null, catalogItemId: null, requiresApproval: false })
    expect(bare).toMatchObject({ catalogItemId: null, requiresApproval: false })
  })

  it('collega il richiedente con REQUESTED_BY (tenant-scoped) e crea l\'istanza di workflow service_request', async () => {
    await createRequest({ title: 'T', priority: 'low' }, ctx)
    const [[cypher, params]] = queriesWith('MERGE (r)-[:REQUESTED_BY]->(u)')
    expect(cypher).toContain('OPTIONAL MATCH (u:User {id: $userId, tenant_id: $tenantId})')
    expect(params).toMatchObject({ tenantId: 'tenant-1', userId: 'user-1' })
    expect(workflowEngine.createInstance).toHaveBeenCalledTimes(1)
    expect(workflowEngine.createInstance).toHaveBeenCalledWith(h.session, 'tenant-1', expect.stringMatching(UUID_RE), 'service_request')
  })

  it('pubblica request.created con tenant, attore e payload minimo', async () => {
    await createRequest({ title: 'T', priority: 'high' }, ctx)
    expect(publishEvent).toHaveBeenCalledTimes(1)
    expect(publishEvent).toHaveBeenCalledWith('request.created', 'tenant-1', 'user-1',
      { id: expect.stringMatching(UUID_RE), title: 'T', priority: 'high' }, expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/))
  })

  it('CREATE senza riga → errore esplicito; niente workflow né evento', async () => {
    vi.mocked(runQuery).mockResolvedValue([])
    await expect(createRequest({ title: 'T', priority: 'low' }, ctx)).rejects.toThrow('Failed to create service request')
    expect(workflowEngine.createInstance).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
  })
})

// ── completeRequest ───────────────────────────────────────────────────────────

describe('completeRequest', () => {
  it('richiesta senza istanza di workflow (o inesistente nel tenant) → errore esplicito', async () => {
    vi.mocked(runQuery).mockResolvedValue([])
    await expect(completeRequest('sr-1', ctx)).rejects.toThrow('ServiceRequest not found (or without workflow instance)')
    expect(workflowEngine.transition).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('senza step "fulfilled" né terminale di chiusura → errore esplicito', async () => {
    vi.mocked(getWorkflowSteps).mockResolvedValue([{ name: 'submitted', isInitial: true, isTerminal: false, isOpen: true, category: null, stepOrder: 1 }])
    await expect(completeRequest('sr-1', ctx)).rejects.toThrow('nessuno step "fulfilled" o terminale di chiusura definito')
    expect(workflowEngine.transition).not.toHaveBeenCalled()
  })

  it('evade con una transizione dell\'engine verso "fulfilled", poi imposta completed_at e pubblica request.completed', async () => {
    const done = await completeRequest('sr-1', ctx)
    expect(workflowEngine.transition).toHaveBeenCalledWith(h.session,
      { instanceId: 'wi-sr', toStepName: 'fulfilled', triggeredBy: 'user-1', triggerType: 'manual', tenantId: 'tenant-1', notes: 'Richiesta evasa' },
      { userId: 'user-1', entityData: {} })
    const [[cypher, params]] = queriesWith('SET r.completed_at')
    expect(cypher).toContain('MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId})')
    expect(cypher).not.toMatch(/SET r\.status/)
    expect(params).toMatchObject({ id: 'sr-1', tenantId: 'tenant-1' })
    expect(done).toMatchObject({ id: 'sr-1', status: 'fulfilled', completedAt: params['now'] })
    expect(publishEvent).toHaveBeenCalledWith('request.completed', 'tenant-1', 'user-1', { id: 'sr-1', completed_at: params['now'] }, params['now'])
  })

  it('ricade sul primo step terminale di categoria closed se "fulfilled" non esiste', async () => {
    vi.mocked(getWorkflowSteps).mockResolvedValue([
      { name: 'submitted', isInitial: true,  isTerminal: false, isOpen: true,  category: null,      stepOrder: 1 },
      { name: 'rejected',  isInitial: false, isTerminal: true,  isOpen: false, category: 'rejected', stepOrder: 2 },
      { name: 'done',      isInitial: false, isTerminal: true,  isOpen: false, category: 'closed',   stepOrder: 3 },
    ])
    await completeRequest('sr-1', ctx)
    expect(vi.mocked(workflowEngine.transition).mock.calls[0]![1]).toMatchObject({ toStepName: 'done' })
  })

  it('transizione rifiutata dall\'engine → errore con lo step corrente, nessun completed_at né evento', async () => {
    vi.mocked(workflowEngine.transition).mockResolvedValue({ success: false, error: 'guard fallita' } as never)
    await expect(completeRequest('sr-1', ctx)).rejects.toThrow('Impossibile evadere la richiesta dallo step "submitted": guard fallita')
    expect(queriesWith('SET r.completed_at')).toHaveLength(0)
    expect(publishEvent).not.toHaveBeenCalled()
  })
})

// ── mapRequest ────────────────────────────────────────────────────────────────

describe('mapRequest', () => {
  it('espone catalogItemId/requiresApproval (la copia del resolver li perdeva) con default null/false', () => {
    expect(mapRequest({ id: 'r', tenant_id: 't', title: 'T', status: 's', priority: 'p', created_at: 'c', updated_at: 'u' }))
      .toEqual({ id: 'r', number: '', tenantId: 't', title: 'T', description: undefined, status: 's', priority: 'p', dueDate: undefined,
        completedAt: undefined, catalogItemId: null, requiresApproval: false, createdAt: 'c', updatedAt: 'u', requestedBy: null, assignee: null })
    expect(mapRequest({ catalog_item_id: 'cat', requires_approval: true, number: 'REQ00000001' }))
      .toMatchObject({ catalogItemId: 'cat', requiresApproval: true, number: 'REQ00000001' })
  })
})
