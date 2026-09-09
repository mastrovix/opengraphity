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
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(),
  toNumber: (v: unknown) => (v == null ? 0 : Number(v)),
}))
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
vi.mock('../../lib/workflowHelpers.js', () => ({ getWorkflowSteps: vi.fn() }))
vi.mock('../incidentService.js', () => ({
  createIncident: vi.fn(), resolveIncident: vi.fn(), addIncidentComment: vi.fn().mockResolvedValue(undefined), publishIncidentTransition: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../eventService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../eventService.js')>()),
  getEventPolicy: vi.fn(), recomputeCIHealth: vi.fn().mockResolvedValue('down'),
}))
vi.mock('../../jobs/eventCorrelateWorker.js', () => ({ enqueueCorrelation: vi.fn().mockResolvedValue(undefined) }))

const corr = await import('../eventCorrelation.js')
const { runEventPipeline, findSuppressingChange, reevaluateSuppressedEvents, reevaluateClosedWindows, openIncidentFromEvent, meetsOpenThreshold, changeIsInWindow, findAutoResolvePath, CHANGE_IMPLEMENTATION_STEP, CHANGE_WINDOW_STEPS, MONITORING_ACTOR, AUTO_RESOLVE_MAX_HOPS } = corr
const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { workflowEngine, INCIDENT_WORKFLOW_BASE } = await import('@opengraphity/workflow')
const { publishEvent } = await import('../../lib/publishEvent.js')
const { audit } = await import('../../lib/audit.js')
const { getWorkflowSteps } = await import('../../lib/workflowHelpers.js')
const incidentService = await import('../incidentService.js')
const { getEventPolicy, recomputeCIHealth } = await import('../eventService.js')
const { enqueueCorrelation } = await import('../../jobs/eventCorrelateWorker.js')
const { DEFAULT_EVENT_POLICY } = await import('../../lib/eventPolicy.js')

const session = { close: vi.fn().mockResolvedValue(undefined) }
const NOW = '2026-09-09T10:00:00.000Z'
const MON = { tenantId: 't1', userId: MONITORING_ACTOR }

const INCIDENT_STEPS = [
  { name: 'new',         isInitial: true,  isTerminal: false, isOpen: true,  category: 'new',      stepOrder: 1 },
  { name: 'assigned',    isInitial: false, isTerminal: false, isOpen: true,  category: 'active',   stepOrder: 2 },
  { name: 'in_progress', isInitial: false, isTerminal: false, isOpen: true,  category: 'active',   stepOrder: 3 },
  { name: 'resolved',    isInitial: false, isTerminal: false, isOpen: true,  category: 'resolved', stepOrder: 4 },
  { name: 'closed',      isInitial: false, isTerminal: true,  isOpen: false, category: 'closed',   stepOrder: 5 },
]

/** Dispatch dei mock per frammento di Cypher: l'ULTIMA regola che combacia vince (così `[...baseRules(), override]` funziona). */
function onCypher(rules: Array<[RegExp, unknown]>) {
  const impl = async (_s: unknown, cypher: string) => {
    for (const [re, value] of [...rules].reverse()) if (re.test(cypher)) return typeof value === 'function' ? (value as () => unknown)() : value
    throw new Error(`unexpected cypher in test:\n${cypher}`)
  }
  vi.mocked(runQueryOne).mockImplementation(impl as never)
  vi.mocked(runQuery).mockImplementation((async (s: unknown, c: string) => { const r = await impl(s, c); return r == null ? [] : Array.isArray(r) ? r : [r] }) as never)
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
  setCorr:     /SET e\.correlation = \$correlation/,
  ever:        /RETURN count\(i\) AS n/,
  group:       /NOT wi\.current_step IN \$terminalSteps OR wi\.current_step = \$resolvedStep\s+RETURN DISTINCT i\.id/,
  attach:      /MERGE \(e\)-\[r:CORRELATED_INTO\]/,
  linked:      /count\(DISTINCT other\) AS stillFiring/,
  defTr:       /HAS_STEP\]->\(from:WorkflowStep\)\s+MATCH \(from\)-\[tr:TRANSITIONS_TO\]->\(to:WorkflowStep\)/,
  byChange:    /status: 'suppressed', suppressed_by_change_id: \$changeId/,
  allSupp:     /MATCH \(e:Event \{status: 'suppressed'\}\)/,
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
  count: 3, first_seen_at: 'T0', last_seen_at: 'T1', source_id: 'hook-1', correlation: 'none', correlation_at: null, correlation_due_at: null, suppressed_by_change_id: null, ...over,
})
const policy = (over: Partial<typeof DEFAULT_EVENT_POLICY> = {}) => ({ ...structuredClone(DEFAULT_EVENT_POLICY), ...over })

