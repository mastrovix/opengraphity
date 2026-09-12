/**
 * eventCorrelation.ts — pipeline dell'ondata 3 con mock delle query:
 * soppressione in finestra di change (diretta, a monte con hops, scheduled con
 * releaseWindow, finestra passata), soglia di severità, orfano, ritardo con job
 * accodato (e risoluzione durante l'attesa → none), raggruppamento per CI
 * (aggancio, riapertura via transizione "Riapri", apertura con attore
 * monitoring), chiusura automatica (tutti risolti / uno ancora firing /
 * auto_resolve off / incident senza arco diretto verso resolved: cammino di
 * passi intermedi nella definizione — seed new→assigned→in_progress, nessun
 * cammino, cammino troppo lungo, passo intermedio rifiutato), fine finestra,
 * apertura condivisa (orfano → ValidationError), helper puri.
 * Ondata 4: sfarfallio (soglia raggiunta → flapping, salute ricalcolata,
 * nessun incident, commento sull'incident già correlato; sotto soglia →
 * normale; ripetizione durante flapping → invariato; stabilizzazione dal job
 * periodico → torna allo stato del payload e ripassa dalla pipeline), tempesta
 * della sorgente (eventStorm mockato: aggancio all'incident di tempesta,
 * storm_no_ci, resolved in tempesta, soppressione che vince), metriche.
 * Revisione (ondata 1): lock Redis per gruppo (Redis in memoria: due pipeline
 * concorrenti sullo stesso CI → UN incident; lock occupato + incident comparso
 * → aggancio; attesa scaduta → errore ritentabile), stati `pending`
 * ritentabili (fine soppressione / stabilizzazione con correlazione fallita
 * ripresi da reevaluatePendingEvents), passate paginate, incident di tempesta
 * chiuso → nuovo incident / risolto → riapertura, tempesta esclusa dal
 * raggruppamento, ripetizione senza rumore, chiusura con un solo commento.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { GraphQLError } from 'graphql'

// Ondata 7: la traduzione fra valori di dominio è una lettura (la matrice è
// dato del cliente). Qui si misura altro: il doppio risponde con la matrice di
// fabbrica e i vocabolari spediti, senza grafo (lib/__tests__/domainMatrixFake.ts).
vi.mock('../../lib/domainMatrix.js', () => import('../../lib/__tests__/domainMatrixFake.js'))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(),
  toNumber: (v: unknown) => (v == null ? 0 : Number(v)),
}))
// Redis in memoria per il lock del gruppo (lib/redisLock.ts): SET NX e rilascio guardato dal token, come il vero.
const lockStore = new Map<string, string>()
const inMemorySet = async (key: string, value: string, _ex: string, _ttl: number, nx?: string) => {
  if (nx === 'NX' && lockStore.has(key)) return null
  lockStore.set(key, value)
  return 'OK'
}
const inMemoryEval = async (_lua: string, _n: number, key: string, owner: string) => {
  if (lockStore.get(key) !== owner) return 0
  lockStore.delete(key)
  return 1
}
const redis = { set: vi.fn(inMemorySet), eval: vi.fn(inMemoryEval) }
vi.mock('../../lib/bullmq.js', () => ({ getSharedRedis: () => redis }))
vi.mock('@opengraphity/workflow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@opengraphity/workflow')>()),   // seed reale (INCIDENT_WORKFLOW_BASE)
  workflowEngine: { transition: vi.fn(), getAvailableTransitions: vi.fn() },
}))
vi.mock('../../lib/publishEvent.js', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
vi.mock('../../lib/workflowHelpers.js', () => ({ getWorkflowSteps: vi.fn(), getStepNamesByPurpose: vi.fn() }))
// Ondata 6 · C-3: le relazioni percorse a monte sono quelle del tenant. Qui il
// tenant di prova ha solo le quattro spedite col prodotto, così i Cypher
// pinnati restano quelli (e un test dedicato mostra il caso con una relazione
// del cliente: services/__tests__/serviceImpactEngine.test.ts).
vi.mock('../../lib/ciMetamodelForTenant.js', () => ({
  suppressionRelPatternForTenant: vi.fn(async () => 'DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE'),
}))
vi.mock('../incidentService.js', () => ({
  createIncident: vi.fn(), resolveIncident: vi.fn(), addIncidentComment: vi.fn().mockResolvedValue(undefined), publishIncidentTransition: vi.fn().mockResolvedValue(undefined),
}))
// Revisione (3.1): i moduli vivono in services/events/; le facciate ri-esportano,
// quindi si mockano i moduli reali (policy, salute del CI) e si leggono dalla facciata.
vi.mock('../events/policy.js', () => ({ getEventPolicy: vi.fn(), setEventPolicy: vi.fn() }))
vi.mock('../events/ciHealth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../events/ciHealth.js')>()),
  recomputeCIHealth: vi.fn().mockResolvedValue('down'),
}))
vi.mock('../../jobs/eventCorrelateWorker.js', () => ({ enqueueCorrelation: vi.fn().mockResolvedValue(undefined) }))
// Ondata 4: le tempeste vivono in eventStorm.ts (testato a parte); qui si
// verifica che la pipeline le interroghi e ne rispetti lo stato.
vi.mock('../events/storm.js', () => ({
  trackSourceStorm: vi.fn(), getStormState: vi.fn(), replaceClosedStormIncident: vi.fn(),
  stormLockKey: (t: string, s: string) => `og:events:storm-open:${t}:${s}`,
  STORM_LOCK_TTL_SECONDS: 30, STORM_LOCK_WAIT_MS: 3_000, STORM_LOCK_POLL_MS: 100,
}))
vi.mock('../../middleware/metrics.js', () => ({
  eventsFlappingTotal: { inc: vi.fn() }, eventsSuppressedTotal: { inc: vi.fn() },
  incidentsAutoOpenedTotal: { inc: vi.fn() }, incidentsAutoResolvedTotal: { inc: vi.fn() }, incidentsReopenedTotal: { inc: vi.fn() },
  eventsCorrelatedTotal: { inc: vi.fn() }, eventPipelineDurationSeconds: { observe: vi.fn() },
  workflowPurposeMissingTotal: { inc: vi.fn() },
  redisLockTimeoutsTotal: { inc: vi.fn() }, redisLockHoldSeconds: { observe: vi.fn() },
}))

const corr = await import('../eventCorrelation.js')
const { runEventPipeline, findSuppressingChange, reevaluateSuppressedEvents, reevaluateClosedWindows, reevaluateFlappingEvents, reevaluatePendingEvents, openIncidentFromEvent, meetsOpenThreshold, changeIsInWindow, resolveChangeWindowSteps, findAutoResolvePath, isFlapping, isStable, groupLockKey, MONITORING_ACTOR, AUTO_RESOLVE_MAX_HOPS, CORRELATION_OUTCOMES, PENDING_CORRELATIONS, STUCK_FIRING_WHERE, DUE_CORRELATION_WHERE, UNCORRELATED_WHERE, OVERDUE_DELAYED_WHERE, stuckEventParams, UNCORRELATED_AFTER_MINUTES, OVERDUE_DELAYED_GRACE_MINUTES, GROUP_LOCK_TTL_SECONDS, GROUP_LOCK_WAIT_MS, GROUP_LOCK_POLL_MS } = corr
// Revisione 1.18: helper della chiusura automatica (non passano dalla facciata).
const { suppressedSummary, STILL_FIRING_STATUSES } = await import('../events/autoResolve.js')
// Revisione 2 · D6.2: la definizione condivisa di «CI in finestra di change».
const { changeWindowsForCIs, pickChangeWindow } = await import('../events/suppression.js')
// Cronologia dell'allarme: il frammento condiviso, per verificare che gli statement della pipeline lo contengano.
const { historyWriteCypher } = await import('../events/history.js')
const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { workflowEngine, INCIDENT_WORKFLOW_BASE } = await import('@opengraphity/workflow')
const { publishEvent } = await import('../../lib/publishEvent.js')
const { audit } = await import('../../lib/audit.js')
const { getWorkflowSteps, getStepNamesByPurpose } = await import('../../lib/workflowHelpers.js')
const incidentService = await import('../incidentService.js')
const { getEventPolicy, recomputeCIHealth } = await import('../eventService.js')
const { enqueueCorrelation } = await import('../../jobs/eventCorrelateWorker.js')
const { trackSourceStorm, getStormState, replaceClosedStormIncident } = await import('../eventStorm.js')
const metrics = await import('../../middleware/metrics.js')
const { DEFAULT_EVENT_POLICY } = await import('../../lib/eventPolicy.js')
const { PAGE_SIZE, MAX_PAGES } = await import('../../lib/pagedPass.js')

const session = { close: vi.fn().mockResolvedValue(undefined) }
const NOW = '2026-09-09T10:00:00.000Z'
const MON = { tenantId: 't1', userId: MONITORING_ACTOR }
const NO_STORM = { active: false, since: null, incidentId: null, sourceName: 'Zabbix prod' }
const STORM = { active: true, since: '2026-09-09T09:58:00.000Z', incidentId: 'inc-storm', sourceName: 'Zabbix prod' }
/** Istante ISO `m` minuti prima di NOW. */
const minutesAgo = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString()

const INCIDENT_STEPS = [
  { name: 'new',         isInitial: true,  isTerminal: false, isOpen: true,  category: 'new',      stepOrder: 1 },
  { name: 'assigned',    isInitial: false, isTerminal: false, isOpen: true,  category: 'active',   stepOrder: 2 },
  { name: 'in_progress', isInitial: false, isTerminal: false, isOpen: true,  category: 'active',   stepOrder: 3 },
  { name: 'resolved',    isInitial: false, isTerminal: false, isOpen: true,  category: 'resolved', stepOrder: 4 },
  { name: 'closed',      isInitial: false, isTerminal: true,  isOpen: false, category: 'closed',   stepOrder: 5 },
]

/** Dispatch dei mock per frammento di Cypher: l'ULTIMA regola che combacia vince (così `[...baseRules(), override]` funziona). Le funzioni ricevono i parametri della query. */
function onCypher(rules: Array<[RegExp, unknown]>) {
  const impl = async (_s: unknown, cypher: string, params?: Record<string, unknown>) => {
    for (const [re, value] of [...rules].reverse()) if (re.test(cypher)) return typeof value === 'function' ? (value as (p?: Record<string, unknown>) => unknown)(params) : value
    throw new Error(`unexpected cypher in test:\n${cypher}`)
  }
  vi.mocked(runQueryOne).mockImplementation(impl as never)
  vi.mocked(runQuery).mockImplementation((async (s: unknown, c: string, p?: Record<string, unknown>) => { const r = await impl(s, c, p); return r == null ? [] : Array.isArray(r) ? r : [r] }) as never)
}
const calls = () => [...vi.mocked(runQueryOne).mock.calls, ...vi.mocked(runQuery).mock.calls].map(([, cypher, params]) => ({ cypher: cypher as string, params: params as Record<string, unknown> }))
const callMatching = (re: RegExp) => calls().find((c) => re.test(c.cypher))
const published = () => vi.mocked(publishEvent).mock.calls.map((c) => c[0])

