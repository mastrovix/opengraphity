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
const getEntityPriority = vi.fn(async () => 'high' as unknown)
const resumeSLA = vi.fn()
const reopenSLA = vi.fn()
const repolicySLA = vi.fn()
const pauseSLA = vi.fn()
vi.mock('../status.js', () => ({
  markResponseMet, markResolveMet, getSLAStatus, createSLAStatus, getEntityCreatedAt, getEntityScope, getEntityPriority,
  pauseSLA, resumeSLA, reopenSLA, repolicySLA,
}))
const getActiveOLAContractsFor = vi.fn(async (_t: string, _e: string) => [] as unknown[])
const getTenantTimezone = vi.fn(async (_t: string) => 'Europe/Rome')
vi.mock('../scheduler.js', () => ({
  initScheduler: vi.fn(), cancelSLAJobs, scheduleWarning, scheduleBreachCheck, scheduleResponseCheck,
}))
vi.mock('../selector.js', () => ({ selectSLAForEntity }))
// Ondata 2 della verifica «Cosa resta cablato»: ogni policy e ogni contratto conta col SUO calendario.
const CALENDARIO = { days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '13:00', holidays: ['2026-12-25'] }
const calendarFor = vi.fn(async (_t: string, owner: { businessHours: boolean; calendarId: string | null }) => (owner.businessHours ? CALENDARIO : null) as unknown)
vi.mock('../olaBreach.js', () => ({ getActiveOLAContractsFor, getTenantTimezone }))
vi.mock('../calendar.js', () => ({ calendarFor }))

