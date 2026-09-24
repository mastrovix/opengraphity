/**
 * problemService.createProblem / publishProblemTransition — Neo4j, workflow,
 * eventi e automazioni mockati. Pinna: priorità ITIL Impatto×Urgenza
 * (lib/priority.ts) coerente in entrambe le direzioni, numero PRB + 8 cifre
 * dal contatore atomico (lib/sequence.ts), istanza di workflow, evento
 * problem.created con tenant/attore, link CREATED_BY / AFFECTS / CAUSED_BY,
 * errori (tipizzati o — dove il sorgente non lo fa — pinnati come BUG).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Ondata 6 (A-9): le etichette dei CI vengono dal metamodello del tenant ────
// `LoadBalancer` è un tipo creato dal cliente: deve comparire nei predicati.
// Prima questi punti usavano la lista fissa di `lib/ciLabels.ts` e i CI di quel
// tipo non contavano, in silenzio.
// Ondata 7: la traduzione fra valori di dominio è una lettura (la matrice è
// dato del cliente). Qui si misura altro: il doppio risponde con la matrice di
// fabbrica e i vocabolari spediti, senza grafo (lib/__tests__/domainMatrixFake.ts).
// Le note si compongono nella lingua del cliente: qui italiano, come le attese.
// Ondata 6 di «Nulla cablato»: il formato dei numeri è del cliente; qui quello di fabbrica.
vi.mock('../../lib/ticketCIExclusions.js', () => import('../../lib/__tests__/ticketCIExclusionsFake.js'))
vi.mock('../../lib/ticketNumbering.js', () => import('../../lib/__tests__/ticketNumberingFake.js'))
vi.mock('../../lib/tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'it'), languageForUser: vi.fn(async () => 'it') }))
vi.mock('../../lib/domainMatrix.js', () => import('../../lib/__tests__/domainMatrixFake.js'))

vi.mock('../../lib/ciLabelsForTenant.js', () => ({
  ciLabelsForTenant:         vi.fn(async () => ['Application', 'LoadBalancer', 'Server']),
  ciLabelPredicateForTenant: vi.fn(async (alias: string) => `(${alias}:Application OR ${alias}:LoadBalancer OR ${alias}:Server)`),
  apocLabelFilterForTenant:  vi.fn(async () => '+Application|+LoadBalancer|+Server'),
  ciTypeNameForLabel:        vi.fn(async (_t: string, label: string) => (label === 'LoadBalancer' ? 'load_balancer' : null)),
  clearCILabelCache:         vi.fn(),
}))
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
vi.mock('../../lib/stepEnteredPublisher.js', () => ({ publishStepEnteredForEntity: vi.fn() }))
vi.mock('../../lib/workflowHelpers.js', () => ({
  getInitialStepName: vi.fn().mockResolvedValue('new'),
  getWorkflowSteps:   vi.fn().mockResolvedValue([]),
}))
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}))

const { createProblem, publishProblemTransition } = await import('../problemService.js')
const { runQuery } = await import('@opengraphity/neo4j')
const { workflowEngine } = await import('@opengraphity/workflow')
const { publishEvent } = await import('../../lib/publishEvent.js')
const { publishStepEnteredForEntity } = await import('../../lib/stepEnteredPublisher.js')
const { evaluateTriggers } = await import('../../lib/triggerEngine.js')
const { derivePriority, invertPriority } = await import('../../lib/priority.js')

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
      // Ondata 6 (C-2): il MERGE dei CI impattati ora RITORNA il conteggio e
      // chi chiama lo legge — zero righe significa CI non collegato.
      : cypher.includes('MERGE (p)-[r:AFFECTS]->(ci)')
        ? [{ linked: 1 }]
        // The CIs are checked before the problem is written (review of 23 Sep 2026): here they all exist.
        : cypher.includes('WHERE ci.id IN $ids')
          ? (params?.['ids'] as string[]).map((id) => ({ id }))
          : [])
  vi.mocked(workflowEngine.createInstance).mockResolvedValue({ id: 'wi-1' } as never)
})

// ── Priorità ITIL ─────────────────────────────────────────────────────────────

describe('createProblem — «crea senza SLA»', () => {
  it('acknowledgeNoSla → registra quando e chi ha accettato di crearlo senza SLA; senza, nulla', async () => {
    await createProblem({ title: 'P', priority: 'low', acknowledgeNoSla: true }, ctx)
    const [[cypher, params]] = queriesWith('CREATE (p:Problem')
    expect(cypher).toContain('sla_absence_acknowledged_at: $ackAt')
    expect(params['ackAt']).toBe(params['now'])
    expect(params['ackBy']).toBe('user-1')

    vi.clearAllMocks()
    await createProblem({ title: 'P', priority: 'low' }, ctx)
    const [[, p2]] = queriesWith('CREATE (p:Problem')
    expect(p2).toMatchObject({ ackAt: null, ackBy: null })
  })
})

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
    expect(params['priority']).toBe(await derivePriority(ctx.tenantId, impact, urgency))
  })

  it.each(['critical', 'high', 'medium', 'low'] as const)('solo priority=%s → impact/urgency retro-derivati e coerenti con la matrice', async (priority) => {
    await createProblem({ title: 'P', priority }, ctx)
    const [[, params]] = queriesWith('CREATE (p:Problem')
    // Ondata 7: l'inverso si calcola DALLA matrice (`invertPriority`), non da
    // una tabella parallela con un `default → medium`.
    const iu = await invertPriority(ctx.tenantId, priority)
    expect(params).toMatchObject({ priority, impact: iu.impact, urgency: iu.urgency })
    // invariante: la coppia retro-derivata rimappa sulla stessa priorità
    expect(await derivePriority(ctx.tenantId, iu.impact, iu.urgency)).toBe(priority)
  })

  // CONTRATTO RINEGOZIATO (ondata 7): prima `impact` senza `urgency` cadeva nel
  // ramo della severità e metà del dato dell'utente sparìa in silenzio —
  // l'impatto dato veniva tenuto, l'urgenza inventata dalla priorità, e la
  // priorità NON era più impatto × urgenza (low × high dà medium, non
  // critical: l'invariante ITIL era rotta nel dato salvato). Ora è un rifiuto
  // che dice come passarli.
  it('impact senza urgency è un rifiuto: metà del dato non passa più in silenzio', async () => {
    await expect(createProblem({ title: 'P', impact: 'low', priority: 'critical' }, ctx))
      .rejects.toThrow(/Impact and urgency go together/)
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('senza impact+urgency né priority → errore esplicito, nessuna scrittura', async () => {
    await expect(createProblem({ title: 'P' }, ctx)).rejects.toThrow('Fornire impact+urgency oppure priority')
    expect(runQuery).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('senza priorità l\'errore è tipizzato (BAD_USER_INPUT): ondata 7, ora `ValidationError` come incidentService', async () => {
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
    await createProblem({ title: 'P', priority: 'high', category: 'network' }, ctx)
    expect(workflowEngine.createInstance).toHaveBeenCalledTimes(1)
    expect(workflowEngine.createInstance).toHaveBeenCalledWith(h.session, 'tenant-1', expect.stringMatching(UUID_RE), 'problem', undefined, 'network')

    vi.clearAllMocks()
    await createProblem({ title: 'P', priority: 'high' }, ctx)
    expect(workflowEngine.createInstance).toHaveBeenCalledWith(h.session, 'tenant-1', expect.any(String), 'problem', undefined, null)
  })

  /**
   * Revisione totale · B-3: la categoria sceglieva il workflow e poi spariva —
   * il CREATE non la scriveva, il tipo non la esponeva, e una policy SLA
   * «problem, categoria X» non sceglieva mai nessun problem (il motore legge
   * `e.category` dal nodo).
   */
  it('la categoria resta sul nodo, ed è un valore del vocabolario del cliente', async () => {
    await createProblem({ title: 'P', priority: 'high', category: 'network' }, ctx)
    const [[cypher, params]] = queriesWith('CREATE (p:Problem')
    expect(cypher).toContain('category:    $category')
    expect(params).toMatchObject({ category: 'network' })

    vi.clearAllMocks()
    await createProblem({ title: 'P', priority: 'high' }, ctx)
    expect(queriesWith('CREATE (p:Problem')[0]![1]).toMatchObject({ category: null })

    await expect(createProblem({ title: 'P', priority: 'high', category: 'storage' }, ctx))
      .rejects.toThrow(/category: "storage" is not in the dictionary/)
  })

  it('pubblica problem.created con tenant, attore e payload (priorità derivata, stato iniziale)', async () => {
    await createProblem({ title: 'Disco pieno', impact: 'high', urgency: 'high' }, ctx)
    expect(publishEvent).toHaveBeenCalledTimes(1)
    expect(publishEvent).toHaveBeenCalledWith('problem.created', 'tenant-1', 'user-1', {
      id: expect.stringMatching(UUID_RE), title: 'Disco pieno', priority: 'critical', status: 'new', assignedTo: '—',
    })
  })

  // AU-1 (revisione del 14 set 2026): le automazioni non si valutano più qui
  // dentro, ma dal consumatore di `problem.created` (consumers/automationConsumer.ts),
  // come per ogni ticket e ogni evento.
  it('non valuta trigger né regole in linea: li mette in moto problem.created', async () => {
    await createProblem({ title: 'P', priority: 'medium', category: 'network' }, ctx)
    expect(evaluateTriggers).not.toHaveBeenCalled()
  })

  it('affectedCIs → un MERGE AFFECTS per CI, tenant-scoped; relatedIncidents → CAUSED_BY', async () => {
    await createProblem({ title: 'P', priority: 'high', affectedCIs: ['ci-1', 'ci-2'], relatedIncidents: ['inc-9'] }, ctx)
    const affects = queriesWith('MERGE (p)-[r:AFFECTS]->(ci)')
    expect(affects.map(([, p]) => p)).toEqual([
      { id: expect.any(String), tenantId: 'tenant-1', ciId: 'ci-1' },
      { id: expect.any(String), tenantId: 'tenant-1', ciId: 'ci-2' },
    ])
    expect(affects[0]![0]).toContain('MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})')
    // Ondata 6 (A-9): il predicato viene dal metamodello del tenant, quindi
    // comprende il tipo creato dal cliente; e il MERGE ritorna il conteggio.
    expect(affects[0]![0]).toContain('ci:LoadBalancer')
    expect(affects[0]![0]).toContain('RETURN count(r) AS linked')
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

/**
 * Revisione totale · C-1: i due eventi dell'ingresso nel passo (il tipo
 * stabile `problem.step_entered` e l'alias `problem.<passo>`) nascono
 * dall'hook `onStepEntered` del motore, che vede anche i cammini automatici —
 * prima li pubblicava solo questa funzione, chiamata dalla sola transizione
 * manuale. Il contratto è pinnato in
 * `src/lib/__tests__/stepEnteredPublisher.test.ts`; qui resta la delega.
 */
describe('publishProblemTransition — delega al publisher condiviso (C-1)', () => {
  it('non pubblica eventi di suo', async () => {
    vi.clearAllMocks()
    await publishProblemTransition('prb-1', 'in_progress', ctx)
    expect(publishStepEnteredForEntity).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1', actorId: 'user-1', entityType: 'problem', entityId: 'prb-1', stepName: 'in_progress',
    }))
    expect(publishEvent).not.toHaveBeenCalled()
  })
})
