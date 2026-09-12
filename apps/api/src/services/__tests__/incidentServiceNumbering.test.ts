/**
 * incidentService.createIncident — complementa incidentService.test.ts (che
 * copre CI obbligatorio, evento, WI, tenant/severity nell'evento). Qui:
 *  - numero INC + 8 cifre dal contatore atomico per tenant (lib/sequence.ts,
 *    MERGE Counter kind "incident"), asserito sul parametro Cypher del CREATE;
 *  - priorità Impatto×Urgenza (lib/priority.ts) coerente nei due versi;
 *  - errori tipizzati: né impact+urgency né severity → ValidationError;
 *    title fuori range → ValidationError, prima di ogni scrittura.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Ondata 6 (A-9): le etichette dei CI vengono dal metamodello del tenant ────
// `LoadBalancer` è un tipo creato dal cliente: deve comparire nei predicati.
// Prima questi punti usavano la lista fissa di `lib/ciLabels.ts` e i CI di quel
// tipo non contavano, in silenzio.
vi.mock('../../lib/ciLabelsForTenant.js', () => ({
  ciLabelsForTenant:         vi.fn(async () => ['Application', 'LoadBalancer', 'Server']),
  ciLabelPredicateForTenant: vi.fn(async (alias: string) => `(${alias}:Application OR ${alias}:LoadBalancer OR ${alias}:Server)`),
  apocLabelFilterForTenant:  vi.fn(async () => '+Application|+LoadBalancer|+Server'),
  ciTypeNameForLabel:        vi.fn(async (_t: string, label: string) => (label === 'LoadBalancer' ? 'load_balancer' : null)),
  clearCILabelCache:         vi.fn(),
}))
import { GraphQLError } from 'graphql'

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
  workflowEngine: { createInstance: vi.fn().mockResolvedValue({ id: 'wi-1' }), transition: vi.fn(), getAvailableTransitions: vi.fn(), registerCondition: vi.fn() },
}))
vi.mock('../../graphql/resolvers/ci-utils.js', () => ({
  withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(h.session)),
  getSession:  vi.fn(),
}))
vi.mock('../../lib/triggerEngine.js', () => ({
  evaluateTriggers:      vi.fn().mockResolvedValue(undefined),
  scheduleTimerTriggers: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/rulesEngine.js', () => ({ evaluateBusinessRules: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/publishEvent.js', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../jobs/embeddingWorker.js', () => ({ enqueueEmbedding: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/workflowHelpers.js', () => ({
  getInitialStepName: vi.fn().mockResolvedValue('new'),
  getWorkflowSteps:   vi.fn().mockResolvedValue([]),
}))
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}))

const { createIncident } = await import('../incidentService.js')
const { runQuery } = await import('@opengraphity/neo4j')
const { publishEvent } = await import('../../lib/publishEvent.js')
const { derivePriority, impactUrgencyFromPriority } = await import('../../lib/priority.js')

const ctx = { tenantId: 'tenant-1', userId: 'user-1' }

const createParams = (): Record<string, unknown> => {
  const call = vi.mocked(runQuery).mock.calls.find(c => (c[1] as string).includes('CREATE (i:Incident'))
  if (!call) throw new Error('nessun CREATE (i:Incident) eseguito')
  return call[2] as Record<string, unknown>
}

async function validationFailure(promise: Promise<unknown>): Promise<GraphQLError> {
  const err = await promise.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(GraphQLError)
  expect((err as GraphQLError).extensions['code']).toBe('BAD_USER_INPUT')
  return err as GraphQLError
}

beforeEach(() => {
  vi.clearAllMocks()
  h.session.executeWrite.mockResolvedValue({ records: [{ get: () => 12 }] })
  vi.mocked(runQuery).mockImplementation(async (_s: unknown, cypher: string, params?: Record<string, unknown>) =>
    cypher.includes('CREATE (i:Incident')
      ? [{ props: { id: params?.['id'], number: params?.['number'], title: params?.['title'], severity: params?.['severity'],
          impact: params?.['impact'], urgency: params?.['urgency'], status: params?.['status'], tenant_id: params?.['tenantId'] } }]
      // Ondata 6 (C-2): il MERGE verso i CI impattati ritorna il conteggio e
      // `createIncident` lo legge (zero righe = incident annullato).
      : cypher.includes('MERGE (i)-[r:AFFECTED_BY]->(ci)')
        ? [{ linked: 1 }]
        : [])
})

describe('createIncident — numero progressivo', () => {
  it('INC + 8 cifre dal contatore atomico (MERGE Counter, kind "incident", tenant corrente)', async () => {
    const created = await createIncident({ title: 'DB down', severity: 'high', affectedCIIds: ['ci-1'] }, ctx)

    // contatore riservato via session.executeWrite prima del CREATE
    expect(h.session.executeWrite).toHaveBeenCalled()
    const tx = { run: vi.fn().mockResolvedValue({ records: [{ get: () => 12 }] }) }
    await (h.session.executeWrite.mock.calls[0]![0] as (t: typeof tx) => Promise<unknown>)(tx)
    expect(tx.run.mock.calls[0]![0]).toMatch(/MERGE \(c:Counter \{tenant_id: \$tenantId, kind: \$kind\}\)/)
    expect(tx.run.mock.calls[0]![0]).toMatch(/ON MATCH\s+SET c\.value = c\.value \+ 1/)
    expect(tx.run.mock.calls[0]![1]).toEqual({ tenantId: 'tenant-1', kind: 'incident' })

    expect(createParams()['number']).toBe('INC00000012')
    expect(createParams()['number']).toMatch(/^INC\d{8}$/)
    expect(created.number).toBe('INC00000012')
  })

  it('accetta Integer neo4j dal contatore e non tronca oltre 8 cifre', async () => {
    h.session.executeWrite.mockResolvedValue({ records: [{ get: () => ({ toNumber: () => 100000001 }) }] })
    await createIncident({ title: 'T', severity: 'low', affectedCIIds: ['ci-1'] }, ctx)
    expect(createParams()['number']).toBe('INC100000001')
  })
})

describe('createIncident — priorità Impatto×Urgenza', () => {
  it.each([
    ['high', 'high', 'critical'], ['high', 'low', 'medium'], ['medium', 'medium', 'medium'], ['low', 'high', 'medium'], ['low', 'low', 'low'],
  ] as const)('impact=%s urgency=%s → severity %s (una severity esplicita incoerente è ignorata)', async (impact, urgency, expected) => {
    await createIncident({ title: 'T', impact, urgency, severity: 'low', affectedCIIds: ['ci-1'] }, ctx)
    expect(createParams()).toMatchObject({ severity: expected, impact, urgency })
    expect(expected).toBe(derivePriority(impact, urgency))
  })

  it.each(['critical', 'high', 'medium', 'low'] as const)('solo severity=%s → impact/urgency retro-derivati coerenti', async (severity) => {
    await createIncident({ title: 'T', severity, affectedCIIds: ['ci-1'] }, ctx)
    const iu = impactUrgencyFromPriority(severity)
    expect(createParams()).toMatchObject({ severity, impact: iu.impact, urgency: iu.urgency })
    expect(derivePriority(iu.impact, iu.urgency)).toBe(severity)
  })

  it('l\'evento incident.created porta la priorità derivata, non la severity dell\'input', async () => {
    await createIncident({ title: 'T', impact: 'high', urgency: 'high', severity: 'low', affectedCIIds: ['ci-1'] }, ctx)
    expect(publishEvent).toHaveBeenCalledWith('incident.created', 'tenant-1', 'user-1',
      expect.objectContaining({ severity: 'critical', affected_ci_ids: ['ci-1'] }), expect.any(String))
  })
})

describe('createIncident — errori tipizzati (ValidationError / BAD_USER_INPUT)', () => {
  it('né impact+urgency né severity → ValidationError, nessuna scrittura', async () => {
    const err = await validationFailure(createIncident({ title: 'T', affectedCIIds: ['ci-1'] }, ctx))
    expect(err.message).toBe('Fornire impact+urgency oppure severity')
    expect(runQuery).not.toHaveBeenCalled()
    expect(h.session.executeWrite).not.toHaveBeenCalled()
  })

  it('impact valido senza urgency e senza severity → ValidationError (la coppia deve essere completa)', async () => {
    await validationFailure(createIncident({ title: 'T', impact: 'high', affectedCIIds: ['ci-1'] }, ctx))
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('title vuoto o oltre 500 caratteri → ValidationError prima del CI check e di ogni scrittura', async () => {
    const empty = await validationFailure(createIncident({ title: '', severity: 'high', affectedCIIds: ['ci-1'] }, ctx))
    expect(empty.message).toBe('title must be at least 1 characters')
    const long = await validationFailure(createIncident({ title: 'x'.repeat(501), severity: 'high', affectedCIIds: ['ci-1'] }, ctx))
    expect(long.message).toBe('title must be at most 500 characters')
    const desc = await validationFailure(createIncident({ title: 'T', description: 'd'.repeat(10001), severity: 'high', affectedCIIds: ['ci-1'] }, ctx))
    expect(desc.message).toBe('description must be at most 10000 characters')
    expect(runQuery).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('il CI mancante è un ValidationError (codice BAD_USER_INPUT), non un Error generico', async () => {
    const err = await validationFailure(createIncident({ title: 'T', severity: 'high' }, ctx))
    expect(err.message).toBe('Un incident deve avere almeno un CI impattato')
  })
})