const { SLAEngine, createSLAEngine } = await import('../engine.js')

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
      response_minutes: 7, resolve_minutes: 30, business_hours: true, calendar_id: 'cal-rete',
    })
    const engine = new SLAEngine()
    await engine.process(event('incident.created', { id: 'inc-11', title: 'x', severity: 'medium', affected_ci_ids: [] }))
    const params = createSLAStatus.mock.calls[0]![0] as { policy: { name: string; tiers: { severity: string; response_minutes: number; resolve_minutes: number }[] } }
    expect(params.policy.name).toBe('Incident di rete')
    expect(params.policy.tiers[0]!.response_minutes).toBe(7)
    expect(params.policy.tiers[0]!.resolve_minutes).toBe(30)
    expect(params.policy.tiers[0]!.severity).toBe('medium')
    // L'orario di servizio è il calendario scelto dalla policy (ondata 2).
    expect((params.policy as unknown as { calendar: unknown }).calendar).toEqual(CALENDARIO)
    expect(calendarFor).toHaveBeenCalledWith('t1', { name: 'Incident di rete', businessHours: true, calendarId: 'cal-rete' })
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

  it('i controlli OLA/UC non si armano più alla creazione: li fa la passata dell\'API sul tempo del team', async () => {
    selectSLAForEntity.mockResolvedValue(null)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    getActiveOLAContractsFor.mockResolvedValue([{ id: 'ola-1', name: 'Rete', type: 'ola', resolve_minutes: 240, business_hours: false }])
    await new SLAEngine().process(event('incident.created', { id: 'inc-21', title: 'x', severity: 'medium', affected_ci_ids: [] }))
    expect(getActiveOLAContractsFor).not.toHaveBeenCalled()
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

/**
 * WA-1 (revisione del 14 set 2026): «avvia SLA» e «ferma SLA» delle azioni di
 * passo pubblicavano eventi che il motore non conosceva.
 */
describe('SLAEngine — azioni di passo sla_start / sla_stop', () => {
  it('sla.resolve.start senza SLA → sceglie la policy adesso e l\'orologio parte dall\'evento', async () => {
    getSLAStatus.mockResolvedValueOnce(null)
    await new SLAEngine().process(event('sla.resolve.start', { entity_id: 'inc-1', entity_type: 'incident', sla_type: 'resolve' }, '2026-05-02T08:00:00.000Z'))
    expect(getEntityPriority).toHaveBeenCalledWith('t1', 'incident', 'inc-1')
    expect(createSLAStatus).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'inc-1', severity: 'high', startedAt: new Date('2026-05-02T08:00:00.000Z') }))
    expect(scheduleBreachCheck).toHaveBeenCalled()
  })

  it('sla.response.start con uno SLA in pausa → riprende', async () => {
    getSLAStatus.mockResolvedValueOnce({ ...baseStatus, paused_at: '2026-05-01T11:00:00.000Z', paused_type: 'response' })
    resumeSLA.mockResolvedValueOnce({ ...baseStatus, paused_type: 'response' })
    await new SLAEngine().process(event('sla.response.start', { entity_id: 'inc-1', entity_type: 'incident', sla_type: 'response' }))
    expect(resumeSLA).toHaveBeenCalledWith('t1', 'inc-1', expect.any(Date))
    expect(createSLAStatus).not.toHaveBeenCalled()
  })

  /**
   * Revisione totale · E-12: alla ripresa di una pausa l'orologio della
   * risposta veniva riprogrammato ogni volta che `response_met` era falso,
   * senza sapere se l'avviso era già uscito — e `scheduleResponseCheck` con
   * una scadenza passata usa `Math.max(delay, 0)`, quindi scattava subito: un
   * secondo «tempo di presa in carico scaduto» identico.
   */
  it('ripresa dopo che l\'avviso della presa in carico è già uscito → nessun secondo avviso (E-12)', async () => {
    getSLAStatus.mockResolvedValueOnce({ ...baseStatus, paused_at: '2026-05-01T11:00:00.000Z', paused_type: 'both' })
    resumeSLA.mockResolvedValueOnce({ ...baseStatus, paused_type: 'both', response_breach_notified_at: '2026-05-01T10:00:00.000Z' })
    await new SLAEngine().process(event('sla.response.start', { entity_id: 'inc-1', entity_type: 'incident', sla_type: 'response' }))
    expect(scheduleResponseCheck).not.toHaveBeenCalled()
    // l'orologio della risoluzione riparte comunque
    expect(scheduleBreachCheck).toHaveBeenCalled()
  })

  it('ripresa senza avviso già uscito → l\'orologio della risposta riparte', async () => {
    getSLAStatus.mockResolvedValueOnce({ ...baseStatus, paused_at: '2026-05-01T11:00:00.000Z', paused_type: 'both' })
    resumeSLA.mockResolvedValueOnce({ ...baseStatus, paused_type: 'both' })
    await new SLAEngine().process(event('sla.response.start', { entity_id: 'inc-1', entity_type: 'incident', sla_type: 'response' }))
    expect(scheduleResponseCheck).toHaveBeenCalled()
  })

  it('sla.response.start con uno SLA che corre → nulla', async () => {
    await new SLAEngine().process(event('sla.response.start', { entity_id: 'inc-1', entity_type: 'incident', sla_type: 'response' }))
    expect(createSLAStatus).not.toHaveBeenCalled()
    expect(resumeSLA).not.toHaveBeenCalled()
  })

  it('sla.response.stop → obiettivo di risposta raggiunto', async () => {
    await new SLAEngine().process(event('sla.response.stop', { entity_id: 'inc-1', sla_type: 'response' }))
    expect(markResponseMet).toHaveBeenCalledWith('t1', 'inc-1')
    expect(cancelSLAJobs).toHaveBeenCalledWith('inc-1', 'response')
  })
})

/** SL-3 (revisione del 14 set 2026): un ticket riaperto riapre lo SLA. */
describe('SLAEngine — riapertura', () => {
  const stepEntered = (over: Record<string, unknown>) => event('workflow.step_entered', {
    entity_type: 'incident', entity_id: 'inc-1', from_step: 'resolved', from_initial: false, step_name: 'in_progress',
    step_category: 'active', step_terminal: false, entered_at: '2026-05-02T09:00:00.000Z', trigger_type: 'manual', ...over,
  })

  it('da risolto a un passo aperto → reopenSLA e i controlli ripartono', async () => {
    getSLAStatus.mockResolvedValueOnce({ ...baseStatus, resolved_at: '2026-05-01T12:00:00.000Z', resolve_met: true })
    reopenSLA.mockResolvedValueOnce({ ...baseStatus, resolve_deadline: '2026-05-02T14:00:00.000Z' })
    await new SLAEngine().process(stepEntered({}))
    expect(reopenSLA).toHaveBeenCalledWith('t1', 'inc-1', new Date('2026-05-02T09:00:00.000Z'))
    expect(scheduleWarning).toHaveBeenCalled()
    expect(scheduleBreachCheck).toHaveBeenCalled()
    expect(markResolveMet).not.toHaveBeenCalled()
  })

  it('SLA già violato: si riapre ma la violazione non si riprogramma', async () => {
    getSLAStatus.mockResolvedValueOnce({ ...baseStatus, resolved_at: '2026-05-01T20:00:00.000Z', breached: true })
    reopenSLA.mockResolvedValueOnce({ ...baseStatus, breached: true })
    await new SLAEngine().process(stepEntered({}))
    expect(reopenSLA).toHaveBeenCalled()
    expect(scheduleBreachCheck).not.toHaveBeenCalled()
  })

  it('SLA aperto che entra in un passo aperto → nessuna riapertura', async () => {
    await new SLAEngine().process(stepEntered({ from_step: 'assigned' }))
    expect(reopenSLA).not.toHaveBeenCalled()
  })
})

