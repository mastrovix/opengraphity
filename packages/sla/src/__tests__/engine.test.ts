import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DomainEvent } from '@opengraphity/types'

// ── Mocks: the engine is tested as a pure event → side-effect mapper ─────────

const markResponseMet   = vi.fn(async () => {})
const markResolveMet    = vi.fn()
const getSLAStatus      = vi.fn()
const createSLAStatus   = vi.fn()
const getEntityCreatedAt = vi.fn()
const cancelSLAJobs     = vi.fn(async () => {})
const scheduleWarning   = vi.fn(async () => {})
const scheduleBreachCheck = vi.fn(async () => {})
const scheduleResponseCheck = vi.fn(async () => {})
const selectSLAForEntity = vi.fn<(t: string, e: string, p: string | null, c: string | null, tm: string | null) => Promise<unknown>>(async () => null)
const getEntityScope = vi.fn(async () => ({ category: null as string | null, teamId: null as string | null }))

vi.mock('@opengraphity/events', () => ({
  BaseConsumer: class { constructor(public queueName: string) {} async start() {} async stop() {} },
}))
vi.mock('../status.js', () => ({
  markResponseMet, markResolveMet, getSLAStatus, createSLAStatus, getEntityCreatedAt, getEntityScope,
  pauseSLA: vi.fn(), resumeSLA: vi.fn(),
}))
const scheduleOLABreaches = vi.fn(async (_p: unknown) => {})
const getActiveOLAContractsFor = vi.fn(async (_t: string, _e: string) => [] as unknown[])
const getTenantTimezone = vi.fn(async (_t: string) => 'Europe/Rome')
vi.mock('../scheduler.js', () => ({
  initScheduler: vi.fn(), cancelSLAJobs, scheduleWarning, scheduleBreachCheck, scheduleResponseCheck,
  scheduleOLABreaches,
}))
vi.mock('../selector.js', () => ({ selectSLAForEntity }))
vi.mock('../olaBreach.js', () => ({ getActiveOLAContractsFor, getTenantTimezone }))

const { SLAEngine } = await import('../engine.js')

function event<T>(type: string, payload: T, timestamp = '2026-05-01T10:00:00.000Z'): DomainEvent<T> {
  return { id: 'evt-1', type, tenant_id: 't1', timestamp, correlation_id: 'c', actor_id: 'u', payload } as DomainEvent<T>
}

const POLICY_GENERICA = {
  id: 'pol-all', name: 'Tutti gli incident', timezone: 'Europe/Rome',
  response_minutes: 60, resolve_minutes: 480, business_hours: false,
}

const baseStatus = {
  id: 'sla-1', tenant_id: 't1', entity_id: 'inc-1', entity_type: 'incident',
  started_at: '2026-05-01T09:00:00.000Z',
  response_deadline: '2026-05-01T10:00:00.000Z', resolve_deadline: '2026-05-01T17:00:00.000Z',
  response_met: false, resolve_met: false, breached: false,
  tier: { severity: 'high', response_minutes: 60, resolve_minutes: 480, business_hours: false },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  createSLAStatus.mockResolvedValue(baseStatus)
  getSLAStatus.mockResolvedValue(baseStatus)
  markResolveMet.mockResolvedValue({ ...baseStatus, resolve_met: true })
  // Una policy del tenant che copre tutto: i test che non parlano di policy
  // vogliono uno SLA creato. Non ci sono più policy di fabbrica a cui ricadere.
  selectSLAForEntity.mockResolvedValue(POLICY_GENERICA)
  getActiveOLAContractsFor.mockResolvedValue([])
  getTenantTimezone.mockResolvedValue('Europe/Rome')
})

describe('SLAEngine — response met cancels the response timer (D-01)', () => {
  it('incident.assigned → markResponseMet then cancelSLAJobs(id, "response")', async () => {
    const engine = new SLAEngine()
    await engine.process(event('incident.assigned', { id: 'inc-1', assignedTo: 'u2' }))
    expect(markResponseMet).toHaveBeenCalledWith('t1', 'inc-1')
    expect(cancelSLAJobs).toHaveBeenCalledWith('inc-1', 'response')
    // Only the response timer: warning/breach stay armed.
    expect(cancelSLAJobs).toHaveBeenCalledTimes(1)
  })

  it('incident.assigned without an entity id fails loudly', async () => {
    const engine = new SLAEngine()
    await expect(engine.process(event('incident.assigned', {}))).rejects.toThrow('missing entity id')
    expect(markResponseMet).not.toHaveBeenCalled()
  })
})

