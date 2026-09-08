/**
 * A-09: the limiter keys on the REAL mutation root fields of the parsed
 * operation and on the verified tenant from the context — not on the
 * client-chosen operationName or on unverified JWT claims.
 */
import { describe, it, expect, vi } from 'vitest'
import { parse } from 'graphql'

vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}))

const { createGraphqlRateLimiterPlugin, RateLimitStore, rootFieldNames, RateLimitedError } = await import('../graphqlRateLimiter.js')

const LIMITS = { createIncident: 2, triggerSync: 1 }

/** Runs the plugin's didResolveOperation for a document + fake context. */
async function run(plugin: ReturnType<typeof createGraphqlRateLimiterPlugin>, query: string, ctx: { tenantId: string; userId: string }) {
  const document = parse(query)
  const operation = document.definitions.find(d => d.kind === 'OperationDefinition')
  const listeners = await plugin.requestDidStart!({ request: {}, contextValue: ctx } as never)
  return listeners!.didResolveOperation!({ operation, document, contextValue: ctx, request: { operationName: 'Whatever' } } as never)
}

describe('rootFieldNames', () => {
  it('estrae i nomi di campo dello schema, ignorando alias e attraversando i fragment', () => {
    const doc = parse(`
      mutation Foo { a: createIncident(input: {}) { id } b: createIncident(input: {}) { id } ...F ... on Mutation { triggerSync(id: "1") } }
      fragment F on Mutation { createChange(input: {}) { id } }
    `)
    const op = doc.definitions[0] as import('graphql').OperationDefinitionNode
    expect(rootFieldNames(op, doc.definitions)).toEqual(['createIncident', 'createIncident', 'createChange', 'triggerSync'])
  })
})

describe('graphqlRateLimiterPlugin', () => {
  it('limita per campo reale anche se operationName è diverso, e per tenant verificato', async () => {
    let t = 0
    const store = new RateLimitStore(LIMITS, () => t)
    const plugin = createGraphqlRateLimiterPlugin(store)
    const q = 'mutation CreateIncidentRenamed($i: CreateIncidentInput!) { createIncident(input: $i) { id } }'

    await expect(run(plugin, q, { tenantId: 'A', userId: 'u1' })).resolves.toBeUndefined()
    await expect(run(plugin, q, { tenantId: 'A', userId: 'u2' })).resolves.toBeUndefined()   // budget is per tenant, not per user
    await expect(run(plugin, q, { tenantId: 'A', userId: 'u1' })).rejects.toBeInstanceOf(RateLimitedError)
    // Another tenant has its own budget
    await expect(run(plugin, q, { tenantId: 'B', userId: 'u9' })).resolves.toBeUndefined()

    // Window reset
    t = 61_000
    await expect(run(plugin, q, { tenantId: 'A', userId: 'u1' })).resolves.toBeUndefined()
  })

  it("l'errore è RATE_LIMITED con http 429 e retry-after", async () => {
    const store = new RateLimitStore(LIMITS, () => 0)
    const plugin = createGraphqlRateLimiterPlugin(store)
    const q = 'mutation { triggerSync(id: "1") }'
    await run(plugin, q, { tenantId: 'A', userId: 'u' })
    let err: unknown
    try { await run(plugin, q, { tenantId: 'A', userId: 'u' }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(RateLimitedError)
    const ext = (err as RateLimitedError).extensions as Record<string, unknown>
    expect(ext['code']).toBe('RATE_LIMITED')
    expect(ext['field']).toBe('triggerSync')
    expect(ext['retryAfterSeconds']).toBe(60)
    expect((ext['http'] as { status: number }).status).toBe(429)
  })

  it('un alias ripetuto N volte nello stesso documento costa N', async () => {
    const store = new RateLimitStore(LIMITS, () => 0)
    const plugin = createGraphqlRateLimiterPlugin(store)
    const q = 'mutation { a: createIncident(input: {}) { id } b: createIncident(input: {}) { id } c: createIncident(input: {}) { id } }'
    await expect(run(plugin, q, { tenantId: 'A', userId: 'u' })).rejects.toBeInstanceOf(RateLimitedError)
  })

  it('ignora le query e le mutation senza limite', async () => {
    const store = new RateLimitStore(LIMITS, () => 0)
    const plugin = createGraphqlRateLimiterPlugin(store)
    for (let i = 0; i < 5; i++) {
      await expect(run(plugin, 'query { incidents { id } }', { tenantId: 'A', userId: 'u' })).resolves.toBeUndefined()
      await expect(run(plugin, 'mutation { deleteIncident(id: "1") }', { tenantId: 'A', userId: 'u' })).resolves.toBeUndefined()
    }
    expect(store.size).toBe(0)
  })

  it('tenantId mancante nel contesto è un errore di wiring, non un pass silenzioso', async () => {
    const plugin = createGraphqlRateLimiterPlugin(new RateLimitStore(LIMITS, () => 0))
    await expect(run(plugin, 'mutation { triggerSync(id: "1") }', { tenantId: '', userId: 'u' })).rejects.toThrow(/tenantId is missing/)
  })

  it('prune elimina i bucket scaduti', () => {
    let t = 0
    const store = new RateLimitStore(LIMITS, () => t)
    store.hit('A', 'createIncident')
    expect(store.size).toBe(1)
    t = 61_000
    store.prune()
    expect(store.size).toBe(0)
  })
})
