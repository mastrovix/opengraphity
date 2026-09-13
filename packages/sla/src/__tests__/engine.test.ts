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
vi.mock('../scheduler.js', () => ({
  initScheduler: vi.fn(), cancelSLAJobs, scheduleWarning, scheduleBreachCheck, scheduleResponseCheck,
  scheduleOLABreaches: vi.fn(async () => {}),
}))
vi.mock('../selector.js', () => ({ selectSLAForEntity }))
vi.mock('../olaBreach.js', () => ({ getActiveOLAContractsFor: vi.fn(async () => []) }))

const { SLAEngine } = await import('../engine.js')

function event<T>(type: string, payload: T, timestamp = '2026-05-01T10:00:00.000Z'): DomainEvent<T> {
  return { id: 'evt-1', type, tenant_id: 't1', timestamp, correlation_id: 'c', actor_id: 'u', payload } as DomainEvent<T>
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

  it('la policy del tenant vince sui default, e i suoi minuti arrivano allo stato', async () => {
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
