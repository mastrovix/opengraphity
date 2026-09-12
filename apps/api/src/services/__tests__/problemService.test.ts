/**
 * problemService.createProblem / publishProblemTransition — Neo4j, workflow,
 * eventi e automazioni mockati. Pinna: priorità ITIL Impatto×Urgenza
 * (lib/priority.ts) coerente in entrambe le direzioni, numero PRB + 8 cifre
 * dal contatore atomico (lib/sequence.ts), istanza di workflow, evento
 * problem.created con tenant/attore, link CREATED_BY / AFFECTS / CAUSED_BY,
 * errori (tipizzati o — dove il sorgente non lo fa — pinnati come BUG).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

const h = vi.hoisted(() => {
  const session = {
    executeRead:  vi.fn(),
    executeWrite: vi.fn(),
    close:        vi.fn(),
  }
  return { session }
})

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
vi.mock('../../lib/triggerEngine.js', () => ({
  evaluateTriggers:      vi.fn().mockResolvedValue(undefined),
  scheduleTimerTriggers: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/rulesEngine.js', () => ({ evaluateBusinessRules: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/publishEvent.js', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/workflowHelpers.js', () => ({
  getInitialStepName: vi.fn().mockResolvedValue('new'),
  getWorkflowSteps:   vi.fn().mockResolvedValue([]),
}))
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}))

const { createProblem, publishProblemTransition } = await import('../problemService.js')
const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { workflowEngine } = await import('@opengraphity/workflow')
const { publishEvent } = await import('../../lib/publishEvent.js')
const { evaluateTriggers } = await import('../../lib/triggerEngine.js')
const { derivePriority, impactUrgencyFromPriority } = await import('../../lib/priority.js')

const ctx = { tenantId: 'tenant-1', userId: 'user-1' }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

type Call = [string, Record<string, unknown>]
/** Chiamate runQuery (cypher, params) che contengono `needle`. */
const queriesWith = (needle: string): Call[] =>
  vi.mocked(runQuery).mock.calls
    .map(c => [c[1] as string, c[2] as Record<string, unknown>] as Call)
    .filter(([cypher]) => cypher.includes(needle))

beforeEach(() => {
  vi.clearAllMocks()
  // Contatore atomico (lib/sequence.ts) → session.executeWrite
  h.session.executeWrite.mockResolvedValue({ records: [{ get: () => 42 }] })
  vi.mocked(runQuery).mockImplementation(async (_s: unknown, cypher: string, params?: Record<string, unknown>) =>
    cypher.includes('CREATE (p:Problem')
      ? [{ props: { id: params?.['id'], number: params?.['number'], title: params?.['title'], priority: params?.['priority'],
          impact: params?.['impact'], urgency: params?.['urgency'], status: params?.['status'], tenant_id: params?.['tenantId'] } }]
      : [])
  vi.mocked(workflowEngine.createInstance).mockResolvedValue({ id: 'wi-1' } as never)
})

// ── Priorità ITIL ─────────────────────────────────────────────────────────────

describe('createProblem — priorità Impatto×Urgenza', () => {
  it.each([
    ['high',   'high',   'critical'],
    ['high',   'medium', 'high'],
    ['high',   'low',    'medium'],
    ['medium', 'high',   'high'],
    ['medium', 'medium', 'medium'],
    ['medium', 'low',    'low'],
    ['low',    'high',   'medium'],
    ['low',    'medium', 'low'],
    ['low',    'low',    'low'],
  ] as const)('impact=%s urgency=%s → priority %s (ignora una priority esplicita incoerente)', async (impact, urgency, expected) => {
    await createProblem({ title: 'P', impact, urgency, priority: 'low' }, ctx)
    const [[, params]] = queriesWith('CREATE (p:Problem')
    expect(params).toMatchObject({ priority: expected, impact, urgency })
    expect(params['priority']).toBe(derivePriority(impact, urgency))
  })

  it.each(['critical', 'high', 'medium', 'low'] as const)('solo priority=%s → impact/urgency retro-derivati e coerenti con la matrice', async (priority) => {
    await createProblem({ title: 'P', priority }, ctx)
    const [[, params]] = queriesWith('CREATE (p:Problem')
    const iu = impactUrgencyFromPriority(priority)
    expect(params).toMatchObject({ priority, impact: iu.impact, urgency: iu.urgency })
    // invariante: la coppia retro-derivata rimappa sulla stessa priorità
    expect(derivePriority(iu.impact, iu.urgency)).toBe(priority)
  })

  it('impact valido ma urgency assente → si usa priority esplicita e si completa solo il campo mancante', async () => {
    await createProblem({ title: 'P', impact: 'low', priority: 'critical' }, ctx)
    const [[, params]] = queriesWith('CREATE (p:Problem')
    expect(params).toMatchObject({ priority: 'critical', impact: 'low', urgency: 'high' })
  })

  it('senza impact+urgency né priority → errore esplicito, nessuna scrittura', async () => {
    await expect(createProblem({ title: 'P' }, ctx)).rejects.toThrow('Fornire impact+urgency oppure priority')
    expect(runQuery).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('senza priorità l\'errore è tipizzato (BAD_USER_INPUT) — BUG: problemService.ts:66 lancia un Error generico (incidentService usa ValidationError)', async () => {
    const err = await createProblem({ title: 'P' }, ctx).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).extensions['code']).toBe('BAD_USER_INPUT')
  })

  it('rifiuta un titolo vuoto — BUG: problemService.ts:55-67 non valida title (incidentService: validateStringLength 1..500)', async () => {
    await expect(createProblem({ title: '', priority: 'high' }, ctx)).rejects.toThrow()
  })
})