/** Revisione del 14 set 2026 · F4, SL-1, SL-8, SL-10. */
describe('SLAEngine — coerenza fra i ticket', () => {
  const stepEntered = (over: Record<string, unknown>) => event('workflow.step_entered', {
    entity_type: 'problem', entity_id: 'inc-1', from_step: 'under_investigation', from_initial: false, step_name: 'waiting_vendor',
    step_category: 'waiting', step_terminal: false, entered_at: '2026-05-02T09:00:00.000Z', trigger_type: 'manual', ...over,
  })

  it('F4: entrare in un passo di categoria waiting mette in pausa, all\'istante del passo', async () => {
    pauseSLA.mockResolvedValueOnce({ ...baseStatus, paused_at: '2026-05-02T09:00:00.000Z' })
    await new SLAEngine().process(stepEntered({}))
    expect(pauseSLA).toHaveBeenCalledWith('t1', 'inc-1', 'both', new Date('2026-05-02T09:00:00.000Z'))
    expect(cancelSLAJobs).toHaveBeenCalledWith('inc-1', 'both')
  })

  it('F4 + SL-8: uscire dall\'attesa riprende con l\'istante del passo, non con l\'ora del consumatore', async () => {
    getSLAStatus.mockResolvedValueOnce({ ...baseStatus, paused_at: '2026-05-02T09:00:00.000Z', paused_type: 'both' })
    resumeSLA.mockResolvedValueOnce({ ...baseStatus, paused_type: 'both' })
    await new SLAEngine().process(stepEntered({ step_name: 'under_investigation', step_category: 'active', entered_at: '2026-05-02T11:00:00.000Z' }))
    expect(resumeSLA).toHaveBeenCalledWith('t1', 'inc-1', new Date('2026-05-02T11:00:00.000Z'))
    expect(pauseSLA).not.toHaveBeenCalled()
  })

  it('SL-10: un gruppo assegnato che rende più specifica la policy la sostituisce', async () => {
    getSLAStatus.mockResolvedValueOnce({ ...baseStatus, policy_id: 'pol-all' })
    selectSLAForEntity.mockResolvedValueOnce({ ...POLICY_GENERICA, id: 'pol-team', name: 'DBA' })
    repolicySLA.mockResolvedValueOnce({ ...baseStatus, policy_id: 'pol-team' })
    await new SLAEngine().process(event('ticket.team_assigned', { entity_type: 'incident', entity_id: 'inc-1', team_id: 'dba' }))
    expect(repolicySLA).toHaveBeenCalledWith('t1', 'inc-1', expect.objectContaining({ id: 'pol-team' }), 'high')
    expect(scheduleBreachCheck).toHaveBeenCalled()
  })

  it('SL-10: stessa policy → nulla', async () => {
    getSLAStatus.mockResolvedValueOnce({ ...baseStatus, policy_id: 'pol-all' })
    await new SLAEngine().process(event('ticket.team_assigned', { entity_type: 'incident', entity_id: 'inc-1', team_id: 'x' }))
    expect(repolicySLA).not.toHaveBeenCalled()
  })
})

/**
 * THE BRANCHES OF THE EVENT SWITCH THAT NOTHING REACHED YET.
 *
 * Every domain event fans out to all five consumers, so the SLA engine is
 * handed `ci.health_changed`, `event.received` and everything else. Two rules
 * hold this together: what is not an SLA event is DROPPED before it costs a
 * Redis round-trip, and what IS one must have a branch — `sla.resolve.start`
 * and `sla.response.stop` had none for a while, so the designer offered those
 * step actions, the seeds used them, and they changed nothing (WA-1).
 */
