/**
 * Il passo «risolto» degli incident aperti dagli allarmi si riconosce dalla
 * CATEGORIA, mai dal nome (revisione del 14 set 2026 · F17).
 *
 * Prima, senza un passo di categoria `resolved`, si ripiegava sul passo di NOME
 * `resolved`: un cliente che aveva tolto la categoria (o l'aveva data a un altro
 * passo) vedeva gli incident chiusi dagli allarmi finire in un passo che per
 * lui non è «risolto», e nessuno glielo diceva. Ora è un errore che nomina la
 * categoria, e la diagnostica lo dice prima (`workflow_step_categories_missing`).
 */
import { describe, expect, it, vi } from 'vitest'

let steps: Array<Record<string, unknown>> = []
vi.mock('../../lib/workflowHelpers.js', () => ({ getWorkflowSteps: vi.fn(async () => steps) }))

const { incidentStepInfo } = await import('../events/incidentWorkflow.js')

const base = (name: string, category: string | null, extra: Record<string, unknown> = {}) =>
  ({ name, label: null, isInitial: false, isTerminal: false, isOpen: true, category, purpose: null, stepOrder: null, ...extra })

describe('incidentStepInfo', () => {
  it('un passo di NOME resolved senza la categoria non è il passo risolto: errore che nomina la categoria', async () => {
    steps = [base('new', 'active', { isInitial: true }), base('resolved', 'active'), base('closed', 'closed', { isTerminal: true, isOpen: false })]
    await expect(incidentStepInfo({} as never, 'c-one')).rejects.toThrow(/no step with category "resolved"/)
  })

  it('il passo di categoria resolved vale anche se si chiama in un altro modo', async () => {
    steps = [base('nuovo', 'active', { isInitial: true }), base('risolto', 'resolved'), base('chiuso', 'closed', { isTerminal: true, isOpen: false })]
    await expect(incidentStepInfo({} as never, 'c-one')).resolves.toMatchObject({ resolvedStep: 'risolto', terminalSteps: ['chiuso'] })
  })
})