describe('SLAEngine — SLA clock starts at the entity created_at (D-29)', () => {
  it('reads created_at from the node when the payload lacks it', async () => {
    getEntityCreatedAt.mockResolvedValue(new Date('2026-05-01T09:00:00.000Z'))
    const engine = new SLAEngine()
    await engine.process(event('incident.created', { id: 'inc-1', title: 'x', severity: 'high', affected_ci_ids: [] }))
    expect(getEntityCreatedAt).toHaveBeenCalledWith('t1', 'inc-1')
    const params = createSLAStatus.mock.calls[0]![0] as { startedAt: Date; severity: string }
    expect(params.startedAt.toISOString()).toBe('2026-05-01T09:00:00.000Z')
    expect(params.severity).toBe('high')
    expect(scheduleWarning).toHaveBeenCalled()
    expect(scheduleBreachCheck).toHaveBeenCalled()
    expect(scheduleResponseCheck).toHaveBeenCalled()
  })

  /**
   * Il payload è quello che `problemService` PUBBLICA DAVVERO — `priority`,
   * `status`, `assignedTo` — non quello che questo test si costruiva prima
   * (`impact: 'critical'`, campo che nessuno ha mai spedito, con un valore che
   * non è nemmeno del vocabolario dell'impatto). Con quel payload inventato il
   * test passava e il prodotto non creava **nessuno** SLA per **nessun**
   * problem: il motore leggeva `impact`, sempre `undefined`.
   *
   * Per questo il test asserisce anche il livello scelto: è l'asserzione che
   * lega il payload al risultato, e che prima mancava.
   */
  it('uses payload.created_at when present (no DB round-trip), and keys the tier on priority', async () => {
    const engine = new SLAEngine()
    await engine.process(event('problem.created', { id: 'prb-1', title: 'x', priority: 'critical', status: 'new', assignedTo: '—', created_at: '2026-05-01T08:30:00.000Z' }))
    expect(getEntityCreatedAt).not.toHaveBeenCalled()
    const params = createSLAStatus.mock.calls[0]![0] as { startedAt: Date; severity: string }
    expect(params.startedAt.toISOString()).toBe('2026-05-01T08:30:00.000Z')
    expect(params.severity).toBe('critical')
  })

  it('un problem SENZA priorità nel payload non riceve SLA, e lo dice', async () => {
    const engine = new SLAEngine()
    const errori: string[] = []
    const spia = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errori.push(a.join(' ')) })
    await engine.process(event('problem.created', { id: 'prb-2', title: 'x', status: 'new', assignedTo: '—', created_at: '2026-05-01T08:30:00.000Z' }))
    spia.mockRestore()
    expect(createSLAStatus).not.toHaveBeenCalled()
    expect(errori.join(' ')).toMatch(/No SLA tier for problem/)
  })

  it('propagates a missing created_at on the node (no silent "now" fallback)', async () => {
    getEntityCreatedAt.mockRejectedValue(new Error('created_at of entity inc-1 is missing'))
    const engine = new SLAEngine()
    await expect(
      engine.process(event('incident.created', { id: 'inc-1', title: 'x', severity: 'high', affected_ci_ids: [] })),
    ).rejects.toThrow('created_at of entity inc-1 is missing')
    expect(createSLAStatus).not.toHaveBeenCalled()
  })
})

describe('SLAEngine — resolution passes the real resolved_at (D-02)', () => {
  it('incident.resolved → markResolveMet(tenant, id, payload.resolved_at) and cancels all timers', async () => {
    const engine = new SLAEngine()
    await engine.process(event('incident.resolved', { entity_id: 'inc-1', resolved_at: '2026-05-01T12:00:00.000Z' }))
    expect(markResolveMet).toHaveBeenCalledTimes(1)
    const [tenant, id, at] = markResolveMet.mock.calls[0]! as unknown as [string, string, Date]
    expect(tenant).toBe('t1'); expect(id).toBe('inc-1')
    expect(at.toISOString()).toBe('2026-05-01T12:00:00.000Z')
    expect(cancelSLAJobs).toHaveBeenCalledWith('inc-1')
  })

  it('request.completed uses completed_at; without it the event timestamp', async () => {
    const engine = new SLAEngine()
    await engine.process(event('request.completed', { id: 'sr-1', completed_at: '2026-05-02T09:00:00.000Z', fulfilled_by_id: 'u' }))
    expect((markResolveMet.mock.calls[0]![2] as unknown as Date).toISOString()).toBe('2026-05-02T09:00:00.000Z')
    await engine.process(event('problem.resolved', { id: 'prb-1' }, '2026-05-03T09:00:00.000Z'))
    expect((markResolveMet.mock.calls[1]![2] as unknown as Date).toISOString()).toBe('2026-05-03T09:00:00.000Z')
  })

  it('skips entities without an SLAStatus', async () => {
    getSLAStatus.mockResolvedValue(null)
    const engine = new SLAEngine()
    await engine.process(event('incident.resolved', { id: 'inc-9', resolved_at: '2026-05-01T12:00:00.000Z' }))
    expect(markResolveMet).not.toHaveBeenCalled()
    expect(cancelSLAJobs).not.toHaveBeenCalled()
  })
})