describe('SLAEngine — which events it takes, and which it drops', () => {
  class Probe extends SLAEngine {
    /** `handles` is protected: this exposes it, nothing else. */
    takes(type: string): boolean {
      return (this as unknown as { handles: (t: string) => boolean }).handles(type)
    }
  }

  it.each([
    'incident.created', 'incident.resolved', 'incident.assigned',
    'request.created', 'request.completed',
    'sla.resolve.pause', 'sla.resolve.resume', 'sla.resolve.start', 'sla.resolve.stop',
    'sla.response.pause', 'sla.response.resume', 'sla.response.start', 'sla.response.stop',
    'ticket.team_assigned', 'workflow.step_entered',
  ])('%s is handled', (type) => {
    expect(new Probe().takes(type)).toBe(true)
  })

  it.each(['ci.health_changed', 'event.received', 'ticket.updated', 'change.created', ''])(
    '%s is dropped before the dedup, so the fan-out costs nothing', (type) => {
      // It used to run an EXISTS and a SET on Redis for each of these, plus a
      // "no SLA rule, skipping" log line: thousands of operations a minute
      // during an alarm storm (E-33).
      expect(new Probe().takes(type)).toBe(false)
    })

  it('an event that slips through anyway is logged and ignored, not an error', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await new SLAEngine().process(event('ci.health_changed', { id: 'ci-1' }))
    expect(log).toHaveBeenCalledWith('[sla:engine] Event "ci.health_changed" — no SLA rule, skipping')
    log.mockRestore()
  })
})

describe('the step actions "start SLA" and "stop SLA" (WA-1)', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })

  it('sla.resolve.start on a PAUSED SLA resumes it instead of starting a second one', async () => {
    getSLAStatus.mockResolvedValueOnce({ ...baseStatus, paused_at: '2026-05-01T09:00:00.000Z', paused_type: 'both' })
    resumeSLA.mockResolvedValueOnce({ ...baseStatus, paused_type: 'both', response_met: false, breached: false })
    await new SLAEngine().process(event('sla.resolve.start', { entity_id: 'inc-1', entity_type: 'incident' }))
    expect(resumeSLA).toHaveBeenCalledOnce()
    expect(createSLAStatus).not.toHaveBeenCalled()
  })

  it('on an SLA that is already running it does nothing: the clock is going', async () => {
    getSLAStatus.mockResolvedValueOnce({ ...baseStatus })
    await new SLAEngine().process(event('sla.response.start', { entity_id: 'inc-1', entity_type: 'incident' }))
    expect(resumeSLA).not.toHaveBeenCalled()
    expect(createSLAStatus).not.toHaveBeenCalled()
  })

  it('with NO SLA it picks a policy now and starts the clock at the event instant', async () => {
    // The usual reason there is none: the policy depends on the team, and the
    // team arrived after creation.
    getSLAStatus.mockResolvedValueOnce(null)
    getEntityPriority.mockResolvedValueOnce('high')
    selectSLAForEntity.mockResolvedValueOnce(POLICY_GENERICA)
    createSLAStatus.mockResolvedValueOnce({ ...baseStatus })
    await new SLAEngine().process(event('sla.resolve.start', { entity_id: 'inc-1', entity_type: 'incident' }, '2026-05-01T10:00:00.000Z'))
    expect(createSLAStatus).toHaveBeenCalledWith(expect.objectContaining({
      entityId: 'inc-1', entityType: 'incident', severity: 'high',
      startedAt: new Date('2026-05-01T10:00:00.000Z'),
    }))
  })

  it('an unparseable event timestamp starts the clock NOW rather than at Invalid Date', async () => {
    getSLAStatus.mockResolvedValueOnce(null)
    getEntityPriority.mockResolvedValueOnce('high')
    selectSLAForEntity.mockResolvedValueOnce(POLICY_GENERICA)
    createSLAStatus.mockResolvedValueOnce({ ...baseStatus })
    const before = Date.now()
    await new SLAEngine().process(event('sla.resolve.start', { entity_id: 'inc-1', entity_type: 'incident' }, 'ieri'))
    const startedAt = (createSLAStatus.mock.calls[0]![0] as { startedAt: Date }).startedAt
    expect(startedAt.getTime()).toBeGreaterThanOrEqual(before - 1000)
  })

  it('an entity type that has no SLA is skipped without asking anything', async () => {
    getSLAStatus.mockResolvedValueOnce(null)
    await new SLAEngine().process(event('sla.resolve.start', { entity_id: 'chg-1', entity_type: 'change' }))
    expect(getEntityPriority).not.toHaveBeenCalled()
    expect(createSLAStatus).not.toHaveBeenCalled()
  })

  it('an event with no entity id at all fails loudly', async () => {
    await expect(new SLAEngine().process(event('sla.resolve.start', { entity_type: 'incident' })))
      .rejects.toThrow('sla.resolve.start event missing entity id')
  })
})

