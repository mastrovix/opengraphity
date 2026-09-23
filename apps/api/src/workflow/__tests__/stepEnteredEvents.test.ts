/**
 * Verifica «Cosa resta cablato», ondata 3: `incident.closed` lo pubblicava solo
 * il job `auto_close`. Ora lo dice l'ingresso nel passo di categoria «closed»,
 * da qualunque cammino — una scadenza, un arco del cliente.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StepEnteredInfo } from '@opengraphity/types'

let listener: ((info: StepEnteredInfo) => Promise<void>) | null = null
vi.mock('@opengraphity/workflow', () => ({ workflowEngine: { onStepEntered: (l: typeof listener) => { listener = l } } }))
const publishEvent = vi.fn(async () => {})
vi.mock('../../lib/publishEvent.js', () => ({ publishEvent: (...a: unknown[]) => publishEvent(...a) }))
const closeIncident = vi.fn(async () => {})
const publishIncidentResolved = vi.fn(async () => {})
vi.mock('../../services/incidentService.js', () => ({
  closeIncident: (...a: unknown[]) => closeIncident(...a),
  publishIncidentResolved: (...a: unknown[]) => publishIncidentResolved(...a),
}))
/*
 * QUESTO TEST APRIVA UNA CONNESSIONE A NEO4J VERA (21 set 2026).
 *
 * Sostituiva `lib/publishEvent.js`, ma la revisione totale (C-1) ha spostato
 * l'evento di DOMINIO dentro `lib/stepEnteredPublisher.ts`, che carica il
 * ticket dal grafo — e quello non era sostituito. Sulla macchina di chi
 * sviluppa Neo4j è acceso, quindi il test passava; sulla CI, dove in questo
 * passo il database non c'è, falliva con «No routing servers available».
 *
 * È il tipo di bugia peggiore: un test unitario che in silenzio ha bisogno di
 * un database passa a casa e cade altrove, e chi lo legge non ha modo di
 * saperlo. Ora la dipendenza è dichiarata, e si verifica anche CHE COSA gli
 * viene passato: l'evento di dominio è il cammino che la revisione C-1 ha
 * aggiunto perché i cammini automatici non facevano scattare nessuna regola.
 */
const publishStepEnteredForEntity = vi.fn(async () => {})
vi.mock('../../lib/stepEnteredPublisher.js', () => ({
  publishStepEnteredForEntity: (...a: unknown[]) => publishStepEnteredForEntity(...a),
}))
/*
 * E una SECONDA, trovata solo dopo aver chiuso la prima: un ticket che si
 * conclude annulla i suoi compiti aperti, e per scrivere la nota di
 * annullamento chiede a `systemText` la lingua del cliente — che sta nel
 * grafo. Due dipendenze nascoste nello stesso test, e la seconda si è vista
 * solo togliendo di mezzo la prima: è il motivo per cui una suite che «passa»
 * con il database acceso non dice niente su quello che prova davvero.
 */
const annullaCompitiDelTicketConcluso = vi.fn(async () => 0)
vi.mock('../../lib/ticketTasks.js', () => ({
  annullaCompitiDelTicketConcluso: (...a: unknown[]) => annullaCompitiDelTicketConcluso(...a),
}))
vi.mock('../../lib/systemText.js', () => ({ systemText: async () => 'Ticket concluso' }))

/*
 * And a third, added with the named-approval gate (review of 23 Sep 2026):
 * leaving a step withdraws the requests still pending there, which needs a
 * session. Declared here, so it is not a database this test quietly needs.
 */
const withdrawApprovalsOfStep = vi.fn(async () => 0)
vi.mock('../../lib/ticketApprovalGate.js', () => ({
  APPROVAL_GATED_TICKETS: ['incident', 'problem', 'service_request'],
  withdrawApprovalsOfStep: (...a: unknown[]) => withdrawApprovalsOfStep(...a),
}))
const sessionClose = vi.fn(async () => {})
vi.mock('@opengraphity/neo4j', () => ({ getSession: () => ({ close: sessionClose }) }))

await import('../stepEnteredEvents.js')

