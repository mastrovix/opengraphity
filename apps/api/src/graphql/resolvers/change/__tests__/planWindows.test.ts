/**
 * Finestre del piano di deploy (B·1.17): alla scrittura le date devono avere
 * offset esplicito (Z o ±hh:mm), altrimenti verrebbero lette nel fuso del
 * server API e non del tenant; stessa regola di lib/deployWindows.ts in lettura.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../ci-utils.js', () => ({ withSession: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('./autoTransitions.js', () => ({ evaluateAutoTransitions: vi.fn() }))
vi.mock('./helpers.js', () => ({ assertUserInCITeam: vi.fn(), computeAggregateRisk: vi.fn(), afterEnterStep: vi.fn() }))
vi.mock('../../../lib/workflowHelpers.js', () => ({ getInitialStepName: vi.fn() }))

const { validateWindow } = await import('../planMutations.js')

describe('validateWindow (piano di deploy)', () => {
  it('accetta date ISO con offset esplicito, in ordine', () => {
    expect(() => validateWindow('Step 1', { start: '2026-09-09T22:00:00.000Z', end: '2026-09-10T01:00:00+02:00' })).not.toThrow()
  })
  it('rifiuta date senza offset (verrebbero lette nel fuso del server)', () => {
    expect(() => validateWindow('Step 1', { start: '2026-09-09T22:00', end: '2026-09-10T01:00:00Z' })).toThrow(/Step 1\.start/)
    expect(() => validateWindow('Step 1', { start: '2026-09-09T22:00:00Z', end: '2026-09-10 01:00' })).toThrow(/Step 1\.end/)
  })
  it('rifiuta start >= end e finestre incomplete', () => {
    expect(() => validateWindow('Step 2', { start: '2026-09-10T01:00:00Z', end: '2026-09-09T22:00:00Z' })).toThrow(/end deve essere dopo start/)
    expect(() => validateWindow('Step 2', { start: '', end: '2026-09-09T22:00:00Z' })).toThrow(/obbligatori/)
  })
})
