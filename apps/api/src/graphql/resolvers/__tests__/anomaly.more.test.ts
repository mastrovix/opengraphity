/**
 * anomaly.ts — the read side of the Anomalies page and the rule settings.
 *
 * Why these behaviours matter (anomaly.test.ts already pins resolveAnomaly's
 * validation and runAnomalyScanner's permission):
 *  - every query is scoped to the caller's tenant: an anomaly names CIs and
 *    owners, so a leak across tenants exposes another customer's topology;
 *  - the sort column comes from a whitelist and never from the client string,
 *    otherwise `sortField` would be Cypher injection;
 *  - the stat tiles are cached for a few seconds per tenant, and the cache key
 *    must not let one tenant read another's counts;
 *  - a rule whose saved settings no longer fit the metamodel is shown with the
 *    reason (i18n key + params), not silently hidden;
 *  - `description_params` that are not a map fail loud instead of rendering a
 *    half-translated sentence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'
import type { AnomalyRuleConfig, AnomalyRuleOptions } from '../../../anomaly/ruleConfig.js'

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(),
  toNumber: (v: unknown) => (v == null ? 0 : Number(v)),
}))
vi.mock('../../../anomaly/anomalyEngine.js', () => ({ enqueueTenantScan: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../anomaly/ruleConfig.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../anomaly/ruleConfig.js')>()
  return {
    ...actual,
    loadAnomalyRuleConfigs: vi.fn(),
    anomalyRuleOptions: vi.fn(),
    saveAnomalyRuleConfig: vi.fn(),
    // Real validation by default; a test swaps in a key-less error once.
    anomalyRuleProblem: vi.fn(actual.anomalyRuleProblem),
  }
})

const { anomalyResolvers } = await import('../anomaly.js')
const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const ruleConfig = await import('../../../anomaly/ruleConfig.js')
const { audit } = await import('../../../lib/audit.js')
const { cache } = await import('../../../lib/cache.js')
const { ValidationError } = await import('../../../lib/errors.js')

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'op-1', userEmail: 'op@test.io', role: 'operator', permissions: perms('operator') }
const otherTenant: GraphQLContext = { ...ctx, tenantId: 'tenant-2' }

const session = { close: vi.fn().mockResolvedValue(undefined) }

const OPTIONS: AnomalyRuleOptions = {
  ciTypes: [{ name: 'server', label: 'Server', neo4jLabel: 'Server' }, { name: 'application', label: 'App', neo4jLabel: 'Application' }],
  relations: ['DEPENDS_ON'],
  incidentSeverities: ['critical'],
}

function config(over: Partial<AnomalyRuleConfig> = {}): AnomalyRuleConfig {
  return {
    ruleKey: 'orphan_ci', enabled: true, severity: 'medium', ciTypes: [], relations: [], threshold: null,
    incidentSeverities: [], forbidden: [], isDefault: true, updatedAt: null, ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  cache.clear()
  vi.mocked(getSession).mockReturnValue(session as never)
  vi.mocked(ruleConfig.anomalyRuleOptions).mockResolvedValue(OPTIONS)
})

describe('Anomaly.resolvedByName', () => {
  it('no resolver id → null without touching the database', async () => {
    await expect(anomalyResolvers.Anomaly.resolvedByName({ resolvedBy: null }, null, ctx)).resolves.toBeNull()
    expect(getSession).not.toHaveBeenCalled()
  })

  it('reads the name inside the caller tenant only', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ name: 'Ada' } as never)
    await expect(anomalyResolvers.Anomaly.resolvedByName({ resolvedBy: 'u-9' }, null, ctx)).resolves.toBe('Ada')
    const [, cypher, params] = vi.mocked(runQueryOne).mock.calls[0]!
    expect(cypher).toContain('{id: $id, tenant_id: $tenantId}')
    expect(params).toEqual({ id: 'u-9', tenantId: 'tenant-1' })
    expect(session.close).toHaveBeenCalledOnce()
  })

  it('a removed user shows as empty, never as the raw id', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(null as never)
    await expect(anomalyResolvers.Anomaly.resolvedByName({ resolvedBy: 'u-gone' }, null, ctx)).resolves.toBeNull()
    vi.mocked(runQueryOne).mockResolvedValueOnce({ name: null } as never)
    await expect(anomalyResolvers.Anomaly.resolvedByName({ resolvedBy: 'u-gone' }, null, ctx)).resolves.toBeNull()
  })
})

describe('Query.anomalyRules', () => {
  it('returns every rule with its spec, open count and — when broken — the reason', async () => {
    vi.mocked(ruleConfig.loadAnomalyRuleConfigs).mockResolvedValueOnce([
      config(),
      // "database" was removed from the metamodel after the rule was saved.
      config({ ruleKey: 'spof', severity: 'critical', ciTypes: ['database'], relations: ['DEPENDS_ON'], threshold: 5, isDefault: false, updatedAt: '2026-09-01' }),
    ])
    vi.mocked(runQuery).mockResolvedValueOnce([{ ruleKey: 'spof', n: 3 }] as never)

    const out = await anomalyResolvers.Query.anomalyRules(null, null, ctx)

    expect(ruleConfig.loadAnomalyRuleConfigs).toHaveBeenCalledWith('tenant-1')
    const [, countCypher, countParams] = vi.mocked(runQuery).mock.calls[0]!
    expect(countCypher).toContain("MATCH (a:Anomaly {tenant_id: $tenantId, status: 'open'})")
    expect(countParams).toEqual({ tenantId: 'tenant-1' })

    expect(out[0]).toMatchObject({
      ruleKey: 'orphan_ci', openCount: 0, problem: null,
      spec: { ciTypes: true, relations: false, thresholdMin: null, thresholdMax: null },
    })
    expect(out[1]).toMatchObject({
      ruleKey: 'spof', openCount: 3, isDefault: false, updatedAt: '2026-09-01',
      spec: { thresholdMin: 1, thresholdMax: 1000 },
    })
    // The UI translates the reason: key + params must survive, params as strings.
    expect(out[1]!.problem).toMatchObject({ key: expect.stringContaining('unknownCIType'), params: expect.arrayContaining([{ key: 'value', value: 'database' }]) })
    expect(out[1]!.problem!.message).toContain('"database" is not a CI type')
  })

  it('D49: the spec says when no relation chosen means every relation — the page reads it, it does not mirror it', async () => {
    vi.mocked(ruleConfig.loadAnomalyRuleConfigs).mockResolvedValueOnce([config({ ruleKey: 'isolated_cluster' }), config({ ruleKey: 'spof' })])
    vi.mocked(runQuery).mockResolvedValueOnce([] as never)
    const out = await anomalyResolvers.Query.anomalyRules(null, null, ctx)
    expect(out.map((r) => [r.ruleKey, r.spec.allRelationsWhenEmpty])).toEqual([['isolated_cluster', true], ['spof', false]])
  })

  it('a problem without an i18n key falls back to the generic one', async () => {
    vi.mocked(ruleConfig.loadAnomalyRuleConfigs).mockResolvedValueOnce([config()])
    vi.mocked(runQuery).mockResolvedValueOnce([] as never)
    vi.mocked(ruleConfig.anomalyRuleProblem).mockReturnValueOnce(new ValidationError('something off'))
    const [rule] = await anomalyResolvers.Query.anomalyRules(null, null, ctx)
    expect(rule!.problem).toEqual({ key: 'errors.anomalyRule.invalid', params: [], message: 'something off' })
  })
})

describe('Query.anomalyRuleOptions', () => {
  it('returns the tenant metamodel choices plus the product severity scale', async () => {
    const out = await anomalyResolvers.Query.anomalyRuleOptions(null, null, ctx)
    expect(ruleConfig.anomalyRuleOptions).toHaveBeenCalledWith('tenant-1')
    expect(out).toEqual({ ...OPTIONS, severities: ['low', 'medium', 'high', 'critical'] })
  })
})

describe('Query.anomalies', () => {
  const PROPS = {
    id: 'an-1', rule_key: 'spof', title: 'SPOF', severity: 'critical', status: 'open', entity_id: 'ci-1',
    entity_type: 'ci', entity_subtype: 'server', entity_name: 'srv-01', description: 'd',
    description_params: '{"count":5,"relation":"DEPENDS_ON"}', detected_at: { toString: () => '2026-09-01T00:00:00Z' }, tenant_id: 'tenant-1',
  }

  it('defaults: tenant-scoped, newest first, 50 per page, and maps the row', async () => {
    vi.mocked(runQuery)
      .mockResolvedValueOnce([{ props: PROPS }] as never)
      .mockResolvedValueOnce([{ total: 7 }] as never)

    const out = await anomalyResolvers.Query.anomalies(null, {}, ctx)

    const [, pageCypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(pageCypher).toContain('WHERE a.tenant_id = $tenantId')
    expect(pageCypher).toContain('ORDER BY a.detected_at DESC')
    expect(params).toEqual({ tenantId: 'tenant-1', offset: 0, limit: 50 })
    // The count must use the same WHERE, or the pager lies.
    expect(vi.mocked(runQuery).mock.calls[1]![1]).toContain('WHERE a.tenant_id = $tenantId')
    expect(out.total).toBe(7)
    expect(out.items[0]).toEqual({
      id: 'an-1', ruleKey: 'spof', title: 'SPOF', severity: 'critical', status: 'open', entityId: 'ci-1',
      entityType: 'ci', entitySubtype: 'server', entityName: 'srv-01', description: 'd',
      descriptionParams: [{ key: 'count', value: '5' }, { key: 'relation', value: 'DEPENDS_ON' }],
      // Neo4j DateTime objects arrive as objects: they must become strings.
      detectedAt: '2026-09-01T00:00:00Z',
      resolvedAt: null, resolutionStatus: null, resolutionNote: null, resolvedBy: null, resolvedByName: null,
      resolvedReason: null, tenantId: 'tenant-1',
    })
    expect(session.close).toHaveBeenCalledOnce()
  })

  it('whitelisted sort field maps to the stored column; direction only ASC or DESC', async () => {
    vi.mocked(runQuery).mockResolvedValue([] as never)
    await anomalyResolvers.Query.anomalies(null, { sortField: 'entityName', sortDirection: 'asc', limit: 10, offset: 20 }, ctx)
    expect(vi.mocked(runQuery).mock.calls[0]![1]).toContain('ORDER BY a.entity_name ASC')
    expect(vi.mocked(runQuery).mock.calls[0]![2]).toMatchObject({ offset: 20, limit: 10 })

    vi.mocked(runQuery).mockClear()
    // Anything but "asc" is DESC: the direction string never reaches Cypher.
    await anomalyResolvers.Query.anomalies(null, { sortField: 'title', sortDirection: 'asc; DROP' }, ctx)
    expect(vi.mocked(runQuery).mock.calls[0]![1]).toContain('ORDER BY a.title DESC')
  })

  it('an unknown sort field is ignored, never interpolated', async () => {
    vi.mocked(runQuery).mockResolvedValue([] as never)
    const out = await anomalyResolvers.Query.anomalies(null, { sortField: 'x) DETACH DELETE a //' }, ctx)
    const cypher = vi.mocked(runQuery).mock.calls[0]![1]
    expect(cypher).toContain('ORDER BY a.detected_at DESC')
    expect(cypher).not.toContain('DETACH')
    // No count row at all → total 0, not NaN.
    expect(out).toEqual({ items: [], total: 0 })
  })

  it('advanced filters are ANDed after the tenant condition', async () => {
    vi.mocked(runQuery).mockResolvedValue([] as never)
    const filters = JSON.stringify({ operator: 'AND', rules: [{ field: 'severity', operator: 'equals', value: 'high' }] })
    await anomalyResolvers.Query.anomalies(null, { filters }, ctx)
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toMatch(/WHERE a\.tenant_id = \$tenantId AND \(.*a\.severity.*\)/)
    expect(params).toMatchObject({ tenantId: 'tenant-1', af_0: 'high' })
  })

  it('a filter on a field outside the whitelist fails loud and still closes the session', async () => {
    const filters = JSON.stringify({ operator: 'AND', rules: [{ field: 'tenant_id', operator: 'equals', value: 'tenant-2' }] })
    await expect(anomalyResolvers.Query.anomalies(null, { filters }, ctx)).rejects.toThrow(/not allowed/)
    expect(session.close).toHaveBeenCalledOnce()
  })

  it('an empty filter group adds no condition', async () => {
    vi.mocked(runQuery).mockResolvedValue([] as never)
    await anomalyResolvers.Query.anomalies(null, { filters: JSON.stringify({ operator: 'AND', rules: [] }) }, ctx)
    expect(vi.mocked(runQuery).mock.calls[0]![1]).toMatch(/WHERE a\.tenant_id = \$tenantId\s+WITH a/)
  })

  it('description_params already a map is accepted; a non-map fails loud with the anomaly id', async () => {
    vi.mocked(runQuery)
      .mockResolvedValueOnce([{ props: { ...PROPS, description_params: { n: 2 } } }] as never)
      .mockResolvedValueOnce([{ total: 1 }] as never)
    const out = await anomalyResolvers.Query.anomalies(null, {}, ctx)
    expect(out.items[0]!.descriptionParams).toEqual([{ key: 'n', value: '2' }])

    vi.mocked(runQuery).mockResolvedValueOnce([{ props: { ...PROPS, description_params: '[1,2]' } }] as never)
    await expect(anomalyResolvers.Query.anomalies(null, {}, ctx)).rejects.toThrow('Anomaly an-1: description_params is not a map')
  })
})

describe('Query.anomaly', () => {
  it('reads by id inside the tenant and maps resolution fields', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ props: {
      id: 'an-2', status: 'resolved', resolved_at: '2026-09-02', resolution_status: 'resolved',
      resolution_note: 'fixed', resolved_by: 'op-1', resolved_reason: 'auto', tenant_id: 'tenant-1',
    } } as never)
    const out = await anomalyResolvers.Query.anomaly(null, { id: 'an-2' }, ctx)
    const [, cypher, params] = vi.mocked(runQueryOne).mock.calls[0]!
    expect(cypher).toContain('MATCH (a:Anomaly {id: $id, tenant_id: $tenantId})')
    expect(params).toEqual({ id: 'an-2', tenantId: 'tenant-1' })
    // Pre-2026 anomalies have no params: they keep their historical sentence.
    expect(out).toMatchObject({
      id: 'an-2', title: '', descriptionParams: null, resolvedAt: '2026-09-02', resolutionStatus: 'resolved',
      resolutionNote: 'fixed', resolvedBy: 'op-1', resolvedReason: 'auto',
    })
  })

  it('another tenant\'s anomaly → null', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(null as never)
    await expect(anomalyResolvers.Query.anomaly(null, { id: 'an-x' }, otherTenant)).resolves.toBeNull()
    expect(session.close).toHaveBeenCalledOnce()
  })
})

describe('Query.anomalyScanStatus', () => {
  it('reports the last scan of the caller tenant', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ lastScanAt: '2026-09-22T10:00:00Z', totalScans: 12 } as never)
    await expect(anomalyResolvers.Query.anomalyScanStatus(null, null, ctx)).resolves.toEqual({ lastScanAt: '2026-09-22T10:00:00Z', totalScans: 12 })
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toEqual({ tenantId: 'tenant-1' })
  })

  it('never scanned (no config node, or an empty date) → null date and zero scans', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(null as never)
    await expect(anomalyResolvers.Query.anomalyScanStatus(null, null, ctx)).resolves.toEqual({ lastScanAt: null, totalScans: 0 })
    vi.mocked(runQueryOne).mockResolvedValueOnce({ lastScanAt: null, totalScans: null } as never)
    await expect(anomalyResolvers.Query.anomalyScanStatus(null, null, ctx)).resolves.toEqual({ lastScanAt: null, totalScans: 0 })
  })
})

describe('Query.anomalyStats', () => {
  const ROW = { total: 10, open: 6, falsePositive: 1, acceptedRisk: 2, critical: 1, high: 2, medium: 2, low: 1 }

  it('counts per tenant and serves the second call from the cache', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(ROW as never)
    const first = await anomalyResolvers.Query.anomalyStats(null, null, ctx)
    expect(first).toEqual(ROW)
    expect(vi.mocked(runQueryOne).mock.calls[0]![1]).toContain('MATCH (a:Anomaly {tenant_id: $tenantId})')
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toEqual({ tenantId: 'tenant-1' })

    const second = await anomalyResolvers.Query.anomalyStats(null, null, ctx)
    expect(second).toEqual(ROW)
    expect(runQueryOne).toHaveBeenCalledTimes(1)
  })

  it('the cache is per tenant: another tenant never sees these counts', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(ROW as never)
    await anomalyResolvers.Query.anomalyStats(null, null, ctx)
    vi.mocked(runQueryOne).mockResolvedValueOnce({ ...ROW, total: 0, open: 0 } as never)
    const other = await anomalyResolvers.Query.anomalyStats(null, null, otherTenant)
    expect(other).toMatchObject({ total: 0, open: 0 })
    expect(vi.mocked(runQueryOne).mock.calls[1]![2]).toEqual({ tenantId: 'tenant-2' })
  })

  it('no row → all zeros (and nothing cached, so the next call asks again)', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(null as never)
    await expect(anomalyResolvers.Query.anomalyStats(null, null, ctx)).resolves.toEqual({
      total: 0, open: 0, critical: 0, high: 0, medium: 0, low: 0, falsePositive: 0, acceptedRisk: 0,
    })
    vi.mocked(runQueryOne).mockResolvedValueOnce(ROW as never)
    await expect(anomalyResolvers.Query.anomalyStats(null, null, ctx)).resolves.toEqual(ROW)
  })
})

describe('Mutation.updateAnomalyRule', () => {
  it('saves for the caller tenant and audits the before/after settings without bookkeeping fields', async () => {
    vi.mocked(ruleConfig.loadAnomalyRuleConfigs).mockResolvedValueOnce([config(), config({ ruleKey: 'missing_owner', severity: 'low' })])
    const saved = config({ ruleKey: 'missing_owner', severity: 'high', isDefault: false, updatedAt: '2026-09-22' })
    vi.mocked(ruleConfig.saveAnomalyRuleConfig).mockResolvedValueOnce(saved)
    vi.mocked(runQuery).mockResolvedValueOnce([{ ruleKey: 'missing_owner', n: 4 }] as never)

    const settings = { enabled: true, severity: 'high' }
    const out = await anomalyResolvers.Mutation.updateAnomalyRule(null, { ruleKey: 'missing_owner', settings }, ctx)

    expect(ruleConfig.saveAnomalyRuleConfig).toHaveBeenCalledWith('tenant-1', 'missing_owner', settings)
    const [, action, entity, id, detail] = vi.mocked(audit).mock.calls[0]!
    expect([action, entity, id]).toEqual(['anomaly.rule_updated', 'AnomalyRuleConfig', 'missing_owner'])
    const { from, to } = detail as { from: Record<string, unknown>; to: Record<string, unknown> }
    expect(from).toMatchObject({ ruleKey: 'missing_owner', severity: 'low' })
    expect(to).toMatchObject({ ruleKey: 'missing_owner', severity: 'high' })
    for (const side of [from, to]) {
      expect(side).not.toHaveProperty('isDefault')
      expect(side).not.toHaveProperty('updatedAt')
    }
    expect(out).toMatchObject({ ruleKey: 'missing_owner', severity: 'high', openCount: 4, problem: null, isDefault: false })
  })

  it('an unknown previous config audits an empty "from" and a zero open count', async () => {
    vi.mocked(ruleConfig.loadAnomalyRuleConfigs).mockResolvedValueOnce([])
    vi.mocked(ruleConfig.saveAnomalyRuleConfig).mockResolvedValueOnce(config())
    vi.mocked(runQuery).mockResolvedValueOnce([] as never)
    const out = await anomalyResolvers.Mutation.updateAnomalyRule(null, { ruleKey: 'orphan_ci', settings: {} }, ctx)
    expect((vi.mocked(audit).mock.calls[0]![4] as { from: unknown }).from).toEqual({})
    expect(out.openCount).toBe(0)
  })

  it('a rejected save propagates and audits nothing', async () => {
    vi.mocked(ruleConfig.loadAnomalyRuleConfigs).mockResolvedValueOnce([])
    vi.mocked(ruleConfig.saveAnomalyRuleConfig).mockRejectedValueOnce(new ValidationError('bad'))
    await expect(anomalyResolvers.Mutation.updateAnomalyRule(null, { ruleKey: 'orphan_ci', settings: {} }, ctx)).rejects.toThrow('bad')
    expect(audit).not.toHaveBeenCalled()
  })
})

describe('Mutation.resolveAnomaly without a user', () => {
  it('stores resolved_by as null instead of the string "unknown"', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ props: { id: 'an-1', status: 'resolved', tenant_id: 'tenant-1' } } as never)
    await anomalyResolvers.Mutation.resolveAnomaly(null, { id: 'an-1', resolutionStatus: 'resolved', note: 'long enough note' }, { ...ctx, userId: '' })
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toMatchObject({ resolvedBy: null })
  })
})
