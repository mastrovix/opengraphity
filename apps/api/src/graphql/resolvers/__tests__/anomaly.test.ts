/**
 * anomaly.ts — resolveAnomaly: resolutionStatus fuori enum → ValidationError
 * PRIMA di aprire la sessione; valido → SET scoped per tenant con resolved_by
 * dal contesto; NotFound fuori tenant; runAnomalyScanner solo admin/operator
 * e sempre sul tenant del chiamante. (Non esiste `updateAnomaly` nel resolver.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(),
  toNumber: (v: unknown) => (v == null ? 0 : Number(v)),
}))
vi.mock('../../../anomaly/anomalyEngine.js', () => ({ enqueueTenantScan: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))

const { anomalyResolvers, assertResolutionStatus, RESOLUTION_STATUSES } = await import('../anomaly.js')
const { getSession, runQueryOne } = await import('@opengraphity/neo4j')
const { enqueueTenantScan } = await import('../../../anomaly/anomalyEngine.js')
const { cache } = await import('../../../lib/cache.js')

const operator: GraphQLContext = { tenantId: 'tenant-1', userId: 'op-1', userEmail: 'op@test.io', role: 'operator' }
const viewer:   GraphQLContext = { ...operator, role: 'viewer' }

const session = { close: vi.fn().mockResolvedValue(undefined) }
const NOTE = 'Falso positivo: host dismesso a luglio'

async function expectCode(p: Promise<unknown>, code: string, pattern?: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(GraphQLError)
  expect((err as GraphQLError).extensions['code']).toBe(code)
  if (pattern) expect((err as GraphQLError).message).toMatch(pattern)
}

describe('assertResolutionStatus', () => {
  it('accetta esattamente i tre stati dell\'enum', () => {
    expect([...RESOLUTION_STATUSES]).toEqual(['resolved', 'false_positive', 'accepted_risk'])
    for (const s of RESOLUTION_STATUSES) expect(assertResolutionStatus(s)).toBe(s)
  })

  it.each(['wontfix', 'RESOLVED', '', null, undefined, 42])('%s → ValidationError', (v) => {
    const err = (() => { try { assertResolutionStatus(v); return null } catch (e) { return e as GraphQLError } })()
    expect(err?.extensions['code']).toBe('BAD_USER_INPUT')
    expect(err?.message).toMatch(/Invalid resolutionStatus/)
  })
})

describe('resolveAnomaly', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getSession).mockReturnValue(session as never)
  })

  it('resolutionStatus fuori enum → ValidationError, nessuna sessione aperta', async () => {
    await expectCode(anomalyResolvers.Mutation.resolveAnomaly(null, { id: 'an-1', resolutionStatus: 'ignored', note: NOTE }, operator), 'BAD_USER_INPUT', /Invalid resolutionStatus "ignored"/)
    expect(getSession).not.toHaveBeenCalled()
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('nota troppo corta → ValidationError prima della sessione', async () => {
    await expectCode(anomalyResolvers.Mutation.resolveAnomaly(null, { id: 'an-1', resolutionStatus: 'resolved', note: 'ok' }, operator), 'BAD_USER_INPUT', /note must be at least 10/)
    expect(getSession).not.toHaveBeenCalled()
  })

  it.each([...RESOLUTION_STATUSES])('%s → SET scoped per tenant con resolved_by dal contesto, cache stats invalidata', async (status) => {
    cache.set('anomaly-stats:tenant-1', { total: 1 }, 60)
    vi.mocked(runQueryOne).mockResolvedValueOnce({ props: {
      id: 'an-1', rule_key: 'orphan_ci', title: 'CI orfano', severity: 'low', status, entity_id: 'ci-1', entity_type: 'server',
      detected_at: 'd', resolved_at: 'r', resolution_status: status, resolution_note: NOTE, resolved_by: 'op-1', tenant_id: 'tenant-1',
    } } as never)

    const out = await anomalyResolvers.Mutation.resolveAnomaly(null, { id: 'an-1', resolutionStatus: status, note: NOTE }, operator)

    const [, cypher, params] = vi.mocked(runQueryOne).mock.calls[0]!
    expect(cypher).toContain('MATCH (a:Anomaly {id: $id, tenant_id: $tenantId})')
    expect(cypher).toContain('SET a.status            = $resolutionStatus')
    expect(cypher).toContain('a.resolution_status = $resolutionStatus')
    expect(params).toMatchObject({ id: 'an-1', tenantId: 'tenant-1', resolutionStatus: status, note: NOTE, resolvedBy: 'op-1' })
    expect(out).toMatchObject({ id: 'an-1', status, resolutionStatus: status, resolvedBy: 'op-1', tenantId: 'tenant-1' })
    expect(cache.get('anomaly-stats:tenant-1')).toBeNull()
    expect(session.close).toHaveBeenCalledOnce()
  })

  it('anomalia di un altro tenant → NotFoundError, sessione chiusa', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(null as never)
    await expectCode(anomalyResolvers.Mutation.resolveAnomaly(null, { id: 'an-altrui', resolutionStatus: 'resolved', note: NOTE }, operator), 'NOT_FOUND')
    expect(session.close).toHaveBeenCalledOnce()
  })
})

describe('runAnomalyScanner', () => {
  beforeEach(() => vi.clearAllMocks())

  it('viewer → ForbiddenError, nessun job accodato', async () => {
    await expectCode(anomalyResolvers.Mutation.runAnomalyScanner(null, null, viewer), 'FORBIDDEN')
    expect(enqueueTenantScan).not.toHaveBeenCalled()
  })

  it('operator → accoda la scansione SOLO del proprio tenant', async () => {
    await expect(anomalyResolvers.Mutation.runAnomalyScanner(null, null, operator)).resolves.toBe(true)
    expect(enqueueTenantScan).toHaveBeenCalledWith('tenant-1')
  })

  it('coda non disponibile → l\'errore propaga (mai false silenzioso)', async () => {
    vi.mocked(enqueueTenantScan).mockRejectedValueOnce(new Error('redis down'))
    await expect(anomalyResolvers.Mutation.runAnomalyScanner(null, null, operator)).rejects.toThrow('redis down')
  })
})