// Frammenti delle query della pipeline
const Q = {
  load:        /MATCH \(e:Event \{id: \$eventId, tenant_id: \$tenantId\}\)\s+OPTIONAL MATCH \(e\)-\[:RAISED_ON\]/,
  suppressing: /AFFECTS_CI\]->\(target\)/,
  suppress:    /MERGE \(e\)-\[r:SUPPRESSED_BY\]/,
  lift:        /SET e\.status = 'firing', e\.suppressed_by_change_id = null/,
  touchSupp:   /-\[r:SUPPRESSED_BY\]->\(c:Change \{id: \$changeId, tenant_id: \$tenantId\}\)\s+SET r\.last_seen_at = \$now, e\.updated_at = \$now/,
  setCorr:     /SET e\.correlation = \$correlation/,
  ever:        /RETURN count\(i\) AS n/,
  group:       /NOT wi\.current_step IN \$terminalSteps OR wi\.current_step = \$resolvedStep\s+RETURN DISTINCT i\.id/,
  attach:      /MERGE \(e\)-\[r:CORRELATED_INTO\]/,
  linked:      /count\(DISTINCT other\) AS stillFiring/,
  defTr:       /HAS_STEP\]->\(from:WorkflowStep\)\s+MATCH \(from\)-\[tr:TRANSITIONS_TO\]->\(to:WorkflowStep\)/,
  byChange:    /status: 'suppressed', suppressed_by_change_id: \$changeId/,
  allSupp:     /MATCH \(e:Event \{status: 'suppressed'\}\)/,
  // ondata 4
  flap:        /SET e\.status = 'flapping', e\.flapping_since = \$now/,
  linkedOpen:  /NOT wi\.current_step IN \$terminalSteps\s+RETURN i\.id AS incidentId, i\.created_at AS createdAt/,
  allFlap:     /MATCH \(e:Event \{status: 'flapping'\}\)/,
  stabilize:   /SET e\.status = \$status, e\.flapping_since = null, e\.correlation = \$correlation/,
  // revisione
  allPending:  /MATCH \(e:Event \{status: 'firing'\}\)\s+WHERE e\.id > \$cursor AND \(/,
  incStep:     /MATCH \(i:Incident \{id: \$incidentId, tenant_id: \$tenantId\}\)-\[:HAS_WORKFLOW\]->\(wi:WorkflowInstance \{tenant_id: \$tenantId\}\)\s+RETURN i\.id AS incidentId, wi\.id AS instanceId, wi\.current_step AS step/,
  // revisione 1.16: incident chiuso a cui l'allarme era correlato (dopo l'apertura di uno nuovo)
  closedPrev:  /WHERE wi\.current_step IN \$terminalSteps AND wi\.current_step <> \$resolvedStep AND i\.id <> \$openedId/,
  // cronologia dell'allarme: la voce scritta da sola (appendEventHistory: chiusura automatica); le altre stanno dentro gli statement qui sopra
  history:     /MATCH \(e:Event \{id: \$eventId, tenant_id: \$tenantId\}\)\s+FOREACH \(_ IN CASE WHEN true THEN \[1\] ELSE \[\] END \|/,
}

/** Archi della definizione come li restituisce loadDefinitionTransitions (dal seed reale del workflow incident). */
type DefTr = { fromStep: string; toStep: string; toLabel: string | null; trigger: string; condition: string | null }
const SEED_TRANSITIONS: DefTr[] = INCIDENT_WORKFLOW_BASE.transitions.map((t) => ({
  fromStep: t.fromStepName, toStep: t.toStepName, trigger: t.trigger, condition: t.condition,
  toLabel: INCIDENT_WORKFLOW_BASE.steps.find((s) => s.name === t.toStepName)?.label ?? null,
}))
const tr = (fromStep: string, toStep: string, over: Partial<DefTr> = {}): DefTr => ({ fromStep, toStep, toLabel: null, trigger: 'manual', condition: null, ...over })

const props = (over: Record<string, unknown> = {}) => ({
  id: 'ev-1', fingerprint: 'fp', status: 'firing', severity: 'critical', title: 'DiskFull', resource: 'db-01', resource_kind: 'hostname',
  count: 3, first_seen_at: 'T0', last_seen_at: 'T1', source_id: 'hook-1', correlation: 'none', correlation_at: null, correlation_due_at: null, suppressed_by_change_id: null,
  transitions: [], last_payload_status: 'firing', flapping_since: null, ...over,
})
const policy = (over: Partial<typeof DEFAULT_EVENT_POLICY> = {}) => ({ ...structuredClone(DEFAULT_EVENT_POLICY), ...over })

/**
 * Revisione 2 · D6.2: la ricerca della finestra è la query BATCH condivisa con
 * i servizi (`changeWindowsForCIs`): una riga per CI con le change candidate
 * già ordinate. `via` dice che la change è su un CI a monte (B2-13).
 */
type Candidate = { changeId: string; code: string; step: string; plans?: unknown[]; via?: string }
const windows = (...candidates: Candidate[]) => [{
  ciId: 'ci-1',
  changes: candidates.map((c) => ({
    changeId: c.changeId, code: c.code, step: c.step, plans: c.plans ?? [],
    viaCiId: c.via ?? 'ci-1', viaCiName: c.via ?? 'ci-1', upstream: c.via !== undefined,
  })),
}]

/** Regole base: evento con CI, nessuna change in finestra, nessun incident aperto, scritture ok. */
function baseRules(ev: Record<string, unknown> = {}, ciId: string | null = 'ci-1'): Array<[RegExp, unknown]> {
  return [
    [Q.load, { props: props(ev), ciId }],
    [Q.suppressing, []],
    [Q.suppress, { id: 'ev-1' }],
    [Q.lift, { lifted: 1 }],   // B2-04: la fine soppressione è guardata e dice quante righe ha liberato
    [Q.touchSupp, null],
    [Q.setCorr, null],
    [Q.ever, { n: 0 }],
    [Q.group, null],
    [Q.attach, { created: true }],
    [Q.linked, null],
    [Q.flap, { id: 'ev-1' }],
    [Q.linkedOpen, null],
    [Q.stabilize, { id: 'ev-1' }],
    [Q.incStep, { incidentId: 'inc-storm', instanceId: 'wi-s', step: 'in_progress' }],
    [Q.closedPrev, null],
    [Q.history, { id: 'ev-1' }],
  ]
}

beforeEach(() => {
  vi.clearAllMocks()
  lockStore.clear()
  redis.set.mockImplementation(inMemorySet)
  redis.eval.mockImplementation(inMemoryEval)
  vi.mocked(getSession).mockReturnValue(session as never)
  vi.mocked(getEventPolicy).mockResolvedValue(policy())
  vi.mocked(trackSourceStorm).mockResolvedValue(NO_STORM)
  vi.mocked(getStormState).mockResolvedValue(NO_STORM)
  vi.mocked(getWorkflowSteps).mockResolvedValue(INCIDENT_STEPS)
  // Ondata 4 · A4-1: i passi della finestra vengono dallo SCOPO. Il tenant di
  // prova ha i nomi di fabbrica, con gli scopi assegnati dalla migrazione.
  vi.mocked(getStepNamesByPurpose).mockImplementation(async (_s, _t, _e, purposes) =>
    (purposes as readonly string[]).includes('implementation') ? ['deployment'] : ['scheduled'])
  vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([] as never)
  vi.mocked(workflowEngine.transition).mockResolvedValue({ success: true } as never)
  vi.mocked(incidentService.createIncident).mockResolvedValue({ id: 'inc-new', number: 'INC00000009' } as never)
  vi.mocked(incidentService.resolveIncident).mockResolvedValue({ id: 'inc-1' } as never)
})
afterEach(() => { vi.useRealTimers() })

// ── Helper puri ──────────────────────────────────────────────────────────────

describe('helper puri', () => {
  it('meetsOpenThreshold: never → mai; altrimenti severità ≥ soglia', () => {
    expect(meetsOpenThreshold('critical', 'never')).toBe(false)
    expect(meetsOpenThreshold('warning', 'critical')).toBe(false)
    expect(meetsOpenThreshold('critical', 'critical')).toBe(true)
    expect(meetsOpenThreshold('warning', 'warning')).toBe(true)
    expect(meetsOpenThreshold('info', 'info')).toBe(true)
    expect(meetsOpenThreshold('info', 'warning')).toBe(false)
  })

  it('changeIsInWindow: i passi di finestra vengono dallo SCOPO del tenant, non dai nomi (ondata 4 · A4-1)', async () => {
    const at = Date.parse(NOW)
    const plan = JSON.stringify([{ title: 'go', validationWindow: { start: '2026-09-09T08:00:00Z', end: '2026-09-09T09:00:00Z' }, releaseWindow: { start: '2026-09-09T09:30:00Z', end: '2026-09-09T11:00:00Z' } }])
    const past = JSON.stringify([{ title: 'old', validationWindow: { start: '', end: '' }, releaseWindow: { start: '2026-09-08T09:00:00Z', end: '2026-09-08T11:00:00Z' } }])

    // Nomi di fabbrica: la finestra aperta è `deployment`, la programmata `scheduled`.
    const factory = await resolveChangeWindowSteps('t1')
    expect(factory).toEqual({ implementation: ['deployment'], planned: ['scheduled'], all: ['deployment', 'scheduled'] })
    expect(changeIsInWindow('deployment', [], at, factory)).toBe(true)
    expect(changeIsInWindow('scheduled', [plan], at, factory)).toBe(true)
    expect(changeIsInWindow('scheduled', [past, null], at, factory)).toBe(false)
    expect(changeIsInWindow('scheduled', [], at, factory)).toBe(false)
    expect(changeIsInWindow('review', [plan], at, factory)).toBe(false)
    expect(changeIsInWindow('approval', [plan], at, factory)).toBe(false)

    // Il cliente ha rinominato tutto: gli stessi scopi su nomi diversi.
    vi.mocked(getStepNamesByPurpose).mockImplementation(async (_s, _t, _e, purposes) =>
      (purposes as readonly string[]).includes('implementation') ? ['rilascio_notturno'] : ['in_calendario'])
    const cliente = await resolveChangeWindowSteps('t1')
    expect(cliente.all).toEqual(['rilascio_notturno', 'in_calendario'])
    expect(changeIsInWindow('rilascio_notturno', [], at, cliente)).toBe(true)
    expect(changeIsInWindow('in_calendario', [plan], at, cliente)).toBe(true)
    expect(changeIsInWindow('in_calendario', [], at, cliente)).toBe(false)
    // ...e i nomi di fabbrica non silenziano più niente, perché non sono i suoi passi
    expect(changeIsInWindow('deployment', [], at, cliente)).toBe(false)

    // Il workflow delle change ESISTE ma nessun passo dichiara lo scopo: è
    // configurazione incompleta, e la conseguenza sarebbe silenziosa (nessun
    // allarme silenziato durante i rilasci, incident falsi). Si ferma e lo
    // dice — l'allarme resta acceso alla sorgente e il lavoro è rigiocabile.
    vi.mocked(getStepNamesByPurpose).mockResolvedValue([])
    vi.mocked(getWorkflowSteps).mockResolvedValue(
      ['valutazione', 'cab', 'in_calendario', 'rilascio', 'chiusa'].map((name) => ({
        name, isInitial: false, isTerminal: false, isOpen: true, category: 'active', purpose: null, stepOrder: null,
      })),
    )
    const err = await resolveChangeWindowSteps('t1').then(() => null, (e: unknown) => e)
    expect(String((err as Error).message)).toMatch(/ha 5 passi e nessuno dichiara lo scopo \[scheduled, implementation\]/)
    expect(String((err as Error).message)).toMatch(/disegnatore dei workflow/)
    expect(String((err as Error).message)).toMatch(/rigiocabile dalla pagina Code/)
    expect(metrics.workflowPurposeMissingTotal.inc).toHaveBeenCalledWith({ rule: 'change_window' })

    // Il tenant NON ha affatto un workflow delle change (è il caso di c-two):
    // non c'è niente da sopprimere e non c'è niente di sbagliato — nessun
    // errore e nessun contatore, altrimenti un allarme per ogni allarme
    // insegnerebbe solo a ignorare gli allarmi.
    vi.mocked(metrics.workflowPurposeMissingTotal.inc).mockClear()
    vi.mocked(getWorkflowSteps).mockResolvedValue([])
    const senzaChange = await resolveChangeWindowSteps('t1')
    expect(senzaChange).toEqual({ implementation: [], planned: [], all: [] })
    expect(changeIsInWindow('deployment', [], at, senzaChange)).toBe(false)
    expect(metrics.workflowPurposeMissingTotal.inc).not.toHaveBeenCalled()
  })
})

// ── 1. Soppressione ──────────────────────────────────────────────────────────

describe('soppressione in finestra di change', () => {
  it('change in deployment sul CI diretto → suppressed, SUPPRESSED_BY, event.suppressed con change_id; NESSUNA salute, NESSUN incident', async () => {
    onCypher([...baseRules(), [Q.suppressing, windows({ changeId: 'chg-1', code: 'CHG1', step: 'deployment', plans: [null] })]])
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out).toEqual({ outcome: 'suppressed', status: 'suppressed', suppressedByChangeId: 'chg-1', incidentId: null })

    // Revisione 2 · D6.2: la ricerca è la query BATCH condivisa con i servizi
    // (un CI solo, qui) e il frammento porta i piani del CI toccato (B2-12) e
    // le relazioni tecniche a monte (B2-13).
    const find = callMatching(Q.suppressing)!
    expect(find.cypher).toContain('UNWIND $ciIds AS cid')
    expect(find.cypher).toContain('MATCH (ci:ConfigurationItem {id: cid, tenant_id: $tenantId})')
    expect(find.cypher).toContain('[rel:DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE*1..1]->(up:ConfigurationItem {tenant_id: $tenantId})')   // hops = 1 (policy predefinita)
    expect(find.cypher).toContain('MATCH (c:Change {tenant_id: $tenantId})-[:AFFECTS_CI]->(target)')
    expect(find.cypher).toContain('coalesce(c.deleted, false) = false')
    expect(find.cypher).toContain('wi.current_step IN $windowSteps')
    // B2-12: i piani di rilascio sono quelli del CI toccato, non di tutta la change
    expect(find.cypher).toContain('[(c)-[:HAS_DEPLOY_PLAN]->(dp:DeployPlanTask {tenant_id: $tenantId}) WHERE dp.ci_id = target.id | dp.steps]')
    expect(find.params).toMatchObject({ ciIds: ['ci-1'], tenantId: 't1', windowSteps: ['deployment', 'scheduled'], implementationSteps: ['deployment'] })

    const sup = callMatching(Q.suppress)!
    expect(sup.cypher).toContain("SET e.status = 'suppressed', e.suppressed_by_change_id = $changeId")
    expect(sup.cypher).toContain("e.correlation = 'suppressed'")
    expect(sup.cypher).toContain('MATCH (c:Change {id: $changeId, tenant_id: $tenantId})')
    expect(sup.params).toMatchObject({ eventId: 'ev-1', tenantId: 't1', changeId: 'chg-1', now: NOW })

    expect(recomputeCIHealth).not.toHaveBeenCalled()
    expect(incidentService.createIncident).not.toHaveBeenCalled()
    expect(callMatching(Q.group)).toBeUndefined()
    expect(published()).toEqual(['event.suppressed'])
    expect(vi.mocked(publishEvent).mock.calls[0]![3]).toMatchObject({ id: 'ev-1', status: 'suppressed', ci_id: 'ci-1', change_id: 'chg-1', entity_type: 'event' })
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', userId: 'monitoring' }), 'event.suppressed', 'Event', 'ev-1', expect.objectContaining({ changeId: 'chg-1', ciId: 'ci-1' }))
  })

  it('change a un salto a monte con hops = 1 → suppressed (la query percorre DEPENDS_ON fino a hops); con hops = 0 solo il CI diretto (nessun DEPENDS_ON) → non soppresso', async () => {
    // hops = 2: il pattern di lunghezza variabile arriva a 2
    vi.mocked(getEventPolicy).mockResolvedValue(policy({ suppress_upstream_hops: 2 }))
    onCypher([...baseRules(), [Q.suppressing, windows({ changeId: 'chg-up', code: 'CHG2', step: 'deployment', plans: [] })]])
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).outcome).toBe('suppressed')
    expect(callMatching(Q.suppressing)!.cypher).toContain('*1..2]->(up:ConfigurationItem {tenant_id: $tenantId})')

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    vi.mocked(getEventPolicy).mockResolvedValue(policy({ suppress_upstream_hops: 0 }))
    onCypher(baseRules())   // nessuna change collegata direttamente
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out.outcome).toBe('opened')
    const find = callMatching(Q.suppressing)!
    expect(find.cypher).not.toContain('DEPENDS_ON')
    expect(find.cypher).toContain('UNWIND [{node: ci, dist: 0}] AS t')
    expect(recomputeCIHealth).toHaveBeenCalledWith('t1', 'ci-1', 'monitoring')
  })

  it('change approvata (scheduled) con releaseWindow che contiene l\'istante → suppressed; finestra passata → non soppresso, salute e correlazione procedono', async () => {
    const inWindow = JSON.stringify([{ title: 'r', validationWindow: { start: '', end: '' }, releaseWindow: { start: '2026-09-09T09:00:00Z', end: '2026-09-09T12:00:00Z' } }])
    onCypher([...baseRules(), [Q.suppressing, windows({ changeId: 'chg-s', code: 'CHG3', step: 'scheduled', plans: [inWindow] })]])
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).outcome).toBe('suppressed')
    expect(callMatching(Q.suppress)!.params['changeId']).toBe('chg-s')

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    const past = JSON.stringify([{ title: 'r', validationWindow: { start: '2026-09-08T09:00:00Z', end: '2026-09-08T10:00:00Z' }, releaseWindow: { start: '2026-09-08T10:00:00Z', end: '2026-09-08T12:00:00Z' } }])
    onCypher([...baseRules(), [Q.suppressing, windows({ changeId: 'chg-s', code: 'CHG3', step: 'scheduled', plans: [past] })]])
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out.outcome).toBe('opened')
    expect(callMatching(Q.suppress)).toBeUndefined()
    expect(recomputeCIHealth).toHaveBeenCalledWith('t1', 'ci-1', 'monitoring')
    expect(published()).not.toContain('event.suppressed')
  })

  it('ripetizione dello stesso allarme nella stessa finestra → resta suppressed senza un nuovo event.suppressed: all\'ingest avanza solo SUPPRESSED_BY.last_seen_at (correlation_at intatto), in rivalutazione nessuna scrittura; change diversa → nuovo avviso', async () => {
    onCypher([...baseRules({ status: 'suppressed', suppressed_by_change_id: 'chg-1', correlation: 'suppressed' }), [Q.suppressing, windows({ changeId: 'chg-1', code: 'CHG1', step: 'deployment', plans: [] })]])
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(callMatching(Q.suppress)).toBeUndefined()
    expect(callMatching(Q.touchSupp)!.params).toEqual({ eventId: 'ev-1', tenantId: 't1', changeId: 'chg-1', now: NOW })
    expect(publishEvent).not.toHaveBeenCalled()

    // passata periodica / rivalutazione: niente da scrivere (2.x: nessun churn su correlation_at / last_seen_at)
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([...baseRules({ status: 'suppressed', suppressed_by_change_id: 'chg-1', correlation: 'suppressed' }), [Q.suppressing, windows({ changeId: 'chg-1', code: 'CHG1', step: 'deployment', plans: [] })]])
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, mode: 'reevaluate' })).outcome).toBe('suppressed')
    expect(callMatching(Q.suppress)).toBeUndefined()
    expect(callMatching(Q.touchSupp)).toBeUndefined()
    expect(metrics.eventsSuppressedTotal.inc).not.toHaveBeenCalled()

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([...baseRules({ status: 'suppressed', suppressed_by_change_id: 'chg-1', correlation: 'suppressed' }), [Q.suppressing, windows({ changeId: 'chg-2', code: 'CHG2', step: 'deployment', plans: [] })]])
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(published()).toEqual(['event.suppressed'])
  })

  it('findSuppressingChange: hops non intero o negativo → errore; istante non ISO → errore; nessuna change → null', async () => {
    await expect(findSuppressingChange('t1', 'ci-1', -1, NOW)).rejects.toThrow(/suppress_upstream_hops must be an integer >= 0/)
    await expect(findSuppressingChange('t1', 'ci-1', 1.5, NOW)).rejects.toThrow(/suppress_upstream_hops/)
    await expect(findSuppressingChange('t1', 'ci-1', 1, 'ieri')).rejects.toThrow(/not an ISO date/)
    onCypher([[Q.suppressing, []]])
    await expect(findSuppressingChange('t1', 'ci-1', 1, NOW)).resolves.toBeNull()
  })

  // ── Revisione 2 · ondata 3: regole di dominio condivise ────────────────────

  it('B2-11: un allarme silenziato che oscilla resta suppressed — la change si cerca PRIMA del rilevamento, niente flapping né salute', async () => {
    // 6 passaggi negli ultimi 10 minuti: ben oltre la soglia (4 in 10).
    const oscillante = [minutesAgo(9), minutesAgo(8), minutesAgo(6), minutesAgo(4), minutesAgo(2), minutesAgo(1)]
    expect(isFlapping(oscillante, policy(), NOW)).toBe(true)
    onCypher([...baseRules({ transitions: oscillante }), [Q.suppressing, windows({ changeId: 'chg-1', code: 'CHG1', step: 'deployment' })]])
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out).toEqual({ outcome: 'suppressed', status: 'suppressed', suppressedByChangeId: 'chg-1', incidentId: null })
    expect(callMatching(Q.flap)).toBeUndefined()
    expect(recomputeCIHealth).not.toHaveBeenCalled()
    expect(published()).toEqual(['event.suppressed'])
    expect(metrics.eventsFlappingTotal.inc).not.toHaveBeenCalled()
    // I passaggi restano registrati (servono alla fine della finestra), ma non producono flapping
    expect(callMatching(Q.load)!.params).toMatchObject({ eventId: 'ev-1' })
  })

  it('B2-11: un allarme GIÀ flapping che entra in finestra di change viene silenziato (la soppressione vince), senza toccare la salute', async () => {
    onCypher([...baseRules({ status: 'flapping', flapping_since: minutesAgo(5), correlation: 'flapping', transitions: [minutesAgo(3)] }),
      [Q.suppressing, windows({ changeId: 'chg-1', code: 'CHG1', step: 'deployment' })]])
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, mode: 'reevaluate' })
    expect(out).toEqual({ outcome: 'suppressed', status: 'suppressed', suppressedByChangeId: 'chg-1', incidentId: null })
    expect(recomputeCIHealth).not.toHaveBeenCalled()
  })

  it('B2-11: un rientro normale non paga la ricerca della change; un rientro che OSCILLA in finestra la cerca — e non sfarfalla, ma nemmeno viene silenziato (il rientro deve poter chiudere il suo incident)', async () => {
    onCypher(baseRules({ status: 'resolved' }))
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(callMatching(Q.suppressing)).toBeUndefined()

    // Il payload `resolved` dell'oscillazione: senza la guardia entrerebbe in
    // flapping proprio dentro la finestra (è la metà «spenta» dell'altalena).
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    vi.mocked(trackSourceStorm).mockResolvedValue(NO_STORM)
    const oscillante = [minutesAgo(9), minutesAgo(8), minutesAgo(6), minutesAgo(4), minutesAgo(2), minutesAgo(1)]
    onCypher([...baseRules({ status: 'resolved', transitions: oscillante }), [Q.suppressing, windows({ changeId: 'chg-1', code: 'CHG1', step: 'deployment' })]])
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(callMatching(Q.suppressing)).toBeDefined()
    expect(callMatching(Q.flap)).toBeUndefined()
    expect(callMatching(Q.suppress)).toBeUndefined()
    expect(out.status).toBe('resolved')
  })

  it('B2-12/B2-13: la query batch condivisa — piani del CI toccato, relazioni tecniche a monte, la prima candidata in finestra vince', async () => {
    // pickChangeWindow: le righe arrivano ordinate (diretta prima), si prende la prima davvero in finestra
    const past = JSON.stringify([{ releaseWindow: { start: '2026-09-08T09:00:00Z', end: '2026-09-08T11:00:00Z' } }])
    const now = JSON.stringify([{ releaseWindow: { start: '2026-09-09T09:00:00Z', end: '2026-09-09T11:00:00Z' } }])
    const row = (over: Record<string, unknown>) => ({ changeId: 'c', code: 'CHG', step: 'scheduled', plans: [], viaCiId: 'ci-1', viaCiName: 'ci-1', upstream: false, ...over })
    const WIN = { implementation: ['deployment'], planned: ['scheduled'], all: ['deployment', 'scheduled'] }
    expect(pickChangeWindow([row({ plans: [past] })], Date.parse(NOW), WIN)).toBeNull()
    expect(pickChangeWindow([row({ changeId: 'c1', plans: [past] }), row({ changeId: 'c2', plans: [now] })], Date.parse(NOW), WIN)?.changeId).toBe('c2')
    // B2-13: la copertura può venire da un CI a monte, e si vede
    const upstream = pickChangeWindow([row({ changeId: 'c3', step: 'deployment', viaCiId: 'srv-1', viaCiName: 'SRV-01', upstream: true })], Date.parse(NOW), WIN)
    expect(upstream).toEqual({ changeId: 'c3', code: 'CHG', step: 'deployment', viaCiId: 'srv-1', viaCiName: 'SRV-01', upstream: true })

    // B2-12: i piani sono filtrati per CI toccato; B2-13: le relazioni sono quelle dei servizi
    onCypher([[Q.suppressing, [
      { ciId: 'vm-1', changes: [{ changeId: 'chg-srv', code: 'CHG-9', step: 'deployment', plans: [], viaCiId: 'srv-1', viaCiName: 'SRV-01', upstream: true }] },
      { ciId: 'vm-2', changes: [] },
    ]]])
    const map = await changeWindowsForCIs(session as never, 't1', ['vm-1', 'vm-2'], 2, NOW)
    expect([...map.keys()]).toEqual(['vm-1'])
    expect(map.get('vm-1')).toMatchObject({ changeId: 'chg-srv', viaCiId: 'srv-1', upstream: true })
    const q = callMatching(Q.suppressing)!
    expect(q.cypher).toContain('WHERE dp.ci_id = target.id')
    expect(q.cypher).toContain('[rel:DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE*1..2]')
    expect(q.cypher).toContain('ORDER BY dist, CASE WHEN wi.current_step IN $implementationSteps THEN 0 ELSE 1 END, c.created_at')
    expect(q.params).toMatchObject({ ciIds: ['vm-1', 'vm-2'], tenantId: 't1', windowSteps: ['deployment', 'scheduled'], implementationSteps: ['deployment'] })
    // nessun CI → nessuna query
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    expect((await changeWindowsForCIs(session as never, 't1', [], 1, NOW)).size).toBe(0)
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('D6.3: allarme su un CI con ciclo di vita ignorato dalla policy → skipped_lifecycle, nessuna salute, nessun incident, nessuna tempesta', async () => {
    onCypher([...baseRules(), [Q.load, { props: props(), ciId: 'ci-1', ciStatus: 'decommissioned' }]])
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out).toEqual({ outcome: 'skipped_lifecycle', status: 'firing', suppressedByChangeId: null, incidentId: null })
    const set = callMatching(Q.setCorr)!
    expect(set.params).toMatchObject({ eventId: 'ev-1', tenantId: 't1', correlation: 'skipped_lifecycle', now: NOW, dueAt: null })
    expect(recomputeCIHealth).not.toHaveBeenCalled()
    expect(callMatching(Q.suppressing)).toBeUndefined()
    expect(callMatching(Q.group)).toBeUndefined()
    expect(incidentService.createIncident).not.toHaveBeenCalled()
    expect(trackSourceStorm).not.toHaveBeenCalled()
    expect(metrics.eventsCorrelatedTotal.inc).toHaveBeenCalledWith({ outcome: 'skipped_lifecycle' })
  })

  it('D6.3: un ciclo di vita fuori dalla lista della policy non cambia nulla; policy con lista vuota → nessuno stato ignorato', async () => {
    onCypher([...baseRules(), [Q.load, { props: props(), ciId: 'ci-1', ciStatus: 'active' }]])
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).outcome).toBe('opened')

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    vi.mocked(trackSourceStorm).mockResolvedValue(NO_STORM)
    vi.mocked(getEventPolicy).mockResolvedValue(policy({ ignore_lifecycle_statuses: [] }))
    onCypher([...baseRules(), [Q.load, { props: props(), ciId: 'ci-1', ciStatus: 'decommissioned' }]])
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).outcome).toBe('opened')
  })

  it('D6.3: l\'esito skipped_lifecycle è nel vocabolario condiviso (console e web lo mostrano)', () => {
    expect(CORRELATION_OUTCOMES).toContain('skipped_lifecycle')
  })
})