/**
 * L'AMBITO della policy: categoria e team.
 *
 * `resolvePolicy` passava `null, null` al selettore, sempre. Il selettore sa
 * distinguere cinque specificità (priorità+categoria+team, priorità+categoria,
 * priorità, categoria, tutto) e con due null ne restavano raggiungibili due:
 * «priorità sola» e «tutto». Una policy con una categoria o un team non si
 * applicava MAI — e la pagina «Policy SLA» la offre, e ne stampa perfino la
 * riga «Si applica a: Incident con categoria network».
 *
 * Provato dal browser: creata quella policy (7 min di risposta), aperto un
 * incident di categoria `network` → l'incident ha ricevuto i 240 minuti del
 * livello `medium` di fabbrica.
 */
describe('SLAEngine — l\'ambito della policy (categoria e team) arriva al selettore', () => {
  it('categoria e team dell\'entità vengono passati, non null', async () => {
    getEntityScope.mockResolvedValue({ category: 'network', teamId: 'team-rete' })
    getEntityCreatedAt.mockResolvedValue(new Date('2026-05-01T09:00:00.000Z'))
    const engine = new SLAEngine()
    await engine.process(event('incident.created', { id: 'inc-9', title: 'x', severity: 'medium', affected_ci_ids: [] }))
    expect(selectSLAForEntity).toHaveBeenCalledWith('t1', 'incident', 'medium', 'network', 'team-rete')
  })

  it('un\'entità senza categoria né team passa null: una policy che li chiede non deve applicarsi', async () => {
    getEntityScope.mockResolvedValue({ category: null, teamId: null })
    getEntityCreatedAt.mockResolvedValue(new Date('2026-05-01T09:00:00.000Z'))
    const engine = new SLAEngine()
    await engine.process(event('incident.created', { id: 'inc-10', title: 'x', severity: 'medium', affected_ci_ids: [] }))
    expect(selectSLAForEntity).toHaveBeenCalledWith('t1', 'incident', 'medium', null, null)
  })

  it('la policy del tenant sceglie lo SLA, e i suoi minuti arrivano allo stato', async () => {
    getEntityScope.mockResolvedValue({ category: 'network', teamId: null })
    getEntityCreatedAt.mockResolvedValue(new Date('2026-05-01T09:00:00.000Z'))
    selectSLAForEntity.mockResolvedValue({
      id: 'pol-1', name: 'Incident di rete', timezone: 'Europe/Rome',
      response_minutes: 7, resolve_minutes: 30, business_hours: true,
    })
    const engine = new SLAEngine()
    await engine.process(event('incident.created', { id: 'inc-11', title: 'x', severity: 'medium', affected_ci_ids: [] }))
    const params = createSLAStatus.mock.calls[0]![0] as { policy: { name: string; tiers: { severity: string; response_minutes: number; resolve_minutes: number }[] } }
    expect(params.policy.name).toBe('Incident di rete')
    expect(params.policy.tiers[0]!.response_minutes).toBe(7)
    expect(params.policy.tiers[0]!.resolve_minutes).toBe(30)
    expect(params.policy.tiers[0]!.severity).toBe('medium')
  })
})

/**
 * NESSUNA POLICY DI FABBRICA. Un ticket che nessuna policy del tenant copre
 * riceveva lo SLA da «Default Incident SLA», scritta nel codice e invisibile
 * nella pagina SLA Policies: su c-test 6 SLA su 8 venivano da lì.
 */
describe('SLAEngine — senza una policy del tenant, nessuno SLA', () => {
  it('nessuna policy corrisponde → nessuno SLA, nessun timer, e lo dice nel log', async () => {
    selectSLAForEntity.mockResolvedValue(null)
    getEntityCreatedAt.mockResolvedValue(new Date('2026-05-01T09:00:00.000Z'))
    const avvisi: string[] = []
    const spia = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { avvisi.push(a.join(' ')) })
    const engine = new SLAEngine()
    await engine.process(event('incident.created', { id: 'inc-20', title: 'x', severity: 'critical', affected_ci_ids: [] }))
    spia.mockRestore()
    expect(createSLAStatus).not.toHaveBeenCalled()
    expect(scheduleWarning).not.toHaveBeenCalled()
    expect(scheduleBreachCheck).not.toHaveBeenCalled()
    expect(scheduleResponseCheck).not.toHaveBeenCalled()
    expect(avvisi.join(' ')).toMatch(/No SLA policy matches incident inc-20/)
  })

  it('i controlli OLA/UC si armano anche senza SLA, col fuso del tenant', async () => {
    selectSLAForEntity.mockResolvedValue(null)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const contratto = { id: 'ola-1', name: 'Rete', type: 'ola', resolve_minutes: 240, business_hours: true }
    getActiveOLAContractsFor.mockResolvedValue([contratto])
    getTenantTimezone.mockResolvedValue('America/New_York')
    const engine = new SLAEngine()
    await engine.process(event('incident.created', { id: 'inc-21', title: 'x', severity: 'medium', affected_ci_ids: [] }))
    expect(createSLAStatus).not.toHaveBeenCalled()
    expect(getTenantTimezone).toHaveBeenCalledWith('t1')
    expect(scheduleOLABreaches).toHaveBeenCalledWith(expect.objectContaining({
      entityId: 'inc-21', tenantId: 't1', timezone: 'America/New_York', contracts: [contratto],
    }))
  })
})

