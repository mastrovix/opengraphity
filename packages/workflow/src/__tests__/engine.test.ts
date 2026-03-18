import { describe, it, expect, vi } from 'vitest'
import { WorkflowEngine } from '../engine.js'

function mockRecord(data: Record<string, unknown>) {
  return { get: (key: string) => data[key] }
}

function makeSession(readRecords: ReturnType<typeof mockRecord>[], writeRecords: ReturnType<typeof mockRecord>[] = []) {
  return {
    executeRead:  vi.fn().mockResolvedValue({ records: readRecords }),
    executeWrite: vi.fn().mockResolvedValue({ records: writeRecords }),
  }
}

describe('WorkflowEngine', () => {
  describe('getAvailableTransitions', () => {
    it('restituisce transizioni manuali disponibili', async () => {
      const session = makeSession([
        mockRecord({ toStep: 'assigned', label: 'Assegna', requiresInput: false, inputField: null, condition: null }),
        mockRecord({ toStep: 'escalated', label: 'Escalate', requiresInput: false, inputField: null, condition: null }),
      ])

      const engine = new WorkflowEngine()
      const transitions = await engine.getAvailableTransitions(session as never, 'instance-123')

      expect(transitions).toHaveLength(2)
      expect(transitions[0].toStep).toBe('assigned')
      expect(transitions[0].label).toBe('Assegna')
      expect(transitions[1].toStep).toBe('escalated')
      expect(session.executeRead).toHaveBeenCalledOnce()
    })

    it('restituisce array vuoto se nessuna transizione disponibile', async () => {
      const session = makeSession([])
      const engine = new WorkflowEngine()
      const transitions = await engine.getAvailableTransitions(session as never, 'instance-123')
      expect(transitions).toHaveLength(0)
    })

    it('mappa correttamente requiresInput e inputField', async () => {
      const session = makeSession([
        mockRecord({ toStep: 'resolved', label: 'Risolvi', requiresInput: true, inputField: 'notes', condition: 'rootCause != null' }),
      ])
      const engine = new WorkflowEngine()
      const transitions = await engine.getAvailableTransitions(session as never, 'instance-123')
      expect(transitions[0].requiresInput).toBe(true)
      expect(transitions[0].inputField).toBe('notes')
      expect(transitions[0].condition).toBe('rootCause != null')
    })
  })

  describe('createInstance', () => {
    it('chiama executeWrite e ritorna una WorkflowInstance', async () => {
      const now = new Date().toISOString()
      const session = {
        executeRead:  vi.fn(),
        executeWrite: vi.fn().mockResolvedValue({
          id:           'wi-123',
          tenantId:     'tenant-demo',
          definitionId: 'def-456',
          entityId:     'incident-789',
          entityType:   'incident',
          currentStep:  'new',
          status:       'active',
          createdAt:    now,
          updatedAt:    now,
        }),
      }

      const engine = new WorkflowEngine()
      await engine.createInstance(session as never, 'tenant-demo', 'incident-789', 'incident')
      expect(session.executeWrite).toHaveBeenCalledOnce()
    })
  })

  describe('transition', () => {
    it('ritorna errore se transizione non valida (nessun record)', async () => {
      const session = makeSession([]) // executeRead ritorna 0 record → transizione invalida
      const engine = new WorkflowEngine()
      const result = await engine.transition(
        session as never,
        { instanceId: 'wi-123', toStepName: 'nonexistent', notes: null },
        { userId: 'user-1' },
      )
      expect(result.success).toBe(false)
      expect((result as { success: false; error: string }).error).toContain('non valida')
    })

    it('verifica condizione rootCause: rifiuta se notes mancanti', async () => {
      const session = makeSession([
        mockRecord({
          wi: { properties: { tenant_id: 'tenant-demo', entity_id: 'inc-1', entity_type: 'incident' } },
          currentStepId:    'step-1',
          exitActions:      null,
          nextStepId:       'step-2',
          nextStepName:     'resolved',
          nextStepType:     'state',
          nextEnterActions: null,
          condition:        'rootCause != null',
          enteredAt:        new Date().toISOString(),
        }),
      ])

      const engine = new WorkflowEngine()
      const result = await engine.transition(
        session as never,
        { instanceId: 'wi-123', toStepName: 'resolved', notes: null },
        { userId: 'user-1' },
      )
      expect(result.success).toBe(false)
      expect((result as { success: false; error: string }).error).toContain('Root cause')
    })
  })
})