// ── 3–4. Soglia e orfano ─────────────────────────────────────────────────────

describe('soglia e orfano', () => {
  it('warning con soglia critical → skipped_severity, ma la salute del CI è aggiornata; nessun incident', async () => {
    onCypher(baseRules({ severity: 'warning' }))
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out).toEqual({ outcome: 'skipped_severity', status: 'firing', suppressedByChangeId: null, incidentId: null })
    expect(recomputeCIHealth).toHaveBeenCalledWith('t1', 'ci-1', 'monitoring')
    expect(callMatching(Q.setCorr)!.params).toMatchObject({ correlation: 'skipped_severity', now: NOW, dueAt: null })
    expect(incidentService.createIncident).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('open_incident_from = never → skipped_severity anche per critical', async () => {
    vi.mocked(getEventPolicy).mockResolvedValue(policy({ open_incident_from: 'never' }))
    onCypher(baseRules())
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).outcome).toBe('skipped_severity')
  })

  it('evento orfano → skipped_orphan: nessuna ricerca di change, nessuna salute, nessun incident', async () => {
    onCypher(baseRules({}, null))
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out.outcome).toBe('skipped_orphan')
    expect(callMatching(Q.suppressing)).toBeUndefined()
    expect(recomputeCIHealth).not.toHaveBeenCalled()
    expect(callMatching(Q.setCorr)!.params['correlation']).toBe('skipped_orphan')
    expect(incidentService.createIncident).not.toHaveBeenCalled()
  })

  it('evento inesistente → NotFound; severità corrotta → errore esplicito', async () => {
    onCypher([[Q.load, null]])
    await expect(runEventPipeline({ tenantId: 't1', eventId: 'ev-x', now: NOW })).rejects.toThrow(/Event ev-x not found/)
    onCypher(baseRules({ severity: 'fatal' }))
    await expect(runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).rejects.toThrow(/invalid severity "fatal"/)
  })
})

// ── 5. Ritardo ───────────────────────────────────────────────────────────────

describe('ritardo (open_delay_seconds)', () => {
  it('delay 30s su evento mai correlato → delayed con correlation_due_at = now + 30s e job accodato con la scadenza; nessun incident', async () => {
    vi.mocked(getEventPolicy).mockResolvedValue(policy({ open_delay_seconds: 30 }))
    onCypher(baseRules())
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out.outcome).toBe('delayed')
    const due = '2026-09-09T10:00:30.000Z'
    expect(callMatching(Q.setCorr)!.params).toMatchObject({ correlation: 'delayed', dueAt: due })
    expect(enqueueCorrelation).toHaveBeenCalledWith('t1', 'ev-1', due)
    expect(recomputeCIHealth).toHaveBeenCalled()   // la salute non aspetta
    expect(incidentService.createIncident).not.toHaveBeenCalled()
    expect(callMatching(Q.group)).toBeUndefined()
  })

  it('ripetizione durante l\'attesa → stessa scadenza (stesso job id), nessun secondo ritardo', async () => {
    vi.mocked(getEventPolicy).mockResolvedValue(policy({ open_delay_seconds: 30 }))
    onCypher(baseRules({ correlation: 'delayed', correlation_due_at: '2026-09-09T10:00:20.000Z' }))
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(enqueueCorrelation).toHaveBeenCalledWith('t1', 'ev-1', '2026-09-09T10:00:20.000Z')
  })

  it('evento già correlato in passato (nuovo ciclo) → nessun ritardo, va al raggruppamento', async () => {
    vi.mocked(getEventPolicy).mockResolvedValue(policy({ open_delay_seconds: 30 }))
    onCypher([...baseRules(), [Q.ever, { n: 1 }]])
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).outcome).toBe('opened')
    expect(enqueueCorrelation).not.toHaveBeenCalled()
  })

  it('alla scadenza (mode resume): ancora firing → prosegue dal raggruppamento senza soppressione né salute; risolto nel frattempo → correlation none', async () => {
    onCypher(baseRules({ correlation: 'delayed', correlation_due_at: NOW }))
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, mode: 'resume' })
    expect(out.outcome).toBe('opened')
    expect(callMatching(Q.suppressing)).toBeUndefined()
    expect(recomputeCIHealth).not.toHaveBeenCalled()
    expect(enqueueCorrelation).not.toHaveBeenCalled()

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher(baseRules({ status: 'resolved', correlation: 'delayed', correlation_due_at: NOW }))
    const resolved = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, mode: 'resume' })
    expect(resolved).toEqual({ outcome: 'none', status: 'resolved', suppressedByChangeId: null, incidentId: null })
    expect(callMatching(Q.setCorr)!.params['correlation']).toBe('none')
    expect(incidentService.createIncident).not.toHaveBeenCalled()
    expect(incidentService.resolveIncident).not.toHaveBeenCalled()
  })

  it('mode reevaluate (mutation / linkEventToCI) → nessun ritardo anche con delay > 0', async () => {
    vi.mocked(getEventPolicy).mockResolvedValue(policy({ open_delay_seconds: 30 }))
    onCypher(baseRules())
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, mode: 'reevaluate' })).outcome).toBe('opened')
    expect(enqueueCorrelation).not.toHaveBeenCalled()
  })
})

// ── 6. Raggruppamento ────────────────────────────────────────────────────────

describe('raggruppamento per CI', () => {
  it('incident aperto già correlato sul CI → aggancio (MERGE CORRELATED_INTO), commento in timeline, attached, event.correlated', async () => {
    onCypher([...baseRules(), [Q.group, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'in_progress' }]])
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out).toEqual({ outcome: 'attached', status: 'firing', suppressedByChangeId: null, incidentId: 'inc-1' })

    const g = callMatching(Q.group)!
    expect(g.cypher).toContain('MATCH (e:Event {id: $eventId, tenant_id: $tenantId})-[:RAISED_ON]->(ci:ConfigurationItem {tenant_id: $tenantId})')
    expect(g.cypher).toContain('MATCH (other:Event {tenant_id: $tenantId})-[:RAISED_ON]->(ci)')
    expect(g.params).toMatchObject({ eventId: 'ev-1', tenantId: 't1', terminalSteps: ['closed'], resolvedStep: 'resolved' })
    const a = callMatching(Q.attach)!
    expect(a.cypher).toContain('MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})')
    expect(a.params).toMatchObject({ eventId: 'ev-1', incidentId: 'inc-1', manual: false, now: NOW })
    expect(incidentService.addIncidentComment).toHaveBeenCalledWith('inc-1', MON, 'Allarme correlato: DiskFull, critical, ricorrenze 3')
    expect(incidentService.createIncident).not.toHaveBeenCalled()
    expect(workflowEngine.transition).not.toHaveBeenCalled()
    expect(callMatching(Q.setCorr)!.params['correlation']).toBe('attached')
    expect(publishEvent).toHaveBeenCalledWith('event.correlated', 't1', 'monitoring', expect.objectContaining({ id: 'ev-1', incident_id: 'inc-1', outcome: 'attached', ci_id: 'ci-1' }), NOW)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ userId: 'monitoring' }), 'event.attached', 'Event', 'ev-1', expect.objectContaining({ incidentId: 'inc-1' }))
  })

  it('evento già agganciato che si ripete → attached senza un nuovo commento', async () => {
    onCypher([...baseRules(), [Q.group, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'in_progress' }], [Q.attach, { created: false }]])
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).outcome).toBe('attached')
    expect(incidentService.addIncidentComment).not.toHaveBeenCalled()
  })

  it('group_by fingerprint → cerca l\'incident correlato a QUESTO evento (stessa impronta = stesso nodo)', async () => {
    vi.mocked(getEventPolicy).mockResolvedValue(policy({ group_by: 'fingerprint' }))
    onCypher([...baseRules(), [Q.group, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'assigned' }]])
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    const g = callMatching(Q.group)!
    expect(g.cypher).toContain('MATCH (e:Event {id: $eventId, tenant_id: $tenantId})-[:CORRELATED_INTO]->(i:Incident {tenant_id: $tenantId})')
    expect(g.cypher).not.toContain('RAISED_ON')
  })

  it('incident correlato in resolved → riapertura con la transizione "Riapri" (resolved → in_progress) via motore, notes "Allarme tornato", commento, incident.in_progress, reopened', async () => {
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'closed', label: 'x' }, { toStep: 'in_progress', label: 'Riapri', requiresInput: true, inputField: 'notes' }] as never)
    onCypher([...baseRules(), [Q.group, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'resolved' }]])
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out).toMatchObject({ outcome: 'reopened', incidentId: 'inc-1' })
    expect(workflowEngine.getAvailableTransitions).toHaveBeenCalledWith(session, 'wi-1', 't1')
    expect(workflowEngine.transition).toHaveBeenCalledWith(
      session,
      { instanceId: 'wi-1', toStepName: 'in_progress', triggeredBy: 'monitoring', triggerType: 'manual', notes: 'Allarme tornato: DiskFull (db-01)', tenantId: 't1' },
      { userId: 'monitoring', notes: 'Allarme tornato: DiskFull (db-01)', entityData: {} },
    )
    expect(incidentService.addIncidentComment).toHaveBeenCalledWith('inc-1', MON, 'Workflow: in_progress — Allarme tornato: DiskFull (db-01)')
    expect(incidentService.publishIncidentTransition).toHaveBeenCalledWith('inc-1', 'in_progress', MON)
    expect(callMatching(Q.attach)!.params['incidentId']).toBe('inc-1')
    expect(callMatching(Q.setCorr)!.params['correlation']).toBe('reopened')
    expect(incidentService.createIncident).not.toHaveBeenCalled()
    expect(publishEvent).toHaveBeenCalledWith('event.correlated', 't1', 'monitoring', expect.objectContaining({ outcome: 'reopened', incident_id: 'inc-1' }), NOW)
  })

  it('riapertura su un workflow RINOMINATO: il bersaglio si sceglie per categoria «active», non per il nome in_progress (ondata 4 · A4-3)', async () => {
    // Il cliente ha rinominato i passi: `presa_in_carico` e `lavorazione` sono
    // i suoi passi attivi. Il nome `in_progress` non esiste più.
    vi.mocked(getWorkflowSteps).mockResolvedValue([
      { name: 'nuovo',           isInitial: true,  isTerminal: false, isOpen: true,  category: 'active',   stepOrder: 1 },
      { name: 'presa_in_carico', isInitial: false, isTerminal: false, isOpen: true,  category: 'active',   stepOrder: 2 },
      { name: 'lavorazione',     isInitial: false, isTerminal: false, isOpen: true,  category: 'active',   stepOrder: 3 },
      { name: 'sospeso',         isInitial: false, isTerminal: false, isOpen: true,  category: 'waiting',  stepOrder: 4 },
      { name: 'risolto',         isInitial: false, isTerminal: false, isOpen: true,  category: 'resolved', stepOrder: 5 },
      { name: 'chiuso',          isInitial: false, isTerminal: true,  isOpen: false, category: 'closed',   stepOrder: 6 },
    ])
    // Da «risolto» si può solo riaprire in «lavorazione» (e chiudere).
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'chiuso' }, { toStep: 'lavorazione', label: 'Riapri' }] as never)
    onCypher([...baseRules(), [Q.group, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'risolto' }]])
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out).toMatchObject({ outcome: 'reopened', incidentId: 'inc-1' })
    expect(workflowEngine.transition).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ toStepName: 'lavorazione', triggerType: 'manual' }),
      expect.anything(),
    )

    // Nessuna transizione verso un passo «active» → errore che lo dice, senza
    // ripiegare sul «primo passo non terminale» (era un fallback silenzioso).
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'sospeso' }] as never)
    onCypher([...baseRules(), [Q.group, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'risolto' }]])
    await expect(runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW }))
      .rejects.toThrow(/no manual transition out of "risolto" leads to a step with category "active"\/"escalated"/)
  })

  it('riapertura: nessuna transizione manuale da resolved o transizione fallita → errore (nessun fallback), evento non marcato', async () => {
    onCypher([...baseRules(), [Q.group, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'resolved' }]])
    await expect(runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).rejects.toThrow(/no manual transition out of "resolved"/)
    expect(callMatching(Q.setCorr)).toBeUndefined()

    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'in_progress' }] as never)
    vi.mocked(workflowEngine.transition).mockResolvedValue({ success: false, error: 'guard' } as never)
    await expect(runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).rejects.toThrow(/reopen transition to "in_progress" failed: guard/)
    expect(incidentService.addIncidentComment).not.toHaveBeenCalled()
  })

  it('nessun incident → apertura con attore monitoring, CI impattato, priorità/impatto/urgenza dalla policy, CORRELATED_INTO manual=false, opened', async () => {
    onCypher(baseRules({ description: 'dettaglio' }))
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out).toEqual({ outcome: 'opened', status: 'firing', suppressedByChangeId: null, incidentId: 'inc-new' })
    expect(incidentService.createIncident).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'DiskFull', severity: 'critical', impact: 'high', urgency: 'high', affectedCIIds: ['ci-1'] }),
      { tenantId: 't1', userId: 'monitoring' },
    )
    const desc = vi.mocked(incidentService.createIncident).mock.calls[0]![0].description!
    expect(desc).toContain('Evento di monitoraggio: DiskFull')
    expect(desc).toContain('Risorsa: db-01 (hostname)')
    expect(desc).toContain('Occorrenze: 3')
    expect(desc).toContain('dettaglio')
    expect(callMatching(Q.attach)!.params).toMatchObject({ eventId: 'ev-1', incidentId: 'inc-new', manual: false })
    expect(callMatching(Q.setCorr)!.params['correlation']).toBe('opened')
    expect(published()).toEqual(['event.correlated'])
    expect(vi.mocked(publishEvent).mock.calls[0]![3]).toMatchObject({ incident_id: 'inc-new', outcome: 'opened' })
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ userId: 'monitoring' }), 'event.opened', 'Event', 'ev-1', expect.objectContaining({ incidentId: 'inc-new' }))
  })

  it('(1.16) allarme già correlato a un incident CHIUSO → nuovo incident e commento di tracciabilità sull\'incident chiuso con il numero del nuovo; nessun incident chiuso → nessun commento', async () => {
    onCypher([...baseRules(), [Q.closedPrev, { incidentId: 'inc-old' }]])
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out).toMatchObject({ outcome: 'opened', incidentId: 'inc-new' })
    const q = callMatching(Q.closedPrev)!
    expect(q.cypher).toContain('MATCH (e:Event {id: $eventId, tenant_id: $tenantId})-[:CORRELATED_INTO]->(i:Incident {tenant_id: $tenantId})')
    expect(q.cypher).toContain('MATCH (i)-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId})')
    expect(q.params).toEqual({ eventId: 'ev-1', tenantId: 't1', terminalSteps: ['closed'], resolvedStep: 'resolved', openedId: 'inc-new' })
    expect(incidentService.addIncidentComment).toHaveBeenCalledTimes(1)
    expect(incidentService.addIncidentComment).toHaveBeenCalledWith('inc-old', MON, 'Allarme tornato dopo la chiusura: DiskFull (db-01) — aperto INC00000009')
    // la query gira solo quando si apre un incident nuovo, dopo l'apertura
    const order = calls().map((c) => (Q.closedPrev.test(c.cypher) ? 'closedPrev' : Q.attach.test(c.cypher) ? 'attach' : null)).filter(Boolean)
    expect(order).toEqual(['attach', 'closedPrev'])

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    vi.mocked(incidentService.createIncident).mockResolvedValue({ id: 'inc-new', number: 'INC00000009' } as never)
    onCypher(baseRules())
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).outcome).toBe('opened')
    expect(incidentService.addIncidentComment).not.toHaveBeenCalled()

    // aggancio a un incident aperto: nessuna ricerca dei chiusi
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([...baseRules(), [Q.group, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'in_progress' }]])
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(callMatching(Q.closedPrev)).toBeUndefined()
  })

  it('workflow incident senza passo resolved → errore esplicito', async () => {
    vi.mocked(getWorkflowSteps).mockResolvedValue([{ name: 'new', isInitial: true, isTerminal: false, isOpen: true, category: null, stepOrder: 1 }])
    onCypher(baseRules())
    await expect(runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).rejects.toThrow(/no step with category "resolved"/)
  })
})

