/**
 * Revisione del 14 set 2026 · IT-2: risolvere, escalare e assegnare un
 * incident ignoravano l'esito del motore di workflow.
 *
 * Un rifiuto (condizione non soddisfatta, arco mancante, transizione
 * concorrente) lasciava l'incident nel passo di prima, ma `resolved_at` veniva
 * scritto e `incident.resolved`/`incident.escalated` pubblicati: risolto per
 * SLA, notifiche e report, aperto per chi ci lavora.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const writes: string[] = []
const session = {
  executeRead: vi.fn(async (fn: (tx: unknown) => unknown) => fn({
    run: async (c: string) => ({
      records: c.includes('current_step AS currentStep')
        ? [{ get: (k: string) => (k === 'instanceId' ? 'wi-1' : 'new') }]
        : [{ get: (k: string) => (k === 'props' ? { id: 'inc-1', title: 'T', severity: 'high', status: 'new' } : ({ id: 'inc-1', title: 'T', severity: 'high', status: 'new' } as Record<string, string>)[k] ?? null) }],
    }),
  })),
  executeWrite: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ run: async (c: string) => { writes.push(c); return { records: [] } } })),
}

vi.mock('../../lib/domainMatrix.js', () => import('../../lib/__tests__/domainMatrixFake.js'))
vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: {
    createInstance: vi.fn(),
    transition: vi.fn(async () => ({ success: false, error: 'Condition "has_root_cause" not satisfied', errorI18n: { key: 'errors.workflow.condition.has_root_cause' } })),
    getAvailableTransitions: vi.fn(async () => [{ toStep: 'assigned', label: 'Assign' }]),
  },
}))
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(),
  runQuery: vi.fn(async (_s: unknown, c: string) => { writes.push(c); return [{ props: { id: 'inc-1', title: 'T', severity: 'high', status: 'resolved' } }] }),
  runQueryOne: vi.fn(async () => ({ instanceId: 'wi-1' })),
  toNumber: (v: unknown) => Number(v ?? 0),
}))
vi.mock('../../lib/db.js', () => ({ withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(session)), getSession: vi.fn() }))
vi.mock('../../lib/validateRequiredFields.js', () => ({ validateStepRequirements: vi.fn(async () => undefined) }))
vi.mock('../../lib/stepMetadataPreflight.js', () => ({ preflightStepMetadata: vi.fn(async () => undefined) }))
vi.mock('../../lib/publishEvent.js', () => ({ publishEvent: vi.fn() }))
vi.mock('../../lib/workflowHelpers.js', () => ({
  getInitialStepName: vi.fn(async () => 'new'),
  getWorkflowSteps: vi.fn(async () => [
    { name: 'new', isInitial: true, isTerminal: false, isOpen: true, category: 'active', stepOrder: 1 },
    { name: 'assigned', isInitial: false, isTerminal: false, isOpen: true, category: 'active', stepOrder: 2 },
    { name: 'resolved', isInitial: false, isTerminal: true, isOpen: false, category: 'resolved', stepOrder: 3 },
  ]),
}))
vi.mock('../../lib/workflowTargets.js', () => ({ targetStepByCategory: vi.fn(async () => 'escalated') }))
vi.mock('../ticketAssignment.js', () => ({
  setTicketTeam: vi.fn(async () => ({ teamName: 'Service Desk' })),
  setTicketUser: vi.fn(async () => ({ userName: 'Mario' })),
  assertUserInAssignedTeam: vi.fn(),
}))
vi.mock('../../lib/systemText.js', () => ({ systemText: vi.fn(async (_t: string, k: string) => k) }))
vi.mock('../../lib/triggerEngine.js', () => ({ evaluateTriggers: vi.fn(), scheduleTimerTriggers: vi.fn() }))
vi.mock('../../lib/rulesEngine.js', () => ({ evaluateBusinessRules: vi.fn() }))
vi.mock('../../jobs/embeddingWorker.js', () => ({ enqueueEmbedding: vi.fn() }))

const svc = await import('../incidentService.js')
const { publishEvent } = await import('../../lib/publishEvent.js')
const ctx = { tenantId: 'tenant-1', userId: 'user-1' }

beforeEach(() => { vi.clearAllMocks(); writes.length = 0 })

describe('esito della transizione rifiutata', () => {
  it('resolveIncident: errore con la chiave del motore, nessun resolved_at, nessun evento', async () => {
    await expect(svc.resolveIncident('inc-1', ctx, 'causa')).rejects.toMatchObject({
      extensions: { code: 'CONFLICT', i18n: { key: 'errors.workflow.condition.has_root_cause' } },
    })
    expect(writes.some((c) => c.includes('resolved_at'))).toBe(false)
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('escalateIncident: errore, nessun incident.escalated', async () => {
    await expect(svc.escalateIncident('inc-1', ctx)).rejects.toMatchObject({ extensions: { code: 'CONFLICT' } })
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('assignIncidentToTeam: l\'assegnazione resta e si pubblica, poi l\'errore dice che non è avanzato', async () => {
    await expect(svc.assignIncidentToTeam('inc-1', 'team-1', ctx)).rejects.toMatchObject({
      extensions: { i18n: { key: 'errors.incident.assignedButNotAdvanced', params: { step: 'assigned' } } },
    })
    expect(publishEvent).toHaveBeenCalledWith('incident.assigned', 'tenant-1', 'user-1', expect.objectContaining({ assignedTo: 'Service Desk' }), expect.any(String))
  })

  it('assignIncidentToUser: stessa regola', async () => {
    await expect(svc.assignIncidentToUser('inc-1', 'user-9', ctx)).rejects.toMatchObject({
      extensions: { i18n: { key: 'errors.incident.assignedButNotAdvanced' } },
    })
    expect(publishEvent).toHaveBeenCalledOnce()
  })
})

/** IT-3: la destinazione dell'avanzamento all'assegnazione non dipende dall'ordine degli archi nel grafo. */
describe('avanzamento all\'assegnazione', () => {
  it('fra più archi dal passo iniziale sceglie il passo aperto con step_order più basso', async () => {
    const { workflowEngine } = await import('@opengraphity/workflow')
    const helpers = await import('../../lib/workflowHelpers.js')
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValueOnce([{ toStep: 'escalated_security' }, { toStep: 'closed' }, { toStep: 'assigned' }] as never)
    vi.mocked(helpers.getWorkflowSteps).mockResolvedValueOnce([
      { name: 'new', isInitial: true, isTerminal: false, isOpen: true, category: 'active', stepOrder: 1 },
      { name: 'assigned', isInitial: false, isTerminal: false, isOpen: true, category: 'active', stepOrder: 2 },
      { name: 'escalated_security', isInitial: false, isTerminal: false, isOpen: true, category: 'escalated', stepOrder: 5 },
      { name: 'closed', isInitial: false, isTerminal: true, isOpen: false, category: 'closed', stepOrder: 0 },
    ] as never)
    vi.mocked(workflowEngine.transition).mockResolvedValueOnce({ success: true } as never)
    await svc.assignIncidentToTeam('inc-1', 'team-1', ctx)
    expect(vi.mocked(workflowEngine.transition).mock.calls[0]![1]).toMatchObject({ toStepName: 'assigned' })
  })
  /**
   * Giro UI del 15 set 2026 · U-8: la nota di una regola porta il nome della
   * regola, non «Automation:» vuoto. D12 (tour of 23 Sep 2026): when the
   * assignment moves the workflow, the ONLY note is the one of the step entry
   * («Workflow: <step> — <note>»), so the rule's name travels with the
   * transition (`actorLabel`) and signs that note (stepEnteredPublisher).
   */
  it('U-8: la nota scritta per conto di una regola ha author_label = nome della regola', async () => {
    const seen: Array<{ c: string; p: Record<string, unknown> }> = []
    session.executeWrite.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({ run: async (c: string, p: Record<string, unknown>) => { seen.push({ c, p }); return { records: [] } } }))
    const { workflowEngine } = await import('@opengraphity/workflow')
    vi.mocked(workflowEngine.transition).mockResolvedValueOnce({ success: true } as never)
    await svc.assignIncidentToTeam('inc-1', 'team-1', { ...ctx, userId: 'automation', actorLabel: 'Hardware al Service Desk' })
    expect(vi.mocked(workflowEngine.transition).mock.calls.at(-1)![1]).toMatchObject({ triggeredBy: 'automation', actorLabel: 'Hardware al Service Desk' })
    expect(seen.find((w) => w.c.includes('HAS_COMMENT'))).toBeUndefined()

    // No transition (the workflow refuses to move): the service writes the note itself, signed the same way.
    seen.length = 0
    vi.mocked(workflowEngine.transition).mockResolvedValueOnce({ success: false, error: 'guard' } as never)
    await svc.assignIncidentToTeam('inc-1', 'team-1', { ...ctx, userId: 'automation', actorLabel: 'Hardware al Service Desk' }).catch(() => undefined)
    const comment = seen.find((w) => w.c.includes('HAS_COMMENT'))
    expect(comment?.c).toContain('author_label: $authorLabel')
    expect(comment?.p).toMatchObject({ userId: 'automation', authorLabel: 'Hardware al Service Desk' })
  })
})