// ── Numero, workflow, evento, link ────────────────────────────────────────────

describe('createProblem — numero, workflow, evento e link', () => {
  it('numero PRB + 8 cifre dal contatore atomico (kind "problem", tenant corrente)', async () => {
    await createProblem({ title: 'Disco pieno', priority: 'high' }, ctx)
    // contatore: MERGE (c:Counter …) via session.executeWrite
    expect(h.session.executeWrite).toHaveBeenCalledTimes(1)
    const tx = { run: vi.fn().mockResolvedValue({ records: [{ get: () => 7 }] }) }
    await (h.session.executeWrite.mock.calls[0]![0] as (t: typeof tx) => Promise<unknown>)(tx)
    expect(tx.run.mock.calls[0]![0]).toMatch(/MERGE \(c:Counter \{tenant_id: \$tenantId, kind: \$kind\}\)/)
    expect(tx.run.mock.calls[0]![1]).toEqual({ tenantId: 'tenant-1', kind: 'problem' })

    const [[, params]] = queriesWith('CREATE (p:Problem')
    expect(params['number']).toBe('PRB00000042')
    expect(params['number']).toMatch(/^PRB\d{8}$/)
  })

  it('numeri grandi non vengono troncati (padStart non taglia)', async () => {
    h.session.executeWrite.mockResolvedValue({ records: [{ get: () => 123456789 }] })
    await createProblem({ title: 'P', priority: 'low' }, ctx)
    const [[, params]] = queriesWith('CREATE (p:Problem')
    expect(params['number']).toBe('PRB123456789')
  })

  it('scrive il nodo con id uuid v4, tenant, stato iniziale del workflow e restituisce le properties', async () => {
    const created = await createProblem({ title: 'Disco pieno', description: 'dettagli', priority: 'high', workaround: 'pulizia log' }, ctx)
    const [[, params]] = queriesWith('CREATE (p:Problem')
    expect(params).toMatchObject({
      tenantId: 'tenant-1', title: 'Disco pieno', description: 'dettagli', workaround: 'pulizia log', status: 'new',
    })
    expect(params['id']).toMatch(UUID_RE)
    expect(params['now']).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(created).toMatchObject({ id: params['id'], number: 'PRB00000042', title: 'Disco pieno', status: 'new', priority: 'high' })
  })

  it('collega l\'autore con CREATED_BY (prima il campo restava sempre null)', async () => {
    await createProblem({ title: 'P', priority: 'high' }, ctx)
    const [[cypher, params]] = queriesWith('MERGE (p)-[:CREATED_BY]->(u)')
    expect(cypher).toContain('MATCH (u:User {id: $userId, tenant_id: $tenantId})')
    expect(params).toMatchObject({ tenantId: 'tenant-1', userId: 'user-1' })
  })

  it('crea l\'istanza di workflow "problem" con la categoria (o null)', async () => {
    await createProblem({ title: 'P', priority: 'high', category: 'storage' }, ctx)
    expect(workflowEngine.createInstance).toHaveBeenCalledTimes(1)
    expect(workflowEngine.createInstance).toHaveBeenCalledWith(h.session, 'tenant-1', expect.stringMatching(UUID_RE), 'problem', undefined, 'storage')

    vi.clearAllMocks()
    await createProblem({ title: 'P', priority: 'high' }, ctx)
    expect(workflowEngine.createInstance).toHaveBeenCalledWith(h.session, 'tenant-1', expect.any(String), 'problem', undefined, null)
  })

  it('pubblica problem.created con tenant, attore e payload (priorità derivata, stato iniziale)', async () => {
    await createProblem({ title: 'Disco pieno', impact: 'high', urgency: 'high' }, ctx)
    expect(publishEvent).toHaveBeenCalledTimes(1)
    expect(publishEvent).toHaveBeenCalledWith('problem.created', 'tenant-1', 'user-1', {
      id: expect.stringMatching(UUID_RE), title: 'Disco pieno', priority: 'critical', status: 'new', assignedTo: '—',
    })
  })

  it('valuta trigger on_create con i dati dell\'entità (fire-and-forget)', async () => {
    await createProblem({ title: 'P', priority: 'medium', category: 'net' }, ctx)
    expect(evaluateTriggers).toHaveBeenCalledWith('tenant-1', 'problem', 'on_create',
      expect.objectContaining({ title: 'P', priority: 'medium', status: 'new', category: 'net' }), 'user-1')
  })

  it('affectedCIs → un MERGE AFFECTS per CI, tenant-scoped; relatedIncidents → CAUSED_BY', async () => {
    await createProblem({ title: 'P', priority: 'high', affectedCIs: ['ci-1', 'ci-2'], relatedIncidents: ['inc-9'] }, ctx)
    const affects = queriesWith('MERGE (p)-[:AFFECTS]->(ci)')
    expect(affects.map(([, p]) => p)).toEqual([
      { id: expect.any(String), tenantId: 'tenant-1', ciId: 'ci-1' },
      { id: expect.any(String), tenantId: 'tenant-1', ciId: 'ci-2' },
    ])
    expect(affects[0]![0]).toContain('MATCH (ci {id: $ciId, tenant_id: $tenantId})')
    const caused = queriesWith('MERGE (p)-[:CAUSED_BY]->(i)')
    expect(caused).toHaveLength(1)
    expect(caused[0]![1]).toMatchObject({ tenantId: 'tenant-1', incidentId: 'inc-9' })
    expect(caused[0]![0]).toContain('MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})')
  })

  it('senza CI/incident collegati non esegue query di link', async () => {
    await createProblem({ title: 'P', priority: 'high', affectedCIs: [], relatedIncidents: [] }, ctx)
    expect(queriesWith(':AFFECTS')).toHaveLength(0)
    expect(queriesWith(':CAUSED_BY')).toHaveLength(0)
  })

  it('CREATE senza riga di ritorno → errore, nessun evento pubblicato', async () => {
    vi.mocked(runQuery).mockResolvedValue([])
    await expect(createProblem({ title: 'P', priority: 'high' }, ctx)).rejects.toThrow('Failed to create problem')
    expect(workflowEngine.createInstance).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
  })
})