/** Regole base: evento con CI, nessuna change in finestra, nessun incident aperto, scritture ok. */
function baseRules(ev: Record<string, unknown> = {}, ciId: string | null = 'ci-1'): Array<[RegExp, unknown]> {
  return [
    [Q.load, { props: props(ev), ciId }],
    [Q.suppressing, []],
    [Q.suppress, { id: 'ev-1' }],
    [Q.lift, null],
    [Q.setCorr, null],
    [Q.ever, { n: 0 }],
    [Q.group, null],
    [Q.attach, { created: true }],
    [Q.linked, null],
  ]
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockReturnValue(session as never)
  vi.mocked(getEventPolicy).mockResolvedValue(policy())
  vi.mocked(getWorkflowSteps).mockResolvedValue(INCIDENT_STEPS)
  vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([] as never)
  vi.mocked(workflowEngine.transition).mockResolvedValue({ success: true } as never)
  vi.mocked(incidentService.createIncident).mockResolvedValue({ id: 'inc-new', number: 'INC00000009' } as never)
  vi.mocked(incidentService.resolveIncident).mockResolvedValue({ id: 'inc-1' } as never)
})

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

  it('changeIsInWindow: deployment sempre; scheduled solo con una finestra del piano che contiene l\'istante; altri passi mai', () => {
    const at = Date.parse(NOW)
    const plan = JSON.stringify([{ title: 'go', validationWindow: { start: '2026-09-09T08:00:00Z', end: '2026-09-09T09:00:00Z' }, releaseWindow: { start: '2026-09-09T09:30:00Z', end: '2026-09-09T11:00:00Z' } }])
    const past = JSON.stringify([{ title: 'old', validationWindow: { start: '', end: '' }, releaseWindow: { start: '2026-09-08T09:00:00Z', end: '2026-09-08T11:00:00Z' } }])
    expect(CHANGE_IMPLEMENTATION_STEP).toBe('deployment')
    expect(CHANGE_WINDOW_STEPS).toEqual(['deployment', 'scheduled'])
    expect(changeIsInWindow('deployment', [], at)).toBe(true)
    expect(changeIsInWindow('scheduled', [plan], at)).toBe(true)
    expect(changeIsInWindow('scheduled', [past, null], at)).toBe(false)
    expect(changeIsInWindow('scheduled', [], at)).toBe(false)
    expect(changeIsInWindow('review', [plan], at)).toBe(false)
    expect(changeIsInWindow('approval', [plan], at)).toBe(false)
  })
})

// ── 1. Soppressione ──────────────────────────────────────────────────────────