// ── Apertura condivisa ───────────────────────────────────────────────────────

describe('openIncidentFromEvent', () => {
  it('orfano → ValidationError (BAD_USER_INPUT) senza creare nulla; warning → severity medium con impact/urgency medium; manual=true sulla relazione', async () => {
    const err = await openIncidentFromEvent({ tenantId: 't1', props: props(), ciId: null, actorId: 'op-1', manual: true }).then(() => null, (e: unknown) => e as GraphQLError)
    expect(err).toBeInstanceOf(GraphQLError)
    expect(err!.extensions['code']).toBe('BAD_USER_INPUT')
    expect(err!.message).toMatch(/orfano.*linkEventToCI/)
    expect(incidentService.createIncident).not.toHaveBeenCalled()

    onCypher([[Q.attach, { created: true }], [Q.setCorr, null]])
    const inc = await openIncidentFromEvent({ tenantId: 't1', props: props({ severity: 'warning' }), ciId: 'ci-1', actorId: 'op-1', manual: true, now: NOW })
    expect(inc).toMatchObject({ id: 'inc-new' })
    expect(incidentService.createIncident).toHaveBeenCalledWith(expect.objectContaining({ severity: 'medium', impact: 'medium', urgency: 'medium' }), { tenantId: 't1', userId: 'op-1' })
    expect(callMatching(Q.attach)!.params).toMatchObject({ manual: true, now: NOW })
    expect(callMatching(Q.setCorr)!.params['correlation']).toBe('opened')
  })
})

// ── 7. Chiusura automatica ───────────────────────────────────────────────────

describe('chiusura automatica', () => {
  const linkedRow = (over: Record<string, unknown> = {}) => ({ incidentId: 'inc-1', instanceId: 'wi-1', step: 'in_progress', stillFiring: 0, ...over })

  it('evento resolved, tutti i correlati risolti, auto_resolve on, arco verso resolved disponibile → resolveIncident con la causa, commento, auto_resolved', async () => {
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'pending' }, { toStep: 'resolved', inputField: 'rootCause' }] as never)
    onCypher([...baseRules({ status: 'resolved', correlation: 'attached' }), [Q.linked, linkedRow()]])
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, actorId: 'am' })
    expect(out).toEqual({ outcome: 'auto_resolved', status: 'resolved', suppressedByChangeId: null, incidentId: 'inc-1' })
    expect(recomputeCIHealth).toHaveBeenCalledWith('t1', 'ci-1', 'am')
    expect(callMatching(Q.suppressing)).toBeUndefined()   // un evento risolto non si sopprime
    const l = callMatching(Q.linked)!
    // 1.18: "ancora acceso" = firing o flapping; i suppressed (e i resolved) non tengono aperto l'incident
    expect(l.cypher).toContain('WHERE other.status IN $firingStatuses')
    expect(l.cypher).not.toContain("other.status <> 'resolved'")
    expect(l.params).toMatchObject({ eventId: 'ev-1', tenantId: 't1', terminalSteps: ['closed'], firingStatuses: ['firing', 'flapping'] })
    // 1.19: tutti gli incident non terminali collegati, dal più recente (nessun LIMIT 1)
    expect(l.cypher).toContain('ORDER BY createdAt DESC')
    expect(l.cypher).not.toMatch(/LIMIT 1/)
    // conteggio dei silenziati con il codice della change che li silenzia
    expect(l.cypher).toContain("OPTIONAL MATCH (s:Event {tenant_id: $tenantId, status: 'suppressed'})-[:CORRELATED_INTO]->(i)")
    expect(l.cypher).toContain('collect(DISTINCT coalesce(c.code, c.id)) AS suppressingChanges')
    expect(incidentService.resolveIncident).toHaveBeenCalledWith('inc-1', MON, 'Allarme di monitoraggio rientrato: DiskFull')
    expect(incidentService.addIncidentComment).toHaveBeenCalledWith('inc-1', MON, expect.stringMatching(/^Risolto automaticamente: .*DiskFull/))
    expect(publishEvent).toHaveBeenCalledWith('event.correlated', 't1', 'am', expect.objectContaining({ id: 'ev-1', incident_id: 'inc-1', outcome: 'auto_resolved' }), NOW)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ userId: 'monitoring' }), 'event.auto_resolved', 'Event', 'ev-1', expect.objectContaining({ incidentId: 'inc-1' }))
  })

  it('un evento correlato ancora firing → non risolve (none)', async () => {
    onCypher([...baseRules({ status: 'resolved' }), [Q.linked, linkedRow({ stillFiring: 1 })]])
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out).toMatchObject({ outcome: 'none', incidentId: 'inc-1' })
    expect(incidentService.resolveIncident).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('(1.18) allarmi silenziati da una change non tengono aperto l\'incident: si risolve e UN commento "N allarmi silenziati da CHG-…" precede quello di chiusura; una sola volta (il rientro successivo trova l\'incident risolto → none)', async () => {
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'resolved', inputField: 'rootCause' }] as never)
    onCypher([...baseRules({ status: 'resolved' }), [Q.linked, linkedRow({ stillFiring: 0, suppressed: 2, suppressingChanges: ['CHG-0007', 'CHG-0009'] })]])
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out).toMatchObject({ outcome: 'auto_resolved', incidentId: 'inc-1' })
    expect(incidentService.resolveIncident).toHaveBeenCalledTimes(1)
    const comments = vi.mocked(incidentService.addIncidentComment).mock.calls.map((c) => c[2])
    expect(comments).toHaveLength(2)
    expect(comments[0]).toBe('2 allarmi di monitoraggio silenziati da CHG-0007, CHG-0009 restano in finestra di change: non tengono aperto l\'incident; a fine finestra vengono rivalutati e, se ancora accesi, lo riaprono')
    expect(comments[1]).toMatch(/^Risolto automaticamente/)
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'event.auto_resolved', 'Event', 'ev-1', expect.objectContaining({ suppressed: 2 }))

    // rientro successivo: l'incident è in resolved → none, nessun altro commento
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([...baseRules({ status: 'resolved' }), [Q.linked, linkedRow({ step: 'resolved', stillFiring: 0, suppressed: 2, suppressingChanges: ['CHG-0007'] })]])
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).outcome).toBe('none')
    expect(incidentService.addIncidentComment).not.toHaveBeenCalled()

    // singolare, senza codice della change (change eliminata): frase al singolare senza "da …"
    expect(suppressedSummary(1, [])).toBe('1 allarme di monitoraggio silenziato resta in finestra di change: non tengono aperto l\'incident; a fine finestra vengono rivalutati e, se ancora accesi, lo riaprono')
    expect(suppressedSummary(0, ['CHG-1'])).toBeNull()
    expect(STILL_FIRING_STATUSES).toEqual(['firing', 'flapping'])
  })

  it('(1.19) evento collegato a DUE incident aperti (tempesta + per CI) → valutati entrambi: uno con altri allarmi accesi resta (none), l\'altro viene risolto; esito auto_resolved con l\'incident risolto', async () => {
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'resolved', inputField: 'rootCause' }] as never)
    onCypher([...baseRules({ status: 'resolved' }), [Q.linked, [
      linkedRow({ incidentId: 'inc-storm', instanceId: 'wi-s', stillFiring: 5 }),   // il più recente: altri allarmi ancora accesi
      linkedRow({ incidentId: 'inc-1', instanceId: 'wi-1', stillFiring: 0 }),
    ]]])
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out).toEqual({ outcome: 'auto_resolved', status: 'resolved', suppressedByChangeId: null, incidentId: 'inc-1' })
    expect(incidentService.resolveIncident).toHaveBeenCalledTimes(1)
    expect(incidentService.resolveIncident).toHaveBeenCalledWith('inc-1', MON, expect.any(String))
    expect(workflowEngine.getAvailableTransitions).toHaveBeenCalledTimes(1)
    expect(workflowEngine.getAvailableTransitions).toHaveBeenCalledWith(session, 'wi-1', 't1')
    expect(publishEvent).toHaveBeenCalledTimes(1)
    expect(publishEvent).toHaveBeenCalledWith('event.correlated', 't1', 'monitoring', expect.objectContaining({ incident_id: 'inc-1', outcome: 'auto_resolved' }), NOW)

    // entrambi risolvibili → entrambi risolti, ognuno con il suo event.correlated; l'esito riporta il più recente
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'resolved', inputField: 'rootCause' }] as never)
    onCypher([...baseRules({ status: 'resolved' }), [Q.linked, [
      linkedRow({ incidentId: 'inc-2', instanceId: 'wi-2', stillFiring: 0 }),
      linkedRow({ incidentId: 'inc-1', instanceId: 'wi-1', stillFiring: 0 }),
    ]]])
    const both = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(both).toMatchObject({ outcome: 'auto_resolved', incidentId: 'inc-2' })
    expect(vi.mocked(incidentService.resolveIncident).mock.calls.map((c) => c[0])).toEqual(['inc-2', 'inc-1'])
    expect(vi.mocked(publishEvent).mock.calls.map((c) => (c[3] as { incident_id: string }).incident_id)).toEqual(['inc-2', 'inc-1'])

    // nessuno risolvibile (entrambi con allarmi accesi) → none con il più recente
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([...baseRules({ status: 'resolved' }), [Q.linked, [linkedRow({ incidentId: 'inc-2', stillFiring: 1 }), linkedRow({ incidentId: 'inc-1', stillFiring: 3 })]]])
    expect(await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).toMatchObject({ outcome: 'none', incidentId: 'inc-2' })
    expect(incidentService.resolveIncident).not.toHaveBeenCalled()
  })

  it('auto_resolve = false → non risolve, anche con tutti gli allarmi rientrati', async () => {
    vi.mocked(getEventPolicy).mockResolvedValue(policy({ auto_resolve: false }))
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'resolved' }] as never)
    onCypher([...baseRules({ status: 'resolved' }), [Q.linked, linkedRow()]])
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).outcome).toBe('none')
    expect(incidentService.resolveIncident).not.toHaveBeenCalled()
    expect(incidentService.addIncidentComment).not.toHaveBeenCalled()
  })

  it('incident già resolved o senza incident correlato aperto → none senza toccare nulla', async () => {
    onCypher([...baseRules({ status: 'resolved' }), [Q.linked, linkedRow({ step: 'resolved' })]])
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).outcome).toBe('none')
    onCypher([...baseRules({ status: 'resolved' }), [Q.linked, null]])
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).outcome).toBe('none')
    expect(incidentService.resolveIncident).not.toHaveBeenCalled()
  })

  it('incident in "in_progress" con arco diretto → risolve subito, senza leggere la definizione né passi intermedi', async () => {
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'resolved', inputField: 'rootCause' }] as never)
    onCypher([...baseRules({ status: 'resolved' }), [Q.linked, linkedRow({ step: 'in_progress' })]])
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).outcome).toBe('auto_resolved')
    expect(callMatching(Q.defTr)).toBeUndefined()
    expect(workflowEngine.transition).not.toHaveBeenCalled()
    expect(incidentService.publishIncidentTransition).not.toHaveBeenCalled()
    expect(incidentService.resolveIncident).toHaveBeenCalledTimes(1)
  })

  it('incident in "new" con il workflow seed → percorre tr-new-assigned e tr-assigned-inprogress (nell\'ordine, con note, evento incident.<step> ma SENZA un commento per passo) e poi risolve → auto_resolved con UN commento riassuntivo del cammino', async () => {
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'assigned', label: 'Assegna' }] as never)
    onCypher([...baseRules({ status: 'resolved' }), [Q.linked, linkedRow({ step: 'new' })], [Q.defTr, SEED_TRANSITIONS]])
    const order: string[] = []
    vi.mocked(workflowEngine.transition).mockImplementation((async (_s: unknown, input: { toStepName: string }) => { order.push(`transition:${input.toStepName}`); return { success: true } }) as never)
    vi.mocked(incidentService.resolveIncident).mockImplementation((async () => { order.push('resolveIncident'); return { id: 'inc-1' } }) as never)
    vi.mocked(incidentService.addIncidentComment).mockImplementation((async (_id: string, _c: unknown, text: string) => { order.push(`comment:${text.split(' — ')[0]}`) }) as never)

    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out).toEqual({ outcome: 'auto_resolved', status: 'resolved', suppressedByChangeId: null, incidentId: 'inc-1' })
    expect(callMatching(Q.defTr)!.params).toEqual({ instanceId: 'wi-1', tenantId: 't1' })
    expect(order).toEqual([
      'transition:assigned',
      'transition:in_progress',
      'resolveIncident',
      'comment:Risolto automaticamente: tutti gli allarmi di monitoraggio correlati sono rientrati (ultimo: DiskFull)',
    ])
    expect(incidentService.addIncidentComment).toHaveBeenCalledTimes(1)
    expect(incidentService.addIncidentComment).toHaveBeenCalledWith('inc-1', MON, 'Risolto automaticamente: tutti gli allarmi di monitoraggio correlati sono rientrati (ultimo: DiskFull) — passando per Assegnato, In Lavorazione')
    expect(workflowEngine.transition).toHaveBeenNthCalledWith(1, session,
      { instanceId: 'wi-1', toStepName: 'assigned', triggeredBy: 'monitoring', triggerType: 'manual', notes: 'Chiusura automatica dal monitoraggio: passaggio a Assegnato', tenantId: 't1' },
      { userId: 'monitoring', notes: 'Chiusura automatica dal monitoraggio: passaggio a Assegnato', entityData: {} })
    expect(workflowEngine.transition).toHaveBeenNthCalledWith(2, session,
      expect.objectContaining({ toStepName: 'in_progress', triggerType: 'manual', notes: 'Chiusura automatica dal monitoraggio: passaggio a In Lavorazione' }),
      expect.objectContaining({ userId: 'monitoring' }))
    expect(vi.mocked(incidentService.publishIncidentTransition).mock.calls).toEqual([['inc-1', 'assigned', MON], ['inc-1', 'in_progress', MON]])
    expect(incidentService.resolveIncident).toHaveBeenCalledWith('inc-1', MON, 'Allarme di monitoraggio rientrato: DiskFull')
    expect(publishEvent).toHaveBeenCalledWith('event.correlated', 't1', 'monitoring', expect.objectContaining({ outcome: 'auto_resolved', incident_id: 'inc-1' }), NOW)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ userId: 'monitoring' }), 'event.auto_resolved', 'Event', 'ev-1', expect.objectContaining({ incidentStep: 'new', path: ['assigned', 'in_progress'] }))
  })

  it('definizione senza cammino (archi solo con condizioni non soddisfabili) → commento esplicativo, auto_resolve_skipped, nessuna transizione', async () => {
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'assigned' }] as never)
    onCypher([...baseRules({ status: 'resolved' }), [Q.linked, linkedRow({ step: 'new' })], [Q.defTr, [
      tr('new', 'assigned', { condition: 'assignee != null' }),
      tr('assigned', 'in_progress'),
      tr('in_progress', 'resolved', { condition: 'rootCause != null' }),
    ]]])
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out).toMatchObject({ outcome: 'auto_resolve_skipped', incidentId: 'inc-1' })
    expect(incidentService.resolveIncident).not.toHaveBeenCalled()
    expect(workflowEngine.transition).not.toHaveBeenCalled()
    expect(incidentService.publishIncidentTransition).not.toHaveBeenCalled()
    expect(incidentService.addIncidentComment).toHaveBeenCalledWith('inc-1', MON, expect.stringMatching(/rientrati.*"new".*non può essere risolto automaticamente/))
    expect(publishEvent).toHaveBeenCalledWith('event.correlated', 't1', 'monitoring', expect.objectContaining({ outcome: 'auto_resolve_skipped' }), NOW)
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'event.auto_resolve_skipped', 'Event', 'ev-1', expect.objectContaining({ path: null }))
  })

  it('cammino più lungo di AUTO_RESOLVE_MAX_HOPS passi intermedi → auto_resolve_skipped; entro il limite → percorso', async () => {
    // new → s1 → s2 → s3 → s4 → s5 → resolved: 5 passi intermedi
    const chain = ['new', 's1', 's2', 's3', 's4', 's5', 'resolved']
    const long = chain.slice(0, -1).map((from, i) => tr(from, chain[i + 1]!))
    onCypher([...baseRules({ status: 'resolved' }), [Q.linked, linkedRow({ step: 'new' })], [Q.defTr, long]])
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).outcome).toBe('auto_resolve_skipped')
    expect(workflowEngine.transition).not.toHaveBeenCalled()

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    vi.mocked(workflowEngine.transition).mockResolvedValue({ success: true } as never)
    // scorciatoia s2 → s5: il cammino più corto diventa new→s1→s2→s5 (3 passi intermedi) e resolved è raggiungibile da s5
    onCypher([...baseRules({ status: 'resolved' }), [Q.linked, linkedRow({ step: 'new' })], [Q.defTr, [...long, tr('s2', 's5')]]])
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).outcome).toBe('auto_resolved')
    expect(vi.mocked(workflowEngine.transition).mock.calls.map((c) => (c[1] as { toStepName: string }).toStepName)).toEqual(['s1', 's2', 's5'])
    expect(AUTO_RESOLVE_MAX_HOPS).toBe(4)
  })

  it('passo intermedio rifiutato dal motore → errore propagato (il job ritenta): niente resolveIncident, niente esito, niente event.correlated', async () => {
    onCypher([...baseRules({ status: 'resolved' }), [Q.linked, linkedRow({ step: 'new' })], [Q.defTr, SEED_TRANSITIONS]])
    vi.mocked(workflowEngine.transition)
      .mockResolvedValueOnce({ success: true } as never)
      .mockResolvedValueOnce({ success: false, error: 'Transizione concorrente' } as never)
    await expect(runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).rejects.toThrow(/Incident inc-1: auto-resolve transition to "in_progress" failed: Transizione concorrente/)
    expect(workflowEngine.transition).toHaveBeenCalledTimes(2)
    // il primo passo (assigned) è persistito e ha i suoi side effect; il secondo no; nessun commento (arriva solo con la risoluzione)
    expect(vi.mocked(incidentService.publishIncidentTransition).mock.calls).toEqual([['inc-1', 'assigned', MON]])
    expect(incidentService.addIncidentComment).not.toHaveBeenCalled()
    expect(incidentService.resolveIncident).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })
})