describe('pausing the clock', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })

  it.each([
    ['sla.resolve.pause',  'resolve'],
    ['sla.resolve.stop',   'resolve'],
    ['sla.response.pause', 'response'],
  ])('%s stops the %s clock and cancels ONLY its timers', async (type, slaType) => {
    // A paused clock must not fire timers; the other clock keeps running, so
    // cancelling everything would silently drop the target still in force.
    pauseSLA.mockResolvedValueOnce({ ...baseStatus, paused_at: '2026-05-01T10:00:00.000Z', paused_type: slaType })
    await new SLAEngine().process(event(type, { entity_id: 'inc-1' }))
    expect(pauseSLA).toHaveBeenCalledWith('t1', 'inc-1', slaType, new Date('2026-05-01T10:00:00.000Z'))
    expect(cancelSLAJobs).toHaveBeenCalledWith('inc-1', slaType)
  })

  it('nothing to pause cancels nothing: the timers belong to a clock still running', async () => {
    pauseSLA.mockResolvedValueOnce(null)
    await new SLAEngine().process(event('sla.resolve.pause', { entity_id: 'inc-1' }))
    expect(cancelSLAJobs).not.toHaveBeenCalled()
  })
})

describe('team assignment, conclusion instants, and the engine factory', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })

  it('a team assigned to an entity type with no SLA is ignored without a read', async () => {
    await new SLAEngine().process(event('ticket.team_assigned', { entity_type: 'change', entity_id: 'chg-1', team_id: 'team-1' }))
    expect(getEntityPriority).not.toHaveBeenCalled()
    expect(getSLAStatus).not.toHaveBeenCalled()
  })

  it('a ticket with no usable priority is left alone: there is no tier to pick', async () => {
    // Re-selecting a policy without a priority would land on whatever tier
    // comes first, which is not the one the customer agreed to.
    for (const severity of [null, undefined, '', 42]) {
      getEntityPriority.mockResolvedValueOnce(severity as unknown as string)
      await new SLAEngine().process(event('ticket.team_assigned', { entity_type: 'incident', entity_id: 'inc-1', team_id: 'team-1' }))
    }
    expect(getSLAStatus).not.toHaveBeenCalled()
  })

  it('a ticket with NO SLA yet starts one, counting from its creation and not from the assignment', async () => {
    // The usual case: the policy is scoped to a team, and the team arrived
    // after the ticket. The clock still owes the customer the time since
    // creation.
    getEntityPriority.mockResolvedValueOnce('high')
    getSLAStatus.mockResolvedValueOnce(null)
    getEntityCreatedAt.mockResolvedValueOnce(new Date('2026-05-01T08:00:00.000Z'))
    selectSLAForEntity.mockResolvedValueOnce(POLICY_GENERICA)
    createSLAStatus.mockResolvedValueOnce({ ...baseStatus })
    await new SLAEngine().process(event('ticket.team_assigned', { entity_type: 'incident', entity_id: 'inc-1', team_id: 'team-1' }))
    expect(createSLAStatus).toHaveBeenCalledWith(expect.objectContaining({ startedAt: new Date('2026-05-01T08:00:00.000Z') }))
  })

  it('a resolution event with an unreadable instant fails loudly instead of writing NaN', async () => {
    // `new Date("ieri")` is Invalid Date: stored as the resolution time it
    // makes the whole compliance history unreadable.
    getSLAStatus.mockResolvedValueOnce({ ...baseStatus })
    await expect(new SLAEngine().process(event('incident.resolved', { entity_id: 'inc-1', resolved_at: 'ieri' })))
      .rejects.toThrow(/resolved_at\/completed_at\/timestamp is not a valid instant/)
  })

  it('a resolution event with neither id nor entity_id fails loudly: a malformed event is not a no-op', async () => {
    await expect(new SLAEngine().process(event('incident.resolved', { severity: 'high' })))
      .rejects.toThrow('[sla:engine] incident.resolved payload has neither id nor entity_id')
  })

  it('createSLAEngine starts the timer worker BEFORE the consumer', async () => {
    // The other way round, an event arriving in the first milliseconds would
    // schedule timers on a worker nobody is running.
    const { initScheduler } = await import('../scheduler.js')
    const engine = await createSLAEngine()
    expect(initScheduler).toHaveBeenCalled()
    expect(engine).toBeInstanceOf(SLAEngine)
  })
})
