/** Secondo giro UI del 15 set 2026: `workflow.updated` nell'Audit Log non diceva cosa era cambiato. */
import { describe, it, expect } from 'vitest'
import { workflowChangeDetails } from '../workflowAuditDetails.js'

describe('workflowChangeDetails', () => {
  it('riporta le versioni e solo i passi e gli archi davvero cambiati, campo per campo', () => {
    const before = {
      steps: { new: { label: 'New', category: 'new', deadline: null }, pending: { label: 'On Hold', category: 'waiting', deadline: null } },
      transitions: { 'new → pending': { label: 'Hold', trigger: 'manual' } },
    }
    const after = {
      steps: { new: { label: 'New', category: 'new', deadline: null }, pending: { label: 'Waiting', category: 'waiting', deadline: '{"after_minutes":60}' } },
      transitions: { 'new → pending': { label: 'Hold', trigger: 'manual' } },
    }
    expect(workflowChangeDetails(before, after, 8, 9)).toEqual({
      fromVersion: 8,
      toVersion: 9,
      steps: [{ step: 'pending', changed: { label: { from: 'On Hold', to: 'Waiting' }, deadline: { from: null, to: '{"after_minutes":60}' } } }],
      transitions: [],
    })
  })

  it('un valore lungo (le azioni in JSON) si tronca invece di essere copiato per intero', () => {
    const long = 'x'.repeat(1000)
    const d = workflowChangeDetails({ steps: { a: { enter_actions: null } }, transitions: {} }, { steps: { a: { enter_actions: long } }, transitions: {} }, 1, 2)
    const to = (d.steps as Array<{ changed: Record<string, { to: string }> }>)[0]!.changed.enter_actions!.to
    expect(to.length).toBeLessThan(400)
    expect(to.endsWith('…')).toBe(true)
  })
})