describe('findAutoResolvePath (helper puro)', () => {
  it('seed incident: da new → [assigned, in_progress] con etichette; da in_progress/escalated → []; da pending → [in_progress]', () => {
    expect(findAutoResolvePath(SEED_TRANSITIONS, 'new', 'resolved')).toEqual([
      { toStep: 'assigned', toLabel: 'Assegnato', trigger: 'manual' },
      { toStep: 'in_progress', toLabel: 'In Lavorazione', trigger: 'manual' },
    ])
    expect(findAutoResolvePath(SEED_TRANSITIONS, 'in_progress', 'resolved')).toEqual([])
    expect(findAutoResolvePath(SEED_TRANSITIONS, 'escalated', 'resolved')).toEqual([])
    expect(findAutoResolvePath(SEED_TRANSITIONS, 'pending', 'resolved')).toEqual([{ toStep: 'in_progress', toLabel: 'In Lavorazione', trigger: 'manual' }])
    expect(findAutoResolvePath(SEED_TRANSITIONS, 'closed', 'resolved')).toBeNull()
  })

  it('ignora timer/sla_breach e condizioni non soddisfabili; accetta automatic; preferisce l\'arco manuale; niente cicli; resolved mai intermedio', () => {
    // solo timer verso il passo utile → nessun cammino
    expect(findAutoResolvePath([tr('new', 'a', { trigger: 'timer' }), tr('a', 'resolved')], 'new', 'resolved')).toBeNull()
    expect(findAutoResolvePath([tr('new', 'a', { trigger: 'sla_breach' }), tr('a', 'resolved')], 'new', 'resolved')).toBeNull()
    expect(findAutoResolvePath([tr('new', 'a', { condition: 'approved == true' }), tr('a', 'resolved')], 'new', 'resolved')).toBeNull()
    // arco automatico percorribile, con il suo trigger
    expect(findAutoResolvePath([tr('new', 'a', { trigger: 'automatic' }), tr('a', 'resolved')], 'new', 'resolved')).toEqual([{ toStep: 'a', toLabel: null, trigger: 'automatic' }])
    // manuale + sla_breach verso lo stesso passo → manuale
    expect(findAutoResolvePath([tr('new', 'a', { trigger: 'sla_breach' }), tr('new', 'a'), tr('a', 'resolved')], 'new', 'resolved')).toEqual([{ toStep: 'a', toLabel: null, trigger: 'manual' }])
    // ciclo new ⇄ a senza uscita → null, senza loop infinito
    expect(findAutoResolvePath([tr('new', 'a'), tr('a', 'new')], 'new', 'resolved')).toBeNull()
    // resolved → x → … non viene usato come passo intermedio; l'ultimo arco verso resolved può avere la condizione rootCause
    expect(findAutoResolvePath([tr('new', 'resolved', { condition: 'rootCause != null' }), tr('resolved', 'closed')], 'new', 'resolved')).toEqual([])
    expect(findAutoResolvePath([tr('new', 'resolved', { condition: 'closed_by != null' })], 'new', 'resolved')).toBeNull()
    // limite di passi: 4 intermedi ok, 5 no
    const chain = (n: number) => { const names = ['new', ...Array.from({ length: n }, (_, i) => `s${i + 1}`), 'resolved']; return names.slice(0, -1).map((f, i) => tr(f, names[i + 1]!)) }
    expect(findAutoResolvePath(chain(4), 'new', 'resolved')).toHaveLength(4)
    expect(findAutoResolvePath(chain(5), 'new', 'resolved')).toBeNull()
    expect(findAutoResolvePath(chain(5), 'new', 'resolved', 5)).toHaveLength(5)
  })
})

// ── Ondata 4: sfarfallio ─────────────────────────────────────────────────────

describe('sfarfallio', () => {
  /** 4 passaggi negli ultimi 10 minuti: la soglia predefinita (4 in 10) è raggiunta. */
  const FLAPPY = [minutesAgo(9), minutesAgo(6), minutesAgo(3), minutesAgo(1)]

  it('isFlapping / isStable (helper puri): soglia nella finestra, soglia o finestra 0 = spento, stabile dopo N minuti senza passaggi', () => {
    expect(isFlapping(FLAPPY, policy(), NOW)).toBe(true)
    expect(isFlapping(FLAPPY.slice(1), policy(), NOW)).toBe(false)
    expect(isFlapping([minutesAgo(30), ...FLAPPY.slice(1)], policy(), NOW)).toBe(false)   // uno è fuori finestra
    expect(isFlapping(FLAPPY, policy({ flap_threshold: 0 }), NOW)).toBe(false)
    expect(isFlapping(FLAPPY, policy({ flap_window_minutes: 0 }), NOW)).toBe(false)
    expect(() => isFlapping(FLAPPY, policy(), 'ieri')).toThrow(/not an ISO date/)
    expect(isStable([minutesAgo(16)], 15, NOW)).toBe(true)
    expect(isStable([minutesAgo(20), minutesAgo(14)], 15, NOW)).toBe(false)
    expect(isStable([], 15, NOW)).toBe(true)
    expect(CORRELATION_OUTCOMES).toEqual(expect.arrayContaining(['flapping', 'storm', 'storm_no_ci']))
  })

  it('soglia raggiunta all\'ingest → flapping: SET status/flapping_since/correlation, salute ricalcolata (degraded), NESSUN incident né soppressione, event.flapping una volta, metrica', async () => {
    onCypher(baseRules({ transitions: FLAPPY }))
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out).toEqual({ outcome: 'flapping', status: 'flapping', suppressedByChangeId: null, incidentId: null })
    const set = callMatching(Q.flap)!
    expect(set.cypher).toContain('MATCH (e:Event {id: $eventId, tenant_id: $tenantId})')
    expect(set.cypher).toContain("e.correlation = 'flapping', e.correlation_at = $now, e.correlation_due_at = null")
    expect(set.params).toMatchObject({ eventId: 'ev-1', tenantId: 't1', now: NOW })
    expect(recomputeCIHealth).toHaveBeenCalledWith('t1', 'ci-1', 'monitoring')
    // B2-11: la change si cerca PRIMA del rilevamento (qui non ce n'è nessuna,
    // quindi lo sfarfallio procede); nessuna soppressione scritta.
    expect(callMatching(Q.suppressing)).toBeDefined()
    expect(callMatching(Q.suppress)).toBeUndefined()
    expect(callMatching(Q.group)).toBeUndefined()
    expect(incidentService.createIncident).not.toHaveBeenCalled()
    expect(incidentService.addIncidentComment).not.toHaveBeenCalled()   // nessun incident correlato
    expect(trackSourceStorm).not.toHaveBeenCalled()
    expect(published()).toEqual(['event.flapping'])
    expect(vi.mocked(publishEvent).mock.calls[0]![3]).toMatchObject({ id: 'ev-1', status: 'flapping', ci_id: 'ci-1', transitions: 4, window_minutes: 10, flapping_since: NOW, incident_id: null, entity_type: 'event' })
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ userId: 'monitoring' }), 'event.flapping', 'Event', 'ev-1', expect.objectContaining({ transitions: 4, windowMinutes: 10 }))
    expect(metrics.eventsFlappingTotal.inc).toHaveBeenCalledTimes(1)
  })

  it('con un incident già correlato → UN commento "Allarme instabile: N passaggi in M minuti, correlazione sospesa" e incident_id nel payload', async () => {
    onCypher([...baseRules({ transitions: FLAPPY, correlation: 'attached' }), [Q.linkedOpen, { incidentId: 'inc-1' }]])
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out).toMatchObject({ outcome: 'flapping', incidentId: 'inc-1' })
    expect(callMatching(Q.linkedOpen)!.params).toMatchObject({ eventId: 'ev-1', tenantId: 't1', terminalSteps: ['closed'] })
    expect(incidentService.addIncidentComment).toHaveBeenCalledTimes(1)
    expect(incidentService.addIncidentComment).toHaveBeenCalledWith('inc-1', MON, 'Allarme instabile: 4 passaggi in 10 minuti, correlazione sospesa')
    expect(vi.mocked(publishEvent).mock.calls[0]![3]).toMatchObject({ incident_id: 'inc-1' })
    expect(incidentService.resolveIncident).not.toHaveBeenCalled()
  })

  it('sotto soglia (3 passaggi, o 4 di cui uno fuori finestra) → pipeline normale (opened), nessun flapping', async () => {
    onCypher(baseRules({ transitions: FLAPPY.slice(1) }))
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).outcome).toBe('opened')
    expect(callMatching(Q.flap)).toBeUndefined()
    expect(metrics.eventsFlappingTotal.inc).not.toHaveBeenCalled()

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    vi.mocked(trackSourceStorm).mockResolvedValue(NO_STORM)
    onCypher(baseRules({ transitions: [minutesAgo(11), ...FLAPPY.slice(1)] }))
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).outcome).toBe('opened')
    expect(callMatching(Q.flap)).toBeUndefined()
  })

  it('il rilevamento avviene SOLO all\'ingest: in reevaluate/resume i passaggi non vengono contati', async () => {
    onCypher(baseRules({ transitions: FLAPPY }))
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, mode: 'reevaluate' })).outcome).toBe('opened')
    expect(callMatching(Q.flap)).toBeUndefined()
    onCypher(baseRules({ transitions: FLAPPY, correlation: 'delayed' }))
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, mode: 'resume' })).outcome).toBe('opened')
  })

  it('ripetizione (firing o resolved) su evento già flapping → resta flapping: salute ricalcolata, nessuna scrittura, nessun avviso, nessun incident', async () => {
    for (const lastPayload of ['firing', 'resolved']) {
      vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
      onCypher(baseRules({ status: 'flapping', flapping_since: minutesAgo(5), correlation: 'flapping', transitions: [...FLAPPY, NOW], last_payload_status: lastPayload }))
      const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
      expect(out).toEqual({ outcome: 'flapping', status: 'flapping', suppressedByChangeId: null, incidentId: null })
      expect(recomputeCIHealth).toHaveBeenCalledWith('t1', 'ci-1', 'monitoring')
      expect(callMatching(Q.flap)).toBeUndefined()
      expect(callMatching(Q.setCorr)).toBeUndefined()
      expect(callMatching(Q.linked)).toBeUndefined()
      expect(publishEvent).not.toHaveBeenCalled()
      expect(incidentService.createIncident).not.toHaveBeenCalled()
      expect(incidentService.resolveIncident).not.toHaveBeenCalled()
      expect(trackSourceStorm).not.toHaveBeenCalled()
    }
  })

  it('stabilizzazione (job periodico): senza passaggi da flap_stable_minutes torna allo stato dell\'ultimo payload, event.stable, e ripassa dalla pipeline (firing → opened; resolved → chiusura automatica valutata)', async () => {
    let loads = 0
    onCypher([
      [Q.allFlap, [{ tenantId: 't1', id: 'ev-1' }]],
      ...baseRules().slice(1),
      // primo caricamento: ancora flapping; dopo la stabilizzazione: firing
      [Q.load, () => (loads++ === 0
        ? { props: props({ status: 'flapping', flapping_since: minutesAgo(30), correlation: 'flapping', transitions: [minutesAgo(40), minutesAgo(16)], last_payload_status: 'firing' }), ciId: 'ci-1' }
        : { props: props({ status: 'firing', transitions: [minutesAgo(40), minutesAgo(16)] }), ciId: 'ci-1' })],
    ])
    await expect(reevaluateFlappingEvents(NOW)).resolves.toEqual({ evaluated: 1, stabilized: 1, failed: 0, truncated: false })
    const st = callMatching(Q.stabilize)!
    expect(st.cypher).toContain('MATCH (e:Event {id: $eventId, tenant_id: $tenantId})')
    // torna firing come `pending` con scadenza = ora: se la correlazione che segue fallisce, la passata periodica lo riprende
    expect(st.params).toMatchObject({ eventId: 'ev-1', tenantId: 't1', status: 'firing', now: NOW, correlation: 'pending', dueAt: NOW })
    expect(published()).toEqual(['event.stable', 'event.correlated'])
    expect(vi.mocked(publishEvent).mock.calls[0]![3]).toMatchObject({ id: 'ev-1', status: 'firing', stable_minutes: 15, flapping_since: minutesAgo(30) })
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'event.stable', 'Event', 'ev-1', expect.objectContaining({ status: 'firing' }))
    // ripasso dalla pipeline in reevaluate: soppressione, salute, correlazione (opened), nessun ritardo
    expect(callMatching(Q.suppressing)).toBeDefined()
    expect(recomputeCIHealth).toHaveBeenCalledWith('t1', 'ci-1', 'monitoring')
    expect(incidentService.createIncident).toHaveBeenCalledTimes(1)
    expect(enqueueCorrelation).not.toHaveBeenCalled()

    // ultimo payload resolved → torna resolved e valuta la chiusura automatica (nessun incident correlato → none)
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(getStormState).mockResolvedValue(NO_STORM)
    loads = 0
    onCypher([
      [Q.allFlap, [{ tenantId: 't1', id: 'ev-1' }]],
      ...baseRules().slice(1),
      [Q.load, () => (loads++ === 0
        ? { props: props({ status: 'flapping', flapping_since: minutesAgo(30), correlation: 'flapping', transitions: [minutesAgo(16)], last_payload_status: 'resolved', resolved_at: minutesAgo(16) }), ciId: 'ci-1' }
        : { props: props({ status: 'resolved', transitions: [minutesAgo(16)], last_payload_status: 'resolved', resolved_at: minutesAgo(16) }), ciId: 'ci-1' })],
    ])
    await expect(reevaluateFlappingEvents(NOW)).resolves.toEqual({ evaluated: 1, stabilized: 1, failed: 0, truncated: false })
    expect(callMatching(Q.stabilize)!.params).toMatchObject({ status: 'resolved', correlation: 'none', dueAt: null })
    expect(callMatching(Q.linked)).toBeDefined()
    expect(incidentService.createIncident).not.toHaveBeenCalled()
    expect(published()).toEqual(['event.stable'])
  })

  it('stabilizzazione: evento con un passaggio più recente di flap_stable_minutes resta flapping; senza last_payload_status → errore contato, il job fallisce alla fine', async () => {
    onCypher([
      [Q.allFlap, [{ tenantId: 't1', id: 'ev-1' }]],
      [Q.load, { props: props({ status: 'flapping', transitions: [minutesAgo(30), minutesAgo(10)], last_payload_status: 'firing' }), ciId: 'ci-1' }],
    ])
    await expect(reevaluateFlappingEvents(NOW)).resolves.toEqual({ evaluated: 1, stabilized: 0, failed: 0, truncated: false })
    expect(callMatching(Q.stabilize)).toBeUndefined()
    expect(publishEvent).not.toHaveBeenCalled()

    onCypher([
      [Q.allFlap, [{ tenantId: 't1', id: 'ev-1' }, { tenantId: 't1', id: 'ev-2' }]],
      [Q.load, { props: props({ status: 'flapping', transitions: [minutesAgo(30)], last_payload_status: undefined }), ciId: 'ci-1' }],
    ])
    await expect(reevaluateFlappingEvents(NOW)).rejects.toThrow(/2\/2 flapping events failed stabilisation/)
    expect(callMatching(Q.stabilize)).toBeUndefined()

    onCypher([[Q.allFlap, []]])
    await expect(reevaluateFlappingEvents(NOW)).resolves.toEqual({ evaluated: 0, stabilized: 0, failed: 0, truncated: false })
  })
})

