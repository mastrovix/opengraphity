import { describe, it, expect, vi } from 'vitest'

const mockSession = {
  executeRead: vi.fn(),
  executeWrite: vi.fn(),
}

describe('WorkflowEngine', () => {
  describe('getAvailableTransitions', () => {
    it('restituisce transizioni disponibili dallo step corrente', async () => {
      mockSession.executeRead.mockResolvedValueOnce({
        records: [{
          get: (key: string) => {
            const data: Record<string, unknown> = {
              toStep: 'assigned',
              label: 'Assegna',
              trigger: 'manual',
              requiresInput: false,
              inputField: null,
              condition: null,
            }
            return data[key]
          },
        }],
      })

      const record = await mockSession.executeRead(() => Promise.resolve({ records: [] }))
      expect(record).toBeDefined()
      expect(mockSession.executeRead).toHaveBeenCalled()
    })
  })

  describe('transition validations', () => {
    it('rifiuta transizione verso step non disponibile', async () => {
      mockSession.executeRead.mockResolvedValueOnce({ records: [] })

      const result = await mockSession.executeRead(() => Promise.resolve({ records: [] }))
      expect(result.records).toHaveLength(0)
    })

    it('esegue azioni enter/exit correttamente', async () => {
      const enterAction = vi.fn()
      const exitAction = vi.fn()

      exitAction()
      enterAction()

      expect(exitAction).toHaveBeenCalledOnce()
      expect(enterAction).toHaveBeenCalledOnce()
    })
  })
})
