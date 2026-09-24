/**
 * AU-1: «campo cambiato». Un trigger è candidato solo se almeno uno dei campi
 * che le sue condizioni nominano è cambiato; senza condizioni, qualunque
 * cambiamento. Le condizioni poi valgono sul valore nuovo.
 */
import { describe, it, expect, vi } from 'vitest'

const rows = [
  { id: 't-sev', name: 'Severità', entity_type: 'incident', event_type: 'on_field_change', conditions: JSON.stringify([{ field: 'severity', operator: 'equals', value: 'critical' }]), timer_delay_minutes: null, actions: '[]' },
  { id: 't-any', name: 'Qualunque', entity_type: 'incident', event_type: 'on_field_change', conditions: null, timer_delay_minutes: null, actions: '[]' },
  { id: 't-cat', name: 'Categoria', entity_type: 'incident', event_type: 'on_field_change', conditions: JSON.stringify([{ field: 'category', operator: 'is_not_null' }]), timer_delay_minutes: null, actions: '[]' },
]
vi.mock('@opengraphity/neo4j', () => ({ runQuery: vi.fn(async () => rows) }))
vi.mock('../db.js', () => ({ withSession: vi.fn(async (fn: (s: unknown) => unknown) => fn({})) }))
vi.mock('../bullmq.js', () => ({ getQueue: vi.fn() }))
vi.mock('../actionExecutor.js', () => ({ executeActions: vi.fn(async () => []), parseActions: vi.fn(() => []) }))
vi.mock('../audit.js', () => ({ audit: vi.fn() }))

const { evaluateTriggers } = await import('../triggerEngine.js')

describe('on_field_change', () => {
  it('cambia la severità: gira il trigger sulla severità e quello senza condizioni, non quello sulla categoria', async () => {
    const out = await evaluateTriggers('t1', 'incident', 'on_field_change', { id: 'i1', severity: 'critical', category: 'network' }, 'automation', { changedFields: ['severity'] })
    expect(out.map((o) => [o.triggerId, o.fired])).toEqual([['t-sev', true], ['t-any', true]])
  })
})