// ── publishProblemTransition ──────────────────────────────────────────────────

describe('publishProblemTransition', () => {
  const row = (map: Record<string, unknown>) => ({ get: (k: string) => (k in map ? map[k] : null) })

  it('problem inesistente nel tenant → errore esplicito, nessun evento', async () => {
    h.session.executeRead.mockResolvedValue({ records: [] })
    await expect(publishProblemTransition('prb-x', 'in_progress', ctx))
      .rejects.toThrow('Problem prb-x not found while building event payload')
    expect(publishEvent).not.toHaveBeenCalled()
  })

  /**
   * CONTRATTO RINEGOZIATO (ondata 4, D-22). Prima il test pinnava UN evento
   * col nome del passo nel tipo (`problem.in_progress`). Ora ne vengono
   * pubblicati DUE con lo stesso payload: il tipo **stabile**
   * `problem.step_entered` (che una rinomina del passo non tocca) e l'**alias**
   * storico `problem.in_progress`, mantenuto perché a lui sono agganciate le
   * regole di notifica di fabbrica e quelle già scritte dai tenant. Il nome del
   * passo, con etichetta, scopo e categoria, è nel payload.
   */
  it('pubblica il tipo stabile E l\'alias col nome del passo, con i fatti del passo nel payload', async () => {
    h.session.executeRead.mockResolvedValue({ records: [row({ id: 'prb-1', title: 'T', priority: 'high', status: 'in_progress', assignedTo: null, teamName: 'NOC' })] })
    vi.mocked(runQueryOne).mockResolvedValue({ stepId: 'st-1', label: 'In lavorazione', purpose: 'investigation', category: 'active' })
    await publishProblemTransition('prb-1', 'in_progress', ctx)
    const body = {
      id: 'prb-1', title: 'T', priority: 'high', status: 'in_progress', assignedTo: 'NOC',
      step_id: 'st-1', step_name: 'in_progress', step_label: 'In lavorazione',
      step_purpose: 'investigation', step_category: 'active',
    }
    expect(publishEvent).toHaveBeenCalledWith('problem.step_entered', 'tenant-1', 'user-1', body)
    expect(publishEvent).toHaveBeenCalledWith('problem.in_progress',  'tenant-1', 'user-1', body)
    expect(publishEvent).toHaveBeenCalledTimes(2)
    // la query è tenant-scoped
    const tx = { run: vi.fn().mockResolvedValue({ records: [] }) }
    await (h.session.executeRead.mock.calls[0]![0] as (t: typeof tx) => Promise<unknown>)(tx)
    expect(tx.run.mock.calls[0]![0]).toContain('MATCH (p:Problem {id: $id, tenant_id: $tenantId})')
    expect(tx.run.mock.calls[0]![1]).toEqual({ id: 'prb-1', tenantId: 'tenant-1' })
  })
})
