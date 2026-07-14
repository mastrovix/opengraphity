import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../../context.js'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../ci-utils.js', () => ({
  getSession:  vi.fn(),
  runQuery:    vi.fn(),
  runQueryOne: vi.fn(),
  mapCI:       vi.fn(),
}))

vi.mock('../../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../../../lib/workflowHelpers.js', () => ({
  getInitialStepName: vi.fn().mockResolvedValue('draft'),
  getWorkflowSteps:   vi.fn().mockResolvedValue([]),
}))

// ── Import after mocks ────────────────────────────────────────────────────────

const { assertUserInCITeam, assertAdmin } = await import('../helpers.js')
const { runQueryOne } = await import('../../ci-utils.js')

// ── Test context ──────────────────────────────────────────────────────────────

const mockSession = {
  executeRead:  vi.fn().mockResolvedValue({ records: [] }),
  executeWrite: vi.fn().mockResolvedValue({ records: [] }),
  close:        vi.fn().mockResolvedValue(undefined),
} as never

const operatorCtx: GraphQLContext = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'op@test.io', role: 'operator' }
const adminCtx:    GraphQLContext = { tenantId: 'tenant-1', userId: 'admin-1', userEmail: 'admin@test.io', role: 'admin' }

const expectForbidden = async (promise: Promise<unknown>, messagePart: string) => {
  const error = await promise.then(() => null, (e: unknown) => e)
  expect(error).toBeInstanceOf(GraphQLError)
  expect((error as GraphQLError).message).toContain(messagePart)
  expect((error as GraphQLError).extensions['code']).toBe('FORBIDDEN')
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('assertUserInCITeam', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runQueryOne).mockResolvedValue(null)
  })

  it('admin bypass: non interroga il DB e non lancia', async () => {
    await expect(
      assertUserInCITeam(mockSession, 'ci-1', 'tenant-1', adminCtx, 'owner'),
    ).resolves.toBeUndefined()

    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('utente non identificato → ForbiddenError senza interrogare il DB', async () => {
    const noUserCtx = { ...operatorCtx, userId: '' }

    await expectForbidden(
      assertUserInCITeam(mockSession, 'ci-1', 'tenant-1', noUserCtx, 'owner'),
      'utente non identificato',
    )
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('membro del team (ok: true) → passa, query con relazione e parametri corretti', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ ok: true } as never)

    await expect(
      assertUserInCITeam(mockSession, 'ci-1', 'tenant-1', operatorCtx, 'owner'),
    ).resolves.toBeUndefined()

    expect(runQueryOne).toHaveBeenCalledOnce()
    const [, cypher, params] = vi.mocked(runQueryOne).mock.calls[0]!
    expect(cypher).toContain('OWNED_BY')
    expect(params).toEqual({ ciId: 'ci-1', tenantId: 'tenant-1', userId: 'user-1' })
  })

  it('role support → usa la relazione SUPPORTED_BY', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ ok: true } as never)

    await assertUserInCITeam(mockSession, 'ci-1', 'tenant-1', operatorCtx, 'support')

    const [, cypher] = vi.mocked(runQueryOne).mock.calls[0]!
    expect(cypher).toContain('SUPPORTED_BY')
  })

  it('non membro (ok: false) → ForbiddenError con code FORBIDDEN', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ ok: false } as never)

    await expectForbidden(
      assertUserInCITeam(mockSession, 'ci-1', 'tenant-1', operatorCtx, 'owner'),
      'Non autorizzato',
    )
  })

  it('CI senza team collegato (nessuna row) → ForbiddenError', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(null)

    await expectForbidden(
      assertUserInCITeam(mockSession, 'ci-1', 'tenant-1', operatorCtx, 'support'),
      'Non autorizzato',
    )
  })
})

describe('assertAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('admin → non lancia', () => {
    expect(() => assertAdmin(adminCtx)).not.toThrow()
  })

  it('non-admin → ForbiddenError con code FORBIDDEN', () => {
    let error: unknown = null
    try { assertAdmin(operatorCtx) } catch (e) { error = e }

    expect(error).toBeInstanceOf(GraphQLError)
    expect((error as GraphQLError).message).toContain('Solo gli admin')
    expect((error as GraphQLError).extensions['code']).toBe('FORBIDDEN')
  })
})