// ── Ondata 4: tempesta della sorgente ────────────────────────────────────────

describe('tempesta della sorgente', () => {
  it('all\'ingest la pipeline aggiorna il contatore della sorgente (opensCycle, policy, CI dell\'evento) e senza tempesta prosegue normalmente', async () => {
    onCypher(baseRules())
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, opensCycle: true })).outcome).toBe('opened')
    expect(trackSourceStorm).toHaveBeenCalledWith({ tenantId: 't1', sourceId: 'hook-1', opensCycle: true, policy: policy(), now: NOW, actorId: 'monitoring', ciId: 'ci-1' })
    expect(getStormState).not.toHaveBeenCalled()
  })

  it('sorgente in tempesta → dopo soppressione e salute l\'evento si aggancia all\'incident di tempesta (storm): niente apertura/aggancio per CI, niente commento, niente avviso', async () => {
    vi.mocked(trackSourceStorm).mockResolvedValue(STORM)
    onCypher(baseRules({ severity: 'info' }))   // sotto la soglia open_incident_from: in tempesta non conta
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, created: true })
    expect(out).toEqual({ outcome: 'storm', status: 'firing', suppressedByChangeId: null, incidentId: 'inc-storm' })
    expect(callMatching(Q.suppressing)).toBeDefined()
    expect(recomputeCIHealth).toHaveBeenCalledWith('t1', 'ci-1', 'monitoring')
    expect(callMatching(Q.attach)!.params).toMatchObject({ eventId: 'ev-1', incidentId: 'inc-storm', manual: false, now: NOW })
    expect(callMatching(Q.setCorr)!.params['correlation']).toBe('storm')
    expect(callMatching(Q.group)).toBeUndefined()
    expect(incidentService.createIncident).not.toHaveBeenCalled()
    expect(incidentService.addIncidentComment).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
    expect(enqueueCorrelation).not.toHaveBeenCalled()
  })

  it('tempesta senza incident (solo orfani finora) → storm_no_ci senza aggancio; anche un evento orfano in tempesta viene marcato', async () => {
    vi.mocked(trackSourceStorm).mockResolvedValue({ ...STORM, incidentId: null })
    onCypher(baseRules({}, null))
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, created: true })
    expect(out).toEqual({ outcome: 'storm_no_ci', status: 'firing', suppressedByChangeId: null, incidentId: null })
    expect(callMatching(Q.attach)).toBeUndefined()
    expect(callMatching(Q.setCorr)!.params['correlation']).toBe('storm_no_ci')

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    vi.mocked(trackSourceStorm).mockResolvedValue(STORM)
    onCypher(baseRules({}, null))
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, created: true })).outcome).toBe('storm')
    expect(recomputeCIHealth).not.toHaveBeenCalled()
  })

  it('evento resolved in tempesta → solo salute: nessuna chiusura automatica dell\'incident di tempesta finché dura', async () => {
    vi.mocked(trackSourceStorm).mockResolvedValue(STORM)
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'resolved' }] as never)
    onCypher([...baseRules({ status: 'resolved', correlation: 'storm' }), [Q.linked, { incidentId: 'inc-storm', instanceId: 'wi-s', step: 'new', stillFiring: 0 }]])
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out).toEqual({ outcome: 'storm', status: 'resolved', suppressedByChangeId: null, incidentId: 'inc-storm' })
    expect(recomputeCIHealth).toHaveBeenCalledWith('t1', 'ci-1', 'monitoring')
    expect(callMatching(Q.linked)).toBeUndefined()
    expect(incidentService.resolveIncident).not.toHaveBeenCalled()
  })

  it('la soppressione in finestra di change vince sulla tempesta', async () => {
    vi.mocked(trackSourceStorm).mockResolvedValue(STORM)
    onCypher([...baseRules(), [Q.suppressing, windows({ changeId: 'chg-1', code: 'CHG1', step: 'deployment', plans: [] })]])
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, created: true })).outcome).toBe('suppressed')
    expect(callMatching(Q.attach)).toBeUndefined()
  })

  it('rivalutazioni e job ritardati leggono lo stato della tempesta senza contare (getStormState): in tempesta → storm', async () => {
    vi.mocked(getStormState).mockResolvedValue(STORM)
    onCypher(baseRules())
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, mode: 'reevaluate' })).outcome).toBe('storm')
    expect(trackSourceStorm).not.toHaveBeenCalled()
    expect(getStormState).toHaveBeenCalledWith('t1', 'hook-1')

    onCypher(baseRules({ correlation: 'delayed' }))
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, mode: 'resume' })).outcome).toBe('storm')
    expect(incidentService.createIncident).not.toHaveBeenCalled()
  })
})

// ── Ondata 4: metriche ───────────────────────────────────────────────────────

describe('metriche della pipeline', () => {
  it('opened → incidents_auto_opened; reopened → incidents_reopened; auto_resolved → incidents_auto_resolved; suppressed → events_suppressed (non sulle ripetizioni)', async () => {
    onCypher(baseRules())
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(metrics.incidentsAutoOpenedTotal.inc).toHaveBeenCalledTimes(1)

    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'in_progress' }] as never)
    onCypher([...baseRules(), [Q.group, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'resolved' }]])
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(metrics.incidentsReopenedTotal.inc).toHaveBeenCalledTimes(1)

    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'resolved' }] as never)
    onCypher([...baseRules({ status: 'resolved' }), [Q.linked, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'in_progress', stillFiring: 0 }]])
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(metrics.incidentsAutoResolvedTotal.inc).toHaveBeenCalledTimes(1)

    onCypher([...baseRules(), [Q.suppressing, windows({ changeId: 'chg-1', code: 'CHG1', step: 'deployment', plans: [] })]])
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    onCypher([...baseRules({ status: 'suppressed', suppressed_by_change_id: 'chg-1' }), [Q.suppressing, windows({ changeId: 'chg-1', code: 'CHG1', step: 'deployment', plans: [] })]])
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(metrics.eventsSuppressedTotal.inc).toHaveBeenCalledTimes(1)
    // l'apertura manuale (createIncidentFromEvent) non è un incident automatico
    expect(metrics.incidentsAutoOpenedTotal.inc).toHaveBeenCalledTimes(1)
  })

  it('openIncidentFromEvent manuale → nessun incremento di incidents_auto_opened', async () => {
    onCypher([[Q.attach, { created: true }], [Q.setCorr, null]])
    await openIncidentFromEvent({ tenantId: 't1', props: props(), ciId: 'ci-1', actorId: 'op-1', manual: true, now: NOW })
    expect(metrics.incidentsAutoOpenedTotal.inc).not.toHaveBeenCalled()
  })
})

// ── Fine finestra ────────────────────────────────────────────────────────────

describe('fine finestra', () => {
  it('reevaluateSuppressedEvents: l\'evento soppresso torna firing (SUPPRESSED_BY resta), salute ricalcolata, correlato (opened)', async () => {
    onCypher([...baseRules({ status: 'suppressed', suppressed_by_change_id: 'chg-1', correlation: 'suppressed' }), [Q.byChange, [{ id: 'ev-1' }]]])
    await expect(reevaluateSuppressedEvents('t1', 'chg-1', 'op-1')).resolves.toBe(1)
    expect(callMatching(Q.byChange)!.params).toEqual({ tenantId: 't1', changeId: 'chg-1' })
    const lift = callMatching(Q.lift)!
    expect(lift.cypher).toContain('MATCH (e:Event {id: $eventId, tenant_id: $tenantId})')
    expect(lift.cypher).not.toContain('SUPPRESSED_BY')   // la relazione resta per la storia
    expect(recomputeCIHealth).toHaveBeenCalledWith('t1', 'ci-1', 'op-1')
    expect(incidentService.createIncident).toHaveBeenCalledWith(expect.objectContaining({ affectedCIIds: ['ci-1'] }), MON)
    expect(callMatching(Q.setCorr)!.params['correlation']).toBe('opened')
    expect(enqueueCorrelation).not.toHaveBeenCalled()   // mode reevaluate: nessun ritardo
  })

  it('reevaluateSuppressedEvents: un\'altra change ancora in finestra → resta soppresso (dalla nuova change); nessun evento → 0', async () => {
    onCypher([...baseRules({ status: 'suppressed', suppressed_by_change_id: 'chg-1', correlation: 'suppressed' }), [Q.byChange, [{ id: 'ev-1' }]], [Q.suppressing, windows({ changeId: 'chg-2', code: 'CHG2', step: 'deployment', plans: [] })]])
    await reevaluateSuppressedEvents('t1', 'chg-1')
    expect(callMatching(Q.suppress)!.params['changeId']).toBe('chg-2')
    expect(callMatching(Q.lift)).toBeUndefined()
    expect(recomputeCIHealth).not.toHaveBeenCalled()

    onCypher([[Q.byChange, []]])
    await expect(reevaluateSuppressedEvents('t1', 'chg-1')).resolves.toBe(0)
  })

  it('reevaluateClosedWindows (job periodico): rivaluta ogni evento soppresso di ogni tenant; un errore non ferma gli altri ma fa fallire il job', async () => {
    let loads = 0
    onCypher([
      [Q.allSupp, [{ tenantId: 't1', id: 'ev-1' }, { tenantId: 't2', id: 'ev-2' }]],
      [Q.load, () => (loads++ === 0 ? { props: props({ status: 'suppressed', suppressed_by_change_id: 'chg-1' }), ciId: 'ci-1' } : null)],
      ...baseRules().slice(1),
    ])
    await expect(reevaluateClosedWindows()).rejects.toThrow(/1\/2 suppressed events failed re-evaluation/)
    // t2 fallisce al caricamento dell'evento: la policy viene letta solo per t1
    expect(vi.mocked(getEventPolicy).mock.calls.every((c) => c[0] === 't1')).toBe(true)
    expect(vi.mocked(getEventPolicy).mock.calls.length).toBeGreaterThan(0)
    expect(incidentService.createIncident).toHaveBeenCalledTimes(1)

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[Q.allSupp, []]])
    await expect(reevaluateClosedWindows()).resolves.toEqual({ evaluated: 0, failed: 0, truncated: false })
  })
})

// ── Revisione, ondata 1: lock sul raggruppamento ─────────────────────────────

describe('lock sul raggruppamento (Redis in memoria)', () => {
  const key = groupLockKey('t1', 'ci', 'ci-1')

  /**
   * Grafo "vivo" per il CI ci-1: nessun incident finché qualcuno non aggancia
   * un evento (Q.attach) a un incident; da lì `findOpenIncidentForGroup` lo
   * restituisce a chiunque rilegga. Come `liveSource()` in eventStorm.test.ts.
   */
  function liveGroup(events: Record<string, Record<string, unknown>>) {
    const attached = new Map<string, string>()   // eventId → incidentId
    let open: { incidentId: string; instanceId: string; step: string } | null = null
    onCypher([
      ...baseRules(),
      [Q.load, (p?: Record<string, unknown>) => ({ props: props({ id: p!['eventId'], ...events[p!['eventId'] as string] }), ciId: 'ci-1' })],
      [Q.group, () => open],
      [Q.attach, (p?: Record<string, unknown>) => {
        const eventId = p!['eventId'] as string
        const incidentId = p!['incidentId'] as string
        const created = attached.get(eventId) !== incidentId
        attached.set(eventId, incidentId)
        open = { incidentId, instanceId: `wi-${incidentId}`, step: 'new' }
        return { created }
      }],
    ])
    return attached
  }

  it('due pipeline concorrenti su due allarmi diversi dello stesso CI → UN solo createIncident e due CORRELATED_INTO sullo stesso incident (opened + attached); ogni lock preso viene rilasciato', async () => {
    const attached = liveGroup({ 'ev-a': { title: 'DiskFull', fingerprint: 'fp-a' }, 'ev-b': { title: 'HighLoad', fingerprint: 'fp-b' } })
    const [a, b] = await Promise.all([
      runEventPipeline({ tenantId: 't1', eventId: 'ev-a', now: NOW }),
      runEventPipeline({ tenantId: 't1', eventId: 'ev-b', now: NOW }),
    ])
    expect(incidentService.createIncident).toHaveBeenCalledTimes(1)
    expect([a.outcome, b.outcome].sort()).toEqual(['attached', 'opened'])
    expect(a.incidentId).toBe('inc-new')
    expect(b.incidentId).toBe('inc-new')
    expect([...attached.entries()]).toEqual([['ev-a', 'inc-new'], ['ev-b', 'inc-new']])
    expect(redis.set).toHaveBeenCalledWith(key, expect.any(String), 'EX', GROUP_LOCK_TTL_SECONDS, 'NX')
    expect(published().filter((n) => n === 'event.correlated')).toHaveLength(2)
    expect(lockStore.size).toBe(0)
    expect(GROUP_LOCK_TTL_SECONDS).toBe(30)
    expect(groupLockKey('t1', 'fingerprint', 'fp')).toBe('og:events:group:t1:fp:fp')
  })

  it('lock occupato da un altro job e incident del gruppo comparso nel frattempo → aggancio senza entrare nella sezione critica, nessun createIncident', async () => {
    redis.set.mockResolvedValue(null as never)   // il lock resta di un altro job
    let reads = 0
    onCypher([...baseRules(), [Q.group, () => (reads++ === 0 ? null : { incidentId: 'inc-1', instanceId: 'wi-1', step: 'new' })]])
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out).toMatchObject({ outcome: 'attached', incidentId: 'inc-1' })
    expect(incidentService.createIncident).not.toHaveBeenCalled()
    expect(callMatching(Q.attach)!.params['incidentId']).toBe('inc-1')
    expect(redis.eval).not.toHaveBeenCalled()   // mai preso, niente da rilasciare
  })

  it('lock occupato e nessun incident entro l\'attesa (5 s, polling 100 ms) → errore ritentabile, nessun incident, evento non marcato', async () => {
    vi.useFakeTimers()
    redis.set.mockResolvedValue(null as never)
    onCypher(baseRules())
    const pending = expect(runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).rejects.toThrow(/Lock og:events:group:t1:ci:ci-1 still held by another job after 5000 ms and no open incident appeared for event ev-1 — will retry/)
    await vi.advanceTimersByTimeAsync(GROUP_LOCK_WAIT_MS + GROUP_LOCK_POLL_MS)
    await pending
    expect(GROUP_LOCK_WAIT_MS).toBe(5_000)
    expect(GROUP_LOCK_POLL_MS).toBe(100)
    expect(incidentService.createIncident).not.toHaveBeenCalled()
    expect(callMatching(Q.setCorr)).toBeUndefined()
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('incident del gruppo in resolved mentre il lock è occupato → non si riapre fuori dal lock: si attende il lock e poi si riapre', async () => {
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'in_progress' }] as never)
    lockStore.set(key, 'someone-else')
    setTimeout(() => lockStore.delete(key), 250)
    onCypher([...baseRules(), [Q.group, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'resolved' }]])
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out).toMatchObject({ outcome: 'reopened', incidentId: 'inc-1' })
    expect(workflowEngine.transition).toHaveBeenCalledTimes(1)
    expect(redis.set.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(lockStore.size).toBe(0)
  })

  it('createIncident fallisce → l\'errore propaga e il lock viene rilasciato', async () => {
    onCypher(baseRules())
    vi.mocked(incidentService.createIncident).mockRejectedValueOnce(new Error('Neo4j down'))
    await expect(runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).rejects.toThrow('Neo4j down')
    expect(redis.eval).toHaveBeenCalledWith(expect.any(String), 1, key, redis.set.mock.calls[0]![1])
    expect(lockStore.size).toBe(0)
  })

  it('la chiusura automatica di un rientro gira sotto lo STESSO lock del gruppo (og:events:group:<tenant>:ci:<ciId>) e lo rilascia', async () => {
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'resolved', inputField: 'rootCause' }] as never)
    onCypher([...baseRules({ status: 'resolved', correlation: 'attached' }), [Q.linked, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'in_progress', stillFiring: 0 }]])
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out).toMatchObject({ outcome: 'auto_resolved', incidentId: 'inc-1' })
    expect(redis.set).toHaveBeenCalledWith(key, expect.any(String), 'EX', GROUP_LOCK_TTL_SECONDS, 'NX')
    expect(redis.eval).toHaveBeenCalledWith(expect.any(String), 1, key, redis.set.mock.calls[0]![1])
    expect(lockStore.size).toBe(0)
    // la lettura "incident + allarmi ancora accesi" (runQuery: tutti gli incident collegati, 1.19) avviene DOPO aver preso il lock
    const lockAt = redis.set.mock.invocationCallOrder[0]!
    const linkedIdx = vi.mocked(runQuery).mock.calls.findIndex(([, cypher]) => Q.linked.test(cypher as string))
    expect(linkedIdx).toBeGreaterThanOrEqual(0)
    expect(vi.mocked(runQuery).mock.invocationCallOrder[linkedIdx]!).toBeGreaterThan(lockAt)
  })

  it('due rientri paralleli dello stesso gruppo → si serializzano: il secondo rilegge l\'incident già resolved e non tenta nessuna transizione (un solo resolveIncident)', async () => {
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'resolved', inputField: 'rootCause' }] as never)
    let step = 'in_progress'
    vi.mocked(incidentService.resolveIncident).mockImplementation((async () => { await new Promise((r) => setTimeout(r, 50)); step = 'resolved'; return { id: 'inc-1' } }) as never)
    onCypher([
      ...baseRules({ status: 'resolved', correlation: 'attached' }),
      [Q.load, (p?: Record<string, unknown>) => ({ props: props({ id: p!['eventId'], status: 'resolved', correlation: 'attached', fingerprint: `fp-${p!['eventId']}` }), ciId: 'ci-1' })],
      [Q.linked, () => ({ incidentId: 'inc-1', instanceId: 'wi-1', step, stillFiring: 0 })],
    ])
    const [a, b] = await Promise.all([
      runEventPipeline({ tenantId: 't1', eventId: 'ev-a', now: NOW }),
      runEventPipeline({ tenantId: 't1', eventId: 'ev-b', now: NOW }),
    ])
    expect([a.outcome, b.outcome].sort()).toEqual(['auto_resolved', 'none'])
    expect(incidentService.resolveIncident).toHaveBeenCalledTimes(1)
    expect(lockStore.size).toBe(0)
  })

  it('lock del gruppo occupato oltre l\'attesa durante un rientro → errore ritentabile, nessuna transizione né commento', async () => {
    vi.useFakeTimers()
    redis.set.mockResolvedValue(null as never)
    onCypher([...baseRules({ status: 'resolved' }), [Q.linked, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'in_progress', stillFiring: 0 }]])
    const pending = expect(runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).rejects.toThrow(/Lock og:events:group:t1:ci:ci-1 still held by another job after 5000 ms and auto-resolve of event ev-1 could not start — will retry/)
    await vi.advanceTimersByTimeAsync(GROUP_LOCK_WAIT_MS + GROUP_LOCK_POLL_MS)
    await pending
    expect(incidentService.resolveIncident).not.toHaveBeenCalled()
    expect(incidentService.addIncidentComment).not.toHaveBeenCalled()
    expect(callMatching(Q.linked)).toBeUndefined()
  })

  it('groupIdOf: CI se la policy raggruppa per CI e l\'evento ne ha uno; altrimenti impronta; senza impronta l\'id dell\'evento', () => {
    const ev = (over: Record<string, unknown>, ciId: string | null) => ({ ciId, props: { id: 'ev-1', ...over } })
    expect(corr.groupIdOf({ group_by: 'ci' }, ev({ fingerprint: 'fp' }, 'ci-9'))).toBe('ci-9')
    expect(corr.groupIdOf({ group_by: 'ci' }, ev({ fingerprint: 'fp' }, null))).toBe('fp')
    expect(corr.groupIdOf({ group_by: 'fingerprint' }, ev({ fingerprint: 'fp' }, 'ci-9'))).toBe('fp')
    expect(corr.groupIdOf({ group_by: 'fingerprint' }, ev({}, 'ci-9'))).toBe('ev-1')
  })

  it('il raggruppamento ignora gli incident di tempesta (storm_source_id) in entrambe le modalità', async () => {
    onCypher(baseRules())
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(callMatching(Q.group)!.cypher).toContain('WHERE i.storm_source_id IS NULL')
    vi.mocked(getEventPolicy).mockResolvedValue(policy({ group_by: 'fingerprint' }))
    onCypher(baseRules())
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(callMatching(Q.group)!.cypher).toContain('WHERE i.storm_source_id IS NULL')
  })
})

