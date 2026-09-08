/**
 * D-06 — the Change RFC / Service Request definitions seeded at onboarding are
 * the same pure data the per-workflow seed scripts use, and are structurally
 * valid for engine.createInstance (exactly one start step, transitions only
 * between declared steps).
 */
import { describe, it, expect } from 'vitest'
import { CHANGE_RFC_WORKFLOW, SERVICE_REQUEST_WORKFLOW } from '../lib/workflowDefinitions.js'

describe.each([
  ['Change RFC Process', CHANGE_RFC_WORKFLOW, 'change'],
  ['Service Request Fulfillment', SERVICE_REQUEST_WORKFLOW, 'service_request'],
] as const)('%s', (_name, def, entityType) => {
  it('targets the right entity type and is active', () => {
    expect(def.entityType).toBe(entityType)
    expect(def.active).toBe(true)
  })

  it('has exactly one start step (createInstance looks for type=start) and ≥1 end step', () => {
    expect(def.steps.filter((s) => s.type === 'start')).toHaveLength(1)
    expect(def.steps.some((s) => s.type === 'end')).toBe(true)
    const initial = def.steps.filter((s) => s.metadata?.['is_initial'] === true)
    expect(initial).toHaveLength(1)
    expect(initial[0]!.type).toBe('start')
  })

  it('transitions reference declared steps only; step names and ids unique', () => {
    const names = new Set(def.steps.map((s) => s.name))
    expect(names.size).toBe(def.steps.length)
    expect(new Set(def.steps.map((s) => s.id)).size).toBe(def.steps.length)
    for (const t of def.transitions) {
      expect(names.has(t.fromStepName), `from ${t.fromStepName}`).toBe(true)
      expect(names.has(t.toStepName), `to ${t.toStepName}`).toBe(true)
    }
  })

  it('every non-terminal step has an outgoing transition and every end step is reachable', () => {
    const outgoing = new Set(def.transitions.map((t) => t.fromStepName))
    const incoming = new Set(def.transitions.map((t) => t.toStepName))
    for (const s of def.steps) {
      if (s.type !== 'end') expect(outgoing.has(s.name), `${s.name} has no outgoing transition`).toBe(true)
      else expect(incoming.has(s.name), `${s.name} unreachable`).toBe(true)
    }
  })
})