describe('soppressione in finestra di change', () => {
  it('change in deployment sul CI diretto → suppressed, SUPPRESSED_BY, event.suppressed con change_id; NESSUNA salute, NESSUN incident', async () => {
    onCypher([...baseRules(), [Q.suppressing, [{ changeId: 'chg-1', code: 'CHG1', step: 'deployment', plans: [null] }]]])
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out).toEqual({ outcome: 'suppressed', status: 'suppressed', suppressedByChangeId: 'chg-1', incidentId: null })

    const find = callMatching(Q.suppressing)!
    expect(find.cypher).toContain('MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})')
    expect(find.cypher).toContain('[:DEPENDS_ON*1..1]->(up:ConfigurationItem {tenant_id: $tenantId})')   // hops = 1 (policy predefinita)
    expect(find.cypher).toContain('MATCH (c:Change {tenant_id: $tenantId})-[:AFFECTS_CI]->(target)')
    expect(find.cypher).toContain('coalesce(c.deleted, false) = false')
    expect(find.cypher).toContain('wi.current_step IN $windowSteps')
    expect(find.params).toMatchObject({ ciId: 'ci-1', tenantId: 't1', windowSteps: ['deployment', 'scheduled'], implementationStep: 'deployment' })

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
    onCypher([...baseRules(), [Q.suppressing, [{ changeId: 'chg-up', code: 'CHG2', step: 'deployment', plans: [] }]]])
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).outcome).toBe('suppressed')
    expect(callMatching(Q.suppressing)!.cypher).toContain('[:DEPENDS_ON*1..2]')

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    vi.mocked(getEventPolicy).mockResolvedValue(policy({ suppress_upstream_hops: 0 }))
    onCypher(baseRules())   // nessuna change collegata direttamente
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out.outcome).toBe('opened')
    const find = callMatching(Q.suppressing)!
    expect(find.cypher).not.toContain('DEPENDS_ON')
    expect(find.cypher).toContain('WITH ci, [] AS ups')
    expect(recomputeCIHealth).toHaveBeenCalledWith('t1', 'ci-1', 'monitoring')
  })

  it('change approvata (scheduled) con releaseWindow che contiene l\'istante → suppressed; finestra passata → non soppresso, salute e correlazione procedono', async () => {
    const inWindow = JSON.stringify([{ title: 'r', validationWindow: { start: '', end: '' }, releaseWindow: { start: '2026-09-09T09:00:00Z', end: '2026-09-09T12:00:00Z' } }])
    onCypher([...baseRules(), [Q.suppressing, [{ changeId: 'chg-s', code: 'CHG3', step: 'scheduled', plans: [inWindow] }]]])
    expect((await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })).outcome).toBe('suppressed')
    expect(callMatching(Q.suppress)!.params['changeId']).toBe('chg-s')

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    const past = JSON.stringify([{ title: 'r', validationWindow: { start: '2026-09-08T09:00:00Z', end: '2026-09-08T10:00:00Z' }, releaseWindow: { start: '2026-09-08T10:00:00Z', end: '2026-09-08T12:00:00Z' } }])
    onCypher([...baseRules(), [Q.suppressing, [{ changeId: 'chg-s', code: 'CHG3', step: 'scheduled', plans: [past] }]]])
    const out = await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(out.outcome).toBe('opened')
    expect(callMatching(Q.suppress)).toBeUndefined()
    expect(recomputeCIHealth).toHaveBeenCalledWith('t1', 'ci-1', 'monitoring')
    expect(published()).not.toContain('event.suppressed')
  })

  it('ripetizione dello stesso allarme nella stessa finestra → resta suppressed senza un nuovo event.suppressed; change diversa → nuovo avviso', async () => {
    onCypher([...baseRules({ status: 'suppressed', suppressed_by_change_id: 'chg-1', correlation: 'suppressed' }), [Q.suppressing, [{ changeId: 'chg-1', code: 'CHG1', step: 'deployment', plans: [] }]]])
    await runEventPipeline({ tenantId: 't1', eventId: 'ev-1', now: NOW })
    expect(callMatching(Q.suppress)).toBeDefined()
    expect(publishEvent).not.toHaveBeenCalled()

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([...baseRules({ status: 'suppressed', suppressed_by_change_id: 'chg-1', correlation: 'suppressed' }), [Q.suppressing, [{ changeId: 'chg-2', code: 'CHG2', step: 'deployment', plans: [] }]]])
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
    expect(l.cypher).toContain("WHERE other.status <> 'resolved'")
    expect(l.params).toMatchObject({ eventId: 'ev-1', tenantId: 't1', terminalSteps: ['closed'] })
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

  it('incident in "new" con il workflow seed → percorre tr-new-assigned e tr-assigned-inprogress (nell\'ordine, con note e side effect della mutation manuale) e poi risolve → auto_resolved', async () => {
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
      'transition:assigned',    'comment:Workflow: assigned',
      'transition:in_progress', 'comment:Workflow: in_progress',
      'resolveIncident',        'comment:Risolto automaticamente: tutti gli allarmi di monitoraggio correlati sono rientrati (ultimo: DiskFull)',
    ])
    expect(workflowEngine.transition).toHaveBeenNthCalledWith(1, session,
      { instanceId: 'wi-1', toStepName: 'assigned', triggeredBy: 'monitoring', triggerType: 'manual', notes: 'Chiusura automatica dal monitoraggio: passaggio a Assegnato', tenantId: 't1' },
      { userId: 'monitoring', notes: 'Chiusura automatica dal monitoraggio: passaggio a Assegnato', entityData: {} })
    expect(workflowEngine.transition).toHaveBeenNthCalledWith(2, session,
      expect.objectContaining({ toStepName: 'in_progress', triggerType: 'manual', notes: 'Chiusura automatica dal monitoraggio: passaggio a In Lavorazione' }),
      expect.objectContaining({ userId: 'monitoring' }))
    expect(incidentService.addIncidentComment).toHaveBeenCalledWith('inc-1', MON, 'Workflow: assigned — Chiusura automatica dal monitoraggio: passaggio a Assegnato')
    expect(incidentService.addIncidentComment).toHaveBeenCalledWith('inc-1', MON, 'Workflow: in_progress — Chiusura automatica dal monitoraggio: passaggio a In Lavorazione')
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
    // il primo passo (assigned) è persistito e ha i suoi side effect; il secondo no
    expect(vi.mocked(incidentService.publishIncidentTransition).mock.calls).toEqual([['inc-1', 'assigned', MON]])
    expect(incidentService.addIncidentComment).toHaveBeenCalledTimes(1)
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
    onCypher([...baseRules({ status: 'suppressed', suppressed_by_change_id: 'chg-1', correlation: 'suppressed' }), [Q.byChange, [{ id: 'ev-1' }]], [Q.suppressing, [{ changeId: 'chg-2', code: 'CHG2', step: 'deployment', plans: [] }]]])
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
    await expect(reevaluateClosedWindows()).resolves.toEqual({ evaluated: 0, failed: 0 })
  })
})