// ── Revisione, ondata 1: dieta di rumore ─────────────────────────────────────

describe('dieta di rumore', () => {
  it('ripetizione di un evento GIÀ agganciato allo stesso incident (relazione esistente, esito attached/opened/reopened) → nessun event.correlated, audit, commento né riscrittura dell\'esito', async () => {
    for (const prev of ['attached', 'opened', 'reopened']) {
      vi.clearAllMocks(); lockStore.clear(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(trackSourceStorm).mockResolvedValue(NO_STORM)
      onCypher([...baseRules({ correlation: prev }), [Q.group, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'in_progress' }], [Q.attach, { created: false }]])
      const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
      expect(out).toEqual({ outcome: 'attached', status: 'firing', suppressedByChangeId: null, incidentId: 'inc-1' })
      expect(publishEvent).not.toHaveBeenCalled()
      expect(audit).not.toHaveBeenCalled()
      expect(incidentService.addIncidentComment).not.toHaveBeenCalled()
      expect(callMatching(Q.setCorr)).toBeUndefined()
      expect(recomputeCIHealth).toHaveBeenCalled()   // la salute resta aggiornata
    }
  })

  it('relazione esistente ma esito che cambia (pending dopo la fine finestra) → esito, avviso e audit come una correlazione nuova', async () => {
    onCypher([...baseRules({ correlation: 'pending' }), [Q.group, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'in_progress' }], [Q.attach, { created: false }]])
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).outcome).toBe('attached')
    expect(callMatching(Q.setCorr)!.params['correlation']).toBe('attached')
    expect(published()).toEqual(['event.correlated'])
    expect(incidentService.addIncidentComment).not.toHaveBeenCalled()   // la relazione non è nuova: niente commento
  })

  it('in tempesta: ripetizione già agganciata all\'incident di tempesta → nessuna riscrittura dell\'esito', async () => {
    vi.mocked(trackSourceStorm).mockResolvedValue(STORM)
    onCypher([...baseRules({ correlation: 'storm' }), [Q.attach, { created: false }]])
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, created: false })).outcome).toBe('storm')
    expect(callMatching(Q.setCorr)).toBeUndefined()
  })
})

// ── Revisione, ondata 1: stati ritentabili ───────────────────────────────────

describe('stati ritentabili (pending)', () => {
  it('fine soppressione: la lift scrive correlation pending + correlation_due_at = now PRIMA di correlare; se la correlazione fallisce l\'evento resta firing/pending (nessuno stato "libero" senza esito)', async () => {
    onCypher([...baseRules({ status: 'suppressed', suppressed_by_change_id: 'chg-1', correlation: 'suppressed' }), [Q.byChange, [{ id: 'ev-1' }]]])
    vi.mocked(incidentService.createIncident).mockRejectedValueOnce(new Error('Neo4j down'))
    await expect(reevaluateSuppressedEvents('t1', 'chg-1')).rejects.toThrow(/1\/1 events suppressed by change chg-1 failed re-evaluation/)
    const lift = callMatching(Q.lift)!
    expect(lift.cypher).toContain("e.correlation = 'pending', e.correlation_at = $now, e.correlation_due_at = $now")
    expect(callMatching(Q.setCorr)).toBeUndefined()   // nessun esito scritto dopo il fallimento
    expect(CORRELATION_OUTCOMES).toContain('pending')
    expect(PENDING_CORRELATIONS).toEqual(['pending', 'none'])
  })

  // Revisione 2 · B2-04: tre attori (job di fine finestra, passata periodica,
  // deleteChange) possono rivalutare lo stesso evento soppresso nello stesso
  // istante. La lift è guardata da `status = 'suppressed'` e dice quante righe
  // ha liberato: chi arriva secondo trova 0 e si ferma.
  it('fine soppressione concorrente: la lift è guardata (WHERE status = suppressed, RETURN count) e chi trova 0 esce con `none` — una sola voce `unsuppressed`, un solo event.correlated', async () => {
    // primo attore: libera davvero (lifted = 1) e apre l'incident
    onCypher([...baseRules({ status: 'suppressed', suppressed_by_change_id: 'chg-1', correlation: 'suppressed' })])
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, mode: 'reevaluate' })).outcome).toBe('opened')
    const lift = callMatching(Q.lift)!
    expect(lift.cypher).toMatch(/WHERE e\.status = 'suppressed'/)
    expect(lift.cypher).toMatch(/RETURN count\(e\) AS lifted/)
    expect(published()).toEqual(['event.correlated'])
    expect(incidentService.createIncident).toHaveBeenCalledTimes(1)

    // secondo attore, stesso evento: la guardia non trova più nulla (lifted = 0)
    vi.clearAllMocks()
    vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([...baseRules({ status: 'suppressed', suppressed_by_change_id: 'chg-1', correlation: 'suppressed' }), [Q.lift, { lifted: 0 }]])
    const second = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, mode: 'reevaluate' })
    expect(second).toEqual({ outcome: 'none', status: 'firing', suppressedByChangeId: null, incidentId: null })
    expect(callMatching(Q.setCorr)).toBeUndefined()       // nessun esito scritto sopra quello del primo
    expect(callMatching(Q.attach)).toBeUndefined()        // nessun aggancio all'incident appena aperto
    expect(publishEvent).not.toHaveBeenCalled()           // nessun secondo event.correlated
    expect(incidentService.createIncident).not.toHaveBeenCalled()
  })

  it('reevaluateSuppressedEvents: un evento fallito non ferma gli altri, il job fallisce alla fine con il conteggio', async () => {
    let loads = 0
    onCypher([
      ...baseRules({ status: 'suppressed', suppressed_by_change_id: 'chg-1', correlation: 'suppressed' }),
      [Q.byChange, [{ id: 'ev-1' }, { id: 'ev-2' }]],
      [Q.load, () => (loads++ === 0 ? null : { props: props({ id: 'ev-2', status: 'suppressed', suppressed_by_change_id: 'chg-1', correlation: 'suppressed' }), ciId: 'ci-1' })],
    ])
    await expect(reevaluateSuppressedEvents('t1', 'chg-1')).rejects.toThrow(/1\/2 events suppressed by change chg-1 failed/)
    expect(incidentService.createIncident).toHaveBeenCalledTimes(1)
  })

  it('reevaluatePendingEvents (passata periodica): riprende i firing con correlation pending/none e scadenza passata, pipeline in reevaluate → correlati; la pagina è filtrata per stato con LIMIT', async () => {
    onCypher([...baseRules({ correlation: 'pending', correlation_due_at: minutesAgo(3) }), [Q.allPending, [{ tenantId: 't1', id: 'ev-1' }]]])
    await expect(reevaluatePendingEvents(NOW)).resolves.toEqual({ evaluated: 1, failed: 0, truncated: false })
    const q = callMatching(Q.allPending)!
    expect(q.cypher).toContain('WHERE e.id > $cursor AND (')
    expect(q.cypher).toContain('ORDER BY e.id LIMIT toInteger($limit)')
    expect(q.params).toEqual({ correlations: ['pending', 'none'], now: NOW, uncorrelatedCutoff: minutesAgo(UNCORRELATED_AFTER_MINUTES), delayedCutoff: minutesAgo(OVERDUE_DELAYED_GRACE_MINUTES), cursor: '', limit: PAGE_SIZE })
    expect(incidentService.createIncident).toHaveBeenCalledTimes(1)
    expect(callMatching(Q.setCorr)!.params).toMatchObject({ correlation: 'opened', dueAt: null })
    expect(enqueueCorrelation).not.toHaveBeenCalled()

    onCypher([...baseRules(), [Q.allPending, [{ tenantId: 't1', id: 'ev-1' }]], [Q.load, null]])
    await expect(reevaluatePendingEvents(NOW)).rejects.toThrow(/reevaluatePendingEvents: 1\/1 pending events failed/)
  })

  // Revisione 2 · B2-01/B2-02: il predicato è quello del gauge, non solo la scadenza.
  // Un Event nasce (e riparte a ogni ciclo) firing/none con `correlation_due_at = null`:
  // se la pipeline falliva tutti i tentativi nessuna passata lo riprendeva più.
  it('reevaluatePendingEvents: predicato UNICO condiviso con il gauge — scadenza passata, oppure pending/none senza scadenza fermo da più della grazia, oppure delayed scaduto; appena creato o con scadenza futura NO', () => {
    const where = STUCK_FIRING_WHERE
    expect(where).toBe(`(${DUE_CORRELATION_WHERE}) OR (${UNCORRELATED_WHERE}) OR (${OVERDUE_DELAYED_WHERE})`)
    // (a) scadenza passata (fine soppressione / stabilizzazione fallite)
    expect(DUE_CORRELATION_WHERE).toBe('e.correlation IN $correlations AND e.correlation_due_at IS NOT NULL AND e.correlation_due_at <= $now')
    // (b) firing senza esito e SENZA scadenza, fermo da più di UNCORRELATED_AFTER_MINUTES: il caso di B2-01
    expect(UNCORRELATED_WHERE).toBe('e.correlation IN $correlations AND coalesce(e.correlation_at, e.first_seen_at) < $uncorrelatedCutoff')
    // (c) ritardo di apertura perso (B2-02): in `reevaluate` il passo del ritardo non viene rieseguito
    expect(OVERDUE_DELAYED_WHERE).toBe("e.correlation = 'delayed' AND e.correlation_due_at IS NOT NULL AND e.correlation_due_at < $delayedCutoff")
    const p = stuckEventParams(NOW)
    expect(p).toEqual({ correlations: ['pending', 'none'], now: NOW, uncorrelatedCutoff: minutesAgo(15), delayedCutoff: minutesAgo(5) })
    // il taglio è quello: un evento fermo da 20 min rientra, uno di 2 min no (i due istanti stanno ai lati del cutoff)
    expect(minutesAgo(20) < p.uncorrelatedCutoff).toBe(true)
    expect(minutesAgo(2)  < p.uncorrelatedCutoff).toBe(false)
    // una scadenza FUTURA non entra dal ramo (a): il confronto è `<= $now`
    expect(new Date(Date.parse(NOW) + 60_000).toISOString() <= p.now).toBe(false)
    expect(() => stuckEventParams('ieri')).toThrow(/not an ISO date/)
  })

  it('reevaluatePendingEvents: un firing/none SENZA scadenza e più vecchio della grazia rientra in pipeline e viene correlato, con una riga di log per evento (B2-01)', async () => {
    onCypher([...baseRules({ correlation: 'none', correlation_at: null, correlation_due_at: null, first_seen_at: minutesAgo(20) }), [Q.allPending, [{ tenantId: 't1', id: 'ev-1' }]]])
    await expect(reevaluatePendingEvents(NOW)).resolves.toEqual({ evaluated: 1, failed: 0, truncated: false })
    expect(incidentService.createIncident).toHaveBeenCalledTimes(1)
    expect(callMatching(Q.setCorr)!.params).toMatchObject({ correlation: 'opened' })
    const { logger } = await import('../../lib/logger.js')
    const info = vi.mocked(logger.child({} as never).info).mock.calls.find(([, msg]) => /Uncorrelated firing event picked up by the periodic pass/.test(String(msg)))!
    expect(info[0]).toMatchObject({ tenantId: 't1', eventId: 'ev-1', outcome: 'opened' })
  })
})

// ── Revisione, ondata 1: passate paginate ────────────────────────────────────

describe('passate paginate', () => {
  /** Pagine di PAGE_SIZE id crescenti; l'ultima più corta. */
  const pages = (total: number) => (p?: Record<string, unknown>) => {
    const cursor = p!['cursor'] as string
    const limit = p!['limit'] as number
    const ids = Array.from({ length: total }, (_, i) => `ev-${String(i).padStart(4, '0')}`).filter((id) => id > cursor)
    return ids.slice(0, limit).map((id) => ({ tenantId: 't1', id }))
  }

  it('reevaluateClosedWindows: 3 pagine (200 + 200 + 50) lette con cursore sull\'id, ogni evento rivalutato', async () => {
    onCypher([...baseRules({ status: 'suppressed', suppressed_by_change_id: 'chg-1', correlation: 'suppressed' }), [Q.allSupp, pages(450)]])
    await expect(reevaluateClosedWindows(NOW)).resolves.toEqual({ evaluated: 450, failed: 0, truncated: false })
    const pageCalls = calls().filter((c) => Q.allSupp.test(c.cypher))
    expect(pageCalls.map((c) => c.params['cursor'])).toEqual(['', 'ev-0199', 'ev-0399'])
    expect(pageCalls.every((c) => c.params['limit'] === PAGE_SIZE)).toBe(true)
    expect(calls().filter((c) => Q.load.test(c.cypher))).toHaveLength(450)
    expect(PAGE_SIZE).toBe(200)
  })

  it('oltre MAX_PAGES pagine piene la passata si ferma (truncated) e il resto va al giro successivo', async () => {
    onCypher([...baseRules({ status: 'flapping', transitions: [minutesAgo(40)], last_payload_status: 'firing' }), [Q.allFlap, pages(PAGE_SIZE * MAX_PAGES + 1)]])
    const out = await reevaluateFlappingEvents(NOW)
    expect(out).toMatchObject({ evaluated: PAGE_SIZE * MAX_PAGES, truncated: true, failed: 0 })
    expect(MAX_PAGES).toBe(20)
  })
})

// ── Revisione, ondata 1: incident di tempesta con stato controllato ──────────

