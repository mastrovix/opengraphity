/**
 * createChange (resolver GraphQL) — thin wrapper: delega tutto il bootstrap
 * dell'RFC a services/changeCreationService.createChangeRFC e poi rilegge il
 * change con la query `change`. I casi di business (validazioni, code, task,
 * rollback) sono coperti in services/__tests__/changeCreationService.test.ts:
 * qui si verifica SOLO il contratto del wrapper.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../../context.js'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../../../services/changeCreationService.js', () => ({
  createChangeRFC: vi.fn(),
}))

vi.mock('../queries.js', () => ({
  change: vi.fn(),
}))

vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: {
    createInstance: vi.fn().mockResolvedValue({ id: 'wi-1' }),
    transition:     vi.fn().mockResolvedValue({ success: true }),
  },
}))

vi.mock('../../ci-utils.js', () => ({
  withSession: vi.fn(),
  getSession:  vi.fn(),
  runQuery:    vi.fn(),
  runQueryOne: vi.fn(),
  mapCI:       vi.fn(),
}))

vi.mock('../../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../../../lib/workflowHelpers.js', () => ({
  getInitialStepName: vi.fn().mockResolvedValue('assessment'),
  getWorkflowSteps:   vi.fn().mockResolvedValue([]),
}))

// ── Import after mocks ────────────────────────────────────────────────────────

const { createChange } = await import('../changeMutations.js')
const { createChangeRFC } = await import('../../../../services/changeCreationService.js')
const { change: getChange } = await import('../queries.js')

// ── Test context ──────────────────────────────────────────────────────────────

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'op@test.io', role: 'operator' }

describe('createChange (resolver wrapper)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('delega a createChangeRFC con input e {tenantId, userId} e ritorna il change riletto', async () => {
    const input = { title: 'Upgrade DB', description: 'desc', changeOwner: 'user-9', affectedCIIds: ['ci-1'] }
    const mapped = { id: 'chg-1', code: 'CHG00000042', title: 'Upgrade DB' }
    vi.mocked(createChangeRFC).mockResolvedValue({ id: 'chg-1', code: 'CHG00000042' })
    vi.mocked(getChange).mockResolvedValue(mapped as never)

    const result = await createChange(null, { input }, ctx)

    expect(createChangeRFC).toHaveBeenCalledOnce()
    expect(createChangeRFC).toHaveBeenCalledWith(input, { tenantId: 'tenant-1', userId: 'user-1' })
    // rilegge via la query `change` con l'id appena creato e lo stesso ctx
    expect(getChange).toHaveBeenCalledOnce()
    expect(getChange).toHaveBeenCalledWith(null, { id: 'chg-1' }, ctx)
    expect(result).toBe(mapped)
  })

  it('errore dal service → propaga e NON rilegge il change', async () => {
    vi.mocked(createChangeRFC).mockRejectedValue(new Error('Un change deve avere almeno un CI impattato'))

    await expect(
      createChange(null, { input: { title: 'X', affectedCIIds: [] } }, ctx),
    ).rejects.toThrow('Un change deve avere almeno un CI impattato')

    expect(getChange).not.toHaveBeenCalled()
  })
})
