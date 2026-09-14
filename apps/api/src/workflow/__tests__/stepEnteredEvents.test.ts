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
vi.mock('../../services/incidentService.js', () => ({ closeIncident: (...a: unknown[]) => closeIncident(...a) }))

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
  })

  it('un altro passo, o un altro tipo di ticket, no', async () => {
    await listener!(info({ toStep: 'resolved', category: 'resolved' }))
    await listener!(info({ entityType: 'problem', entityId: 'prb-1' }))
    expect(closeIncident).not.toHaveBeenCalled()
    expect(publishEvent).toHaveBeenCalledTimes(2)
  })
})
