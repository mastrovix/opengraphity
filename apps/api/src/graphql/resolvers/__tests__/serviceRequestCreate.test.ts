/**
 * createServiceRequest (resolver) — guardie a monte di requestService.createRequest:
 *  - campi obbligatori (FieldRequirementRule del tenant) mancanti → VALIDATION_ERROR;
 *  - catalogItemId inesistente o di un altro tenant → NotFoundError (NOT_FOUND);
 *  - requiresApproval ereditato dall'item di catalogo, mai dall'input del client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'

const h = vi.hoisted(() => ({
  session: { executeRead: vi.fn(), executeWrite: vi.fn(), close: vi.fn() },
}))

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(h.session)),
}))
vi.mock('../../../services/requestService.js', () => ({
  createRequest: vi.fn(),
  mapRequest:    vi.fn((p: Record<string, unknown>) => p),
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))

const { serviceRequestResolvers } = await import('../service_request.js')
const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { createRequest } = await import('../../../services/requestService.js')

const createServiceRequest = serviceRequestResolvers.Mutation.createServiceRequest
const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'u@test.io', role: 'operator' }

const rule = (field_name: string, workflow_step: string | null = null) =>
  ({ r: { properties: { field_name, required: true, workflow_step } } })

async function failure(promise: Promise<unknown>): Promise<GraphQLError> {
  const err = await promise.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(GraphQLError)
  return err as GraphQLError
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runQuery).mockResolvedValue([])          // nessuna FieldRequirementRule
  vi.mocked(runQueryOne).mockResolvedValue(null)
  vi.mocked(createRequest).mockResolvedValue({ id: 'sr-1', title: 'T' } as never)
})

describe('createServiceRequest — campi obbligatori del tenant', () => {
  it('campo obbligatorio mancante o vuoto → VALIDATION_ERROR con l\'elenco dei campi; nessuna creazione', async () => {
    vi.mocked(runQuery).mockResolvedValue([rule('description'), rule('dueDate'), rule('title')])
    const err = await failure(createServiceRequest(undefined, { input: { title: 'T', priority: 'low', description: '  ' } }, ctx))
    expect(err.extensions['code']).toBe('VALIDATION_ERROR')
    expect(err.extensions['fields']).toEqual(['description', 'dueDate'])
    expect(err.message).toBe('Il campo "description" è obbligatorio; Il campo "dueDate" è obbligatorio')
    expect(createRequest).not.toHaveBeenCalled()
    // le regole sono lette per il tenant e l'entità corrente
    expect(vi.mocked(runQuery).mock.calls[0]![2]).toEqual({ tenantId: 'tenant-1', entityType: 'service_request' })
  })

  it('regole legate a uno step di workflow non si applicano alla creazione', async () => {
    vi.mocked(runQuery).mockResolvedValue([rule('description', 'fulfilled')])
    await createServiceRequest(undefined, { input: { title: 'T', priority: 'low' } }, ctx)
    expect(createRequest).toHaveBeenCalledTimes(1)
  })
})

describe('createServiceRequest — item di catalogo', () => {
  it('catalogItemId inesistente (o di un altro tenant) → NotFoundError, nessuna creazione', async () => {
    const err = await failure(createServiceRequest(undefined, { input: { title: 'T', priority: 'low', catalogItemId: 'cat-404' } }, ctx))
    expect(err.extensions['code']).toBe('NOT_FOUND')
    expect(err.message).toBe('ServiceCatalogItem cat-404 not found')
    expect(createRequest).not.toHaveBeenCalled()
    // il lookup è tenant-scoped: un item di un altro tenant non viene trovato
    const [, cypher, params] = vi.mocked(runQueryOne).mock.calls[0]!
    expect(cypher).toContain('MATCH (ci:ServiceCatalogItem {id: $id, tenant_id: $tenantId})')
    expect(params).toEqual({ id: 'cat-404', tenantId: 'tenant-1' })
  })

  it('item trovato → requiresApproval ereditato dal catalogo (true), passato al service con l\'input', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ requiresApproval: true })
    const result = await createServiceRequest(undefined, { input: { title: 'VPN', priority: 'high', catalogItemId: 'cat-1' } }, ctx)
    expect(createRequest).toHaveBeenCalledWith({ title: 'VPN', priority: 'high', catalogItemId: 'cat-1', requiresApproval: true }, ctx)
    expect(result).toEqual({ id: 'sr-1', title: 'T' })
  })

  it('item senza requires_approval → false; senza catalogItemId nessun lookup e requiresApproval=false', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ requiresApproval: null })
    await createServiceRequest(undefined, { input: { title: 'T', priority: 'low', catalogItemId: 'cat-2' } }, ctx)
    expect(vi.mocked(createRequest).mock.calls[0]![0]).toMatchObject({ requiresApproval: false })

    vi.clearAllMocks()
    await createServiceRequest(undefined, { input: { title: 'T', priority: 'low' } }, ctx)
    expect(runQueryOne).not.toHaveBeenCalled()
    expect(vi.mocked(createRequest).mock.calls[0]![0]).toEqual({ title: 'T', priority: 'low', requiresApproval: false })
  })
})