/**
 * Presa in carico e conclusione da QUALUNQUE cammino del workflow.
 * Giro del 14 set 2026: PRB00000004 risolto dalla sua change e REQ00000002
 * chiusa dal workflow restavano con lo SLA aperto per sempre.
 */
describe('SLAEngine — workflow.step_entered', () => {
  const step = (over: Record<string, unknown>) => event('workflow.step_entered', {
    entity_type: 'problem', entity_id: 'prb-1', from_step: 'new', from_initial: false,
    step_name: 'under_investigation', step_category: 'active', step_terminal: false,
    entered_at: '2026-05-01T11:00:00.000Z', trigger_type: 'automatic', ...over,
  })

  it('lasciare il passo iniziale segna la risposta e spegne solo il timer di risposta', async () => {
    getSLAStatus.mockResolvedValue({ ...baseStatus, entity_id: 'prb-1', response_met: false })
    await new SLAEngine().process(step({ from_initial: true }))
    expect(markResponseMet).toHaveBeenCalledWith('t1', 'prb-1')
    expect(cancelSLAJobs).toHaveBeenCalledWith('prb-1', 'response')
    expect(markResolveMet).not.toHaveBeenCalled()
  })

  it('un problem che entra in un passo «resolved» (anche da una change) chiude lo SLA all\'istante dell\'ingresso', async () => {
    getSLAStatus.mockResolvedValue({ ...baseStatus, entity_id: 'prb-1', response_met: true })
    await new SLAEngine().process(step({ step_name: 'resolved', step_category: 'resolved', step_terminal: true }))
    expect(markResolveMet).toHaveBeenCalledWith('t1', 'prb-1', new Date('2026-05-01T11:00:00.000Z'))
    expect(cancelSLAJobs).toHaveBeenCalledWith('prb-1')
  })

  it('una richiesta che entra in un passo terminale di categoria «closed» chiude lo SLA', async () => {
    getSLAStatus.mockResolvedValue({ ...baseStatus, entity_id: 'req-1', entity_type: 'service_request', response_met: true })
    await new SLAEngine().process(step({ entity_type: 'service_request', entity_id: 'req-1', step_name: 'closed', step_category: 'closed', step_terminal: true }))
    expect(markResolveMet).toHaveBeenCalledWith('t1', 'req-1', new Date('2026-05-01T11:00:00.000Z'))
  })

  it('idempotente: uno SLA già concluso non si riscrive (un «chiuso» dopo il «risolto»)', async () => {
    getSLAStatus.mockResolvedValue({ ...baseStatus, entity_id: 'prb-1', response_met: true, resolved_at: '2026-05-01T10:30:00.000Z' })
    await new SLAEngine().process(step({ from_initial: true, step_name: 'closed', step_category: 'closed', step_terminal: true }))
    expect(markResponseMet).not.toHaveBeenCalled()
    expect(markResolveMet).not.toHaveBeenCalled()
  })

  it('anche incident.resolved, se lo SLA è già concluso, non sposta data ed esito', async () => {
    getSLAStatus.mockResolvedValue({ ...baseStatus, resolved_at: '2026-05-01T10:30:00.000Z' })
    await new SLAEngine().process(event('incident.resolved', { entity_id: 'inc-1', resolved_at: '2026-05-02T10:00:00.000Z' }))
    expect(markResolveMet).not.toHaveBeenCalled()
  })

  it('ticket senza SLA o di un tipo senza SLA: niente', async () => {
    getSLAStatus.mockResolvedValue(null)
    await new SLAEngine().process(step({ from_initial: true, step_category: 'resolved' }))
    await new SLAEngine().process(step({ entity_type: 'change', from_initial: true, step_category: 'closed', step_terminal: true }))
    expect(markResponseMet).not.toHaveBeenCalled()
    expect(markResolveMet).not.toHaveBeenCalled()
  })
})
