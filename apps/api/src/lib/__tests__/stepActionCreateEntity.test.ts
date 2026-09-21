/**
 * WA-2 (revisione del 14 set 2026): l'azione di passo `create_entity` crea il
 * ticket dal servizio del suo tipo — numero, workflow, evento — e ne eredita i CI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../services/incidentService.js', () => ({ createIncident: vi.fn(async () => ({ id: 'inc-new' })) }))
vi.mock('../../services/problemService.js', () => ({ createProblem: vi.fn(async () => ({ id: 'prb-new' })) }))
vi.mock('../../services/changeCreationService.js', () => ({ createChangeRFC: vi.fn(async () => ({ id: 'chg-new', code: 'CHG1' })) }))

const writes: string[] = []
const session = {
  executeRead: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ run: async () => ({ records: [{ get: () => ['ci-1', 'ci-2'] }] }) })),
  executeWrite: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ run: async (c: string) => { writes.push(c); return { records: [] } } })),
}
const { createEntityFromStepAction } = await import('../stepActionCreateEntity.js')
const incidents = await import('../../services/incidentService.js')
const problems = await import('../../services/problemService.js')
const changes = await import('../../services/changeCreationService.js')
const ctx = { tenantId: 't1', userId: 'u1' }

beforeEach(() => { vi.clearAllMocks(); writes.length = 0 })

describe('create_entity dalle azioni di passo', () => {
  it('problem da un incident: servizio dei problem, CI ereditati, incident collegato come causa', async () => {
    const id = await createEntityFromStepAction(session as never, ctx, 'problem', { title: 'Problem da DB giù', parent_id: 'inc-1', parent_type: 'incident', severity: 'critical', category: 'database' }, { id: 'inc-1', type: 'incident' })
    expect(id).toBe('prb-new')
    expect(problems.createProblem).toHaveBeenCalledWith({ title: 'Problem da DB giù', description: undefined, priority: 'critical', category: 'database', affectedCIs: ['ci-1', 'ci-2'], relatedIncidents: ['inc-1'] }, ctx)
    expect(writes).toHaveLength(0)
  })
  it('incident e change: dai loro servizi con i CI del ticket corrente; collegamento RELATED_TO se chiesto', async () => {
    await createEntityFromStepAction(session as never, ctx, 'incident', { title: 'I', severity: 'high' }, { id: 'prb-1', type: 'problem' })
    expect(incidents.createIncident).toHaveBeenCalledWith(expect.objectContaining({ title: 'I', severity: 'high', affectedCIIds: ['ci-1', 'ci-2'] }), ctx)
    await createEntityFromStepAction(session as never, ctx, 'change', { title: 'Fix', parent_id: 'prb-1', parent_type: 'problem' }, { id: 'prb-1', type: 'problem' })
    expect(changes.createChangeRFC).toHaveBeenCalledWith(expect.objectContaining({ title: 'Fix', affectedCIIds: ['ci-1', 'ci-2'] }), ctx)
    expect(writes.join('\n')).toContain('MERGE (child)-[:RELATED_TO]->(parent)')
  })
})
