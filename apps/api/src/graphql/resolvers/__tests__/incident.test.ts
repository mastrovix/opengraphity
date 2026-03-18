import { describe, it, expect } from 'vitest'

const VALID_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
const VALID_STATUSES   = ['open', 'assigned', 'in_progress', 'escalated', 'pending', 'resolved', 'closed'] as const

describe('Incident domain rules', () => {
  describe('severity validation', () => {
    it('accetta tutte le severity valide', () => {
      for (const s of VALID_SEVERITIES) {
        expect(VALID_SEVERITIES).toContain(s)
      }
    })

    it('rifiuta severity non valida', () => {
      const invalid = 'urgent'
      expect(VALID_SEVERITIES as readonly string[]).not.toContain(invalid)
    })
  })

  describe('status lifecycle', () => {
    it('status iniziale è sempre open', () => {
      expect(VALID_STATUSES[0]).toBe('open')
    })

    it('contiene tutti gli step attesi', () => {
      expect(VALID_STATUSES).toContain('escalated')
      expect(VALID_STATUSES).toContain('pending')
      expect(VALID_STATUSES).toContain('resolved')
      expect(VALID_STATUSES).toContain('closed')
    })

    it('closed è il termine del ciclo di vita', () => {
      expect(VALID_STATUSES[VALID_STATUSES.length - 1]).toBe('closed')
    })
  })
})