const info = (over: Partial<StepEnteredInfo>): StepEnteredInfo => ({
  tenantId: 'c-test', instanceId: 'wi-1', entityType: 'incident', entityId: 'inc-1', fromStep: 'resolved', fromInitial: false,
  toStep: 'closed', category: 'closed', terminal: true, enteredAt: '2026-09-20T10:00:00Z', actorId: 'automation', triggerType: 'timer', ...over,
})

beforeEach(() => { vi.clearAllMocks() })

describe('stepEnteredEvents', () => {
  it('un incident che entra in un passo «closed» pubblica incident.closed, qualunque nome abbia il passo', async () => {
    await listener!(info({ toStep: 'chiuso_definitivo' }))
    expect(publishEvent).toHaveBeenCalledWith('workflow.step_entered', 'c-test', 'automation', expect.objectContaining({ step_name: 'chiuso_definitivo' }), '2026-09-20T10:00:00Z')
    expect(closeIncident).toHaveBeenCalledWith('inc-1', { tenantId: 'c-test', userId: 'automation' })
    // L'evento di dominio dell'entità: è il cammino aggiunto da C-1, e senza
    // questa riga la sua sparizione non farebbe cadere niente.
    expect(publishStepEnteredForEntity).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'c-test', entityType: 'incident', entityId: 'inc-1', stepName: 'chiuso_definitivo',
    }))
    // Un ticket concluso annulla i compiti che erano ancora aperti.
    expect(annullaCompitiDelTicketConcluso).toHaveBeenCalledWith('c-test', 'inc-1', 'Ticket concluso')
  })

  // Review of 23 Sep 2026: a step named after its category already publishes that event as its alias.
  it('un passo che si chiama come la sua categoria non pubblica l\'evento una seconda volta', async () => {
    await listener!(info({ toStep: 'closed', category: 'closed' }))
    await listener!(info({ toStep: 'resolved', category: 'resolved' }))
    expect(closeIncident).not.toHaveBeenCalled()
    expect(publishIncidentResolved).not.toHaveBeenCalled()
  })

  it('un passo «resolved» con un nome del cliente pubblica incident.resolved, all\'istante dell\'ingresso', async () => {
    await listener!(info({ toStep: 'risolto_l2', category: 'resolved' }))
    expect(publishIncidentResolved).toHaveBeenCalledWith('inc-1', { tenantId: 'c-test', userId: 'automation' }, '2026-09-20T10:00:00Z')
    expect(closeIncident).not.toHaveBeenCalled()
  })

  it('leaving a step withdraws the approvals still pending there, and closes the session', async () => {
    await listener!(info({ fromStep: 'budget_approval', toStep: 'rejected', category: 'failed' }))
    expect(withdrawApprovalsOfStep).toHaveBeenCalledWith(expect.anything(), 'c-test', 'inc-1', 'budget_approval', '2026-09-20T10:00:00Z')
    expect(sessionClose).toHaveBeenCalled()
  })

  it('a withdrawal that fails does not fail the step: it is logged', async () => {
    withdrawApprovalsOfStep.mockRejectedValueOnce(new Error('neo4j down'))
    await expect(listener!(info({ fromStep: 'budget_approval', toStep: 'in_progress', category: 'active', terminal: false }))).resolves.toBeUndefined()
    expect(sessionClose).toHaveBeenCalled()
  })

  it('a change is not touched: its approvals are its own', async () => {
    await listener!(info({ entityType: 'change', entityId: 'chg-1', fromStep: 'approval', toStep: 'scheduled', category: 'active', terminal: false }))
    expect(withdrawApprovalsOfStep).not.toHaveBeenCalled()
  })

  it('un altro passo, o un altro tipo di ticket, no', async () => {
    await listener!(info({ toStep: 'in_progress', category: 'active', terminal: false }))
    await listener!(info({ entityType: 'problem', entityId: 'prb-1', toStep: 'chiuso_definitivo' }))
    expect(closeIncident).not.toHaveBeenCalled()
    expect(publishIncidentResolved).not.toHaveBeenCalled()
    expect(publishEvent).toHaveBeenCalledTimes(2)
  })
})