describe('incident di tempesta chiuso o risolto', () => {
  it('incident di tempesta in passo terminale (closed) → nessun aggancio al ticket chiuso: replaceClosedStormIncident (sotto lock) e aggancio al nuovo incident', async () => {
    vi.mocked(trackSourceStorm).mockResolvedValue(STORM)
    vi.mocked(replaceClosedStormIncident).mockResolvedValue({ ...STORM, incidentId: 'inc-storm-2' })
    onCypher([...baseRules(), [Q.incStep, { incidentId: 'inc-storm', instanceId: 'wi-s', step: 'closed' }]])
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, created: true })
    expect(out).toEqual({ outcome: 'storm', status: 'firing', suppressedByChangeId: null, incidentId: 'inc-storm-2' })
    expect(replaceClosedStormIncident).toHaveBeenCalledWith('t1', 'hook-1', 'inc-storm', 'ci-1', 'monitoring', NOW)
    expect(callMatching(Q.attach)!.params['incidentId']).toBe('inc-storm-2')
    expect(callMatching(Q.setCorr)!.params['correlation']).toBe('storm')
    expect(incidentService.createIncident).not.toHaveBeenCalled()   // lo apre eventStorm

    // tempesta finita nel frattempo → correlazione normale per CI
    vi.clearAllMocks(); lockStore.clear(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(trackSourceStorm).mockResolvedValue(STORM)
    vi.mocked(replaceClosedStormIncident).mockResolvedValue(NO_STORM)
    onCypher([...baseRules(), [Q.incStep, { incidentId: 'inc-storm', instanceId: 'wi-s', step: 'closed' }]])
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, created: true })).outcome).toBe('opened')

    // nuovo incident non apribile (evento orfano) → storm_no_ci
    vi.clearAllMocks(); lockStore.clear(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(trackSourceStorm).mockResolvedValue(STORM)
    vi.mocked(replaceClosedStormIncident).mockResolvedValue({ ...STORM, incidentId: null })
    onCypher([...baseRules({}, null), [Q.incStep, { incidentId: 'inc-storm', instanceId: 'wi-s', step: 'closed' }]])
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, created: true })).outcome).toBe('storm_no_ci')
    expect(callMatching(Q.attach)).toBeUndefined()
  })

  it('incident di tempesta in resolved → riapertura via "Riapri" sotto il lock della sorgente, poi aggancio; incident sparito → errore', async () => {
    vi.mocked(trackSourceStorm).mockResolvedValue(STORM)
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'in_progress' }] as never)
    let reads = 0
    onCypher([...baseRules(), [Q.incStep, () => ({ incidentId: 'inc-storm', instanceId: 'wi-s', step: reads++ < 2 ? 'resolved' : 'in_progress' })]])
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, created: true })
    expect(out).toMatchObject({ outcome: 'storm', incidentId: 'inc-storm' })
    expect(workflowEngine.transition).toHaveBeenCalledWith(session, expect.objectContaining({ instanceId: 'wi-s', toStepName: 'in_progress', notes: expect.stringMatching(/Tempesta ancora in corso.*DiskFull/) }), expect.anything())
    expect(redis.set).toHaveBeenCalledWith('og:events:storm-open:t1:hook-1', expect.any(String), 'EX', 30, 'NX')
    expect(metrics.incidentsReopenedTotal.inc).toHaveBeenCalledTimes(1)
    expect(replaceClosedStormIncident).not.toHaveBeenCalled()
    expect(lockStore.size).toBe(0)

    onCypher([...baseRules(), [Q.incStep, null]])
    await expect(runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, created: true })).rejects.toThrow(/Storm incident inc-storm of source hook-1 not found/)
  })
})

// ── Cronologia dell'allarme (services/events/history.ts) ─────────────────────

describe('cronologia dell\'allarme', () => {
  /** Le voci scritte in questa esecuzione, nell'ordine: parametri $history* di ogni statement che contiene la CREATE, con la condizione del FOREACH. */
  const historyWrites = () => calls().filter((c) => /CREATE \(e\)-\[:HAS_HISTORY\]/.test(c.cypher)).map((c) => ({
    kind: c.params['historyKind'], outcome: c.params['historyOutcome'], incidentId: c.params['historyIncidentId'], changeId: c.params['historyChangeId'],
    actorId: c.params['historyActorId'], note: c.params['historyNote'], at: c.params['historyAt'],
    when: (c.cypher.match(/FOREACH \(_ IN CASE WHEN (.+?) THEN \[1\] ELSE \[\] END \|/) ?? [])[1],
  }))
  const ON_CHANGE = 'previous IS NULL OR previous <> $correlation'
  const FLAPPY = [minutesAgo(9), minutesAgo(6), minutesAgo(3), minutesAgo(1)]

  it('soppressione: la voce `suppressed` con la change sta nello STESSO statement del SET/MERGE SUPPRESSED_BY; la ripetizione nella stessa finestra non scrive nulla', async () => {
    onCypher([...baseRules(), [Q.suppressing, windows({ changeId: 'chg-1', code: 'CHG1', step: 'deployment', plans: [null] })]])
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    const sup = callMatching(Q.suppress)!
    expect(sup.cypher).toMatch(/SET r\.last_seen_at = \$now\s+FOREACH \(_ IN CASE WHEN true THEN \[1\] ELSE \[\] END \|\s+CREATE \(e\)-\[:HAS_HISTORY\]->\(:EventHistoryEntry \{id: \$historyId, tenant_id: \$tenantId, event_id: e\.id/)
    expect(sup.cypher).toMatch(/DETACH DELETE old\s+\}\s+RETURN e\.id AS id/)
    expect(historyWrites()).toEqual([{ kind: 'suppressed', outcome: null, incidentId: null, changeId: 'chg-1', actorId: 'monitoring', note: null, at: NOW, when: 'true' }])

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(trackSourceStorm).mockResolvedValue(NO_STORM)
    onCypher([...baseRules({ status: 'suppressed', suppressed_by_change_id: 'chg-1', correlation: 'suppressed' }), [Q.suppressing, windows({ changeId: 'chg-1', code: 'CHG1', step: 'deployment', plans: [null] })]])
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(callMatching(Q.touchSupp)).toBeDefined()
    expect(historyWrites()).toEqual([])
  })

  it('fine soppressione: `unsuppressed` con la change letta PRIMA di azzerare il puntatore (variabile Cypher, non parametro), poi `correlated` (opened) dalla correlazione che segue', async () => {
    onCypher(baseRules({ status: 'suppressed', suppressed_by_change_id: 'chg-1', correlation: 'suppressed' }))
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, mode: 'reevaluate' })).outcome).toBe('opened')
    const lift = callMatching(Q.lift)!
    expect(lift.cypher).toMatch(/MATCH \(e:Event \{id: \$eventId, tenant_id: \$tenantId\}\)\s+WHERE e\.status = 'suppressed'\s+WITH e, e\.suppressed_by_change_id AS changeId\s+SET e\.status = 'firing'/)
    expect(lift.cypher).toContain('change_id: changeId, ci_id: $historyCiId')
    expect(historyWrites().map((h) => [h.kind, h.outcome, h.incidentId, h.when])).toEqual([['unsuppressed', null, null, 'true'], ['correlated', 'opened', 'inc-new', 'true']])
  })

  it('correlazione: `correlated` con outcome e incident — opened/attached/reopened sempre (relazione nuova), skipped_*/delayed solo se l\'esito cambia (condizione nel FOREACH)', async () => {
    onCypher(baseRules())
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(historyWrites()).toEqual([{ kind: 'correlated', outcome: 'opened', incidentId: 'inc-new', changeId: null, actorId: 'monitoring', note: null, at: NOW, when: 'true' }])
    const sc = callMatching(Q.setCorr)!
    expect(sc.cypher).toMatch(/MATCH \(e:Event \{id: \$eventId, tenant_id: \$tenantId\}\)\s+WITH e, e\.correlation AS previous\s+SET e\.correlation = \$correlation/)
    expect(sc.cypher).toMatch(/CALL \{\s+WITH e, previous\s+UNWIND CASE WHEN true THEN/)

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(trackSourceStorm).mockResolvedValue(NO_STORM)
    onCypher([...baseRules(), [Q.group, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'in_progress' }]])
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(historyWrites()).toEqual([expect.objectContaining({ kind: 'correlated', outcome: 'attached', incidentId: 'inc-1', when: 'true' })])

    vi.clearAllMocks(); lockStore.clear(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(trackSourceStorm).mockResolvedValue(NO_STORM)
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'in_progress', label: 'Riapri' }] as never)
    onCypher([...baseRules({ correlation: 'none' }), [Q.group, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'resolved' }], [Q.attach, { created: false }]])
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).outcome).toBe('reopened')
    expect(historyWrites()).toEqual([expect.objectContaining({ kind: 'correlated', outcome: 'reopened', incidentId: 'inc-1', when: ON_CHANGE })])

    vi.clearAllMocks(); lockStore.clear(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(trackSourceStorm).mockResolvedValue(NO_STORM)
    onCypher(baseRules({ severity: 'warning' }))
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).outcome).toBe('skipped_severity')
    expect(historyWrites()).toEqual([expect.objectContaining({ kind: 'correlated', outcome: 'skipped_severity', incidentId: null, when: ON_CHANGE })])

    vi.clearAllMocks(); lockStore.clear(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(trackSourceStorm).mockResolvedValue(NO_STORM)
    vi.mocked(getEventPolicy).mockResolvedValue(policy({ open_delay_seconds: 30 }))
    onCypher(baseRules())
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).outcome).toBe('delayed')
    expect(historyWrites()).toEqual([expect.objectContaining({ kind: 'correlated', outcome: 'delayed', when: ON_CHANGE })])
  })

  it('dieta di rumore: la ripetizione già agganciata allo stesso incident non scrive nessuna voce; relazione esistente con esito diverso (pending) → voce condizionata al cambio', async () => {
    onCypher([...baseRules({ correlation: 'attached' }), [Q.group, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'in_progress' }], [Q.attach, { created: false }]])
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(historyWrites()).toEqual([])

    vi.clearAllMocks(); lockStore.clear(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(trackSourceStorm).mockResolvedValue(NO_STORM)
    onCypher([...baseRules({ correlation: 'pending' }), [Q.group, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'in_progress' }], [Q.attach, { created: false }]])
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(historyWrites()).toEqual([expect.objectContaining({ kind: 'correlated', outcome: 'attached', incidentId: 'inc-1', when: ON_CHANGE })])
  })

  it('risolto durante l\'attesa (resume): `correlated` none condizionato al cambio (da delayed)', async () => {
    onCypher(baseRules({ status: 'resolved', correlation: 'delayed', correlation_due_at: NOW }))
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, mode: 'resume' })
    expect(historyWrites()).toEqual([expect.objectContaining({ kind: 'correlated', outcome: 'none', when: ON_CHANGE })])
  })

  it('tempesta: `storm` con l\'incident (senza outcome) solo all\'aggancio nuovo; ripetizione già agganciata → niente; esito che cambia senza relazione nuova → `correlated` storm; storm_no_ci → `correlated` condizionato', async () => {
    vi.mocked(trackSourceStorm).mockResolvedValue(STORM)
    onCypher(baseRules({ severity: 'info' }))
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, created: true })
    expect(historyWrites()).toEqual([{ kind: 'storm', outcome: null, incidentId: 'inc-storm', changeId: null, actorId: 'monitoring', note: null, at: NOW, when: 'true' }])

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(trackSourceStorm).mockResolvedValue(STORM)
    onCypher([...baseRules({ correlation: 'storm' }), [Q.attach, { created: false }]])
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, created: false })
    expect(historyWrites()).toEqual([])

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(trackSourceStorm).mockResolvedValue(STORM)
    onCypher([...baseRules({ correlation: 'none' }), [Q.attach, { created: false }]])
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, created: false })
    expect(historyWrites()).toEqual([expect.objectContaining({ kind: 'correlated', outcome: 'storm', incidentId: 'inc-storm', when: ON_CHANGE })])

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(trackSourceStorm).mockResolvedValue({ ...STORM, incidentId: null })
    onCypher(baseRules({}, null))
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW, created: true })
    expect(historyWrites()).toEqual([expect.objectContaining({ kind: 'correlated', outcome: 'storm_no_ci', incidentId: null, when: ON_CHANGE })])
  })

  it('sfarfallio: `flapping` con la nota "N passaggi in M min" nello statement del SET; stabilizzazione: `stable` ("nessun passaggio in M min") nello statement che riporta lo stato, poi la correlazione', async () => {
    onCypher(baseRules({ transitions: FLAPPY }))
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(callMatching(Q.flap)!.cypher).toMatch(/e\.updated_at = \$now\s+FOREACH \(_ IN CASE WHEN true THEN \[1\] ELSE \[\] END \|\s+CREATE \(e\)-\[:HAS_HISTORY\]/)
    expect(historyWrites()).toEqual([expect.objectContaining({ kind: 'flapping', note: '4 passaggi in 10 min', actorId: 'monitoring', at: NOW, when: 'true' })])

    vi.clearAllMocks(); lockStore.clear(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(getStormState).mockResolvedValue(NO_STORM)
    let loads = 0
    onCypher([
      [Q.allFlap, [{ tenantId: 't1', id: 'ev-1' }]],
      ...baseRules().slice(1),
      [Q.load, () => (loads++ === 0
        ? { props: props({ status: 'flapping', flapping_since: minutesAgo(30), correlation: 'flapping', transitions: [minutesAgo(40), minutesAgo(16)], last_payload_status: 'firing' }), ciId: 'ci-1' }
        : { props: props({ status: 'firing', transitions: [minutesAgo(40), minutesAgo(16)] }), ciId: 'ci-1' })],
    ])
    await reevaluateFlappingEvents(NOW)
    expect(callMatching(Q.stabilize)!.cypher).toMatch(/e\.updated_at = \$now\s+FOREACH \(_ IN CASE WHEN true THEN \[1\] ELSE \[\] END \|\s+CREATE \(e\)-\[:HAS_HISTORY\]/)
    expect(historyWrites().map((h) => [h.kind, h.note, h.outcome])).toEqual([['stable', 'nessun passaggio in 15 min', null], ['correlated', null, 'opened']])
  })

  it('chiusura automatica: `auto_resolved` con l\'incident e il cammino percorso come nota (statement a sé, nella sessione della pipeline, PRIMA di event.correlated); `auto_resolve_skipped` con il motivo', async () => {
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'resolved', inputField: 'rootCause' }] as never)
    onCypher([...baseRules({ status: 'resolved', correlation: 'attached' }), [Q.linked, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'in_progress', stillFiring: 0 }]])
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    const h = callMatching(Q.history)!
    expect(h.cypher).toContain(historyWriteCypher())
    expect(h.params).toMatchObject({ eventId: 'ev-1', tenantId: 't1', historyKind: 'auto_resolved', historyIncidentId: 'inc-1', historyNote: null, historyOutcome: null, historyActorId: 'monitoring', historyAt: NOW })
    expect(vi.mocked(publishEvent).mock.invocationCallOrder[0]!).toBeGreaterThan(vi.mocked(runQueryOne).mock.invocationCallOrder.at(-1)!)

    // cammino di passi intermedi → nota "passando per …" (etichette dei passi)
    vi.clearAllMocks(); lockStore.clear(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(trackSourceStorm).mockResolvedValue(NO_STORM)
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'assigned' }] as never)
    onCypher([...baseRules({ status: 'resolved' }), [Q.linked, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'new', stillFiring: 0 }], [Q.defTr, [tr('new', 'assigned', { toLabel: 'Assegnato' }), tr('assigned', 'in_progress', { toLabel: 'In lavorazione' }), tr('in_progress', 'resolved', { condition: 'rootCause != null' })]]])
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).outcome).toBe('auto_resolved')
    expect(callMatching(Q.history)!.params).toMatchObject({ historyKind: 'auto_resolved', historyIncidentId: 'inc-1', historyNote: 'passando per Assegnato, In lavorazione' })

    // nessun cammino → auto_resolve_skipped con il motivo
    vi.clearAllMocks(); lockStore.clear(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(trackSourceStorm).mockResolvedValue(NO_STORM)
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'assigned' }] as never)
    onCypher([...baseRules({ status: 'resolved' }), [Q.linked, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'new', stillFiring: 0 }], [Q.defTr, [tr('new', 'assigned', { condition: 'assignee != null' })]]])
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).outcome).toBe('auto_resolve_skipped')
    expect(callMatching(Q.history)!.params).toMatchObject({ historyKind: 'auto_resolve_skipped', historyIncidentId: 'inc-1', historyNote: 'l\'incident è in "new" e non può essere risolto automaticamente da questo passo' })

    // un altro allarme ancora acceso → none: nessuna voce
    vi.clearAllMocks(); lockStore.clear(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(trackSourceStorm).mockResolvedValue(NO_STORM)
    onCypher([...baseRules({ status: 'resolved' }), [Q.linked, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'in_progress', stillFiring: 1 }]])
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).outcome).toBe('none')
    expect(callMatching(Q.history)).toBeUndefined()
  })

  it('chiusura automatica: la voce non scritta (evento sparito) → errore propagato, nessun event.correlated (fail-loud, mai fire-and-forget)', async () => {
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'resolved' }] as never)
    onCypher([...baseRules({ status: 'resolved' }), [Q.linked, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'in_progress', stillFiring: 0 }], [Q.history, null]])
    await expect(runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).rejects.toThrow(/Event ev-1 not found while appending history entry auto_resolved/)
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('apertura manuale (createIncidentFromEvent → openIncidentFromEvent manual): `incident_opened_manually` con l\'utente e l\'incident, senza outcome, sempre scritta', async () => {
    onCypher(baseRules())
    await openIncidentFromEvent({ tenantId: 't1', props: props(), ciId: 'ci-1', actorId: 'u-7', manual: true, now: NOW })
    expect(historyWrites()).toEqual([{ kind: 'incident_opened_manually', outcome: null, incidentId: 'inc-new', changeId: null, actorId: 'u-7', note: null, at: NOW, when: 'true' }])
    expect(callMatching(Q.setCorr)!.params).toMatchObject({ correlation: 'opened', dueAt: null })
  })
})
