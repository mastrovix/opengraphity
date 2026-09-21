/**
 * Revisione totale · B-14: `approval_status` veniva scritto, ma `approval_at`
 * e la relazione `APPROVED_BY` no — da nessuna parte in tutta l'API. Quindi
 * `Change.approvalAt` e `Change.approvalBy` erano SEMPRE null, e il dettaglio
 * di una change approvata diceva «Approvata da: —, il: —», mentre il web li
 * chiede in entrambe le query.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { perms } from '../../../../lib/__tests__/testPermissions.js'

const writes: { cypher: string; params: Record<string, unknown> }[] = []
const runQueryOne = vi.fn()
const runQuery = vi.fn(async () => [])
const areAllApprovalsSatisfied = vi.fn(async () => true)

vi.mock('@opengraphity/neo4j', () => ({
  runQuery:    (...a: unknown[]) => runQuery(...(a as [])),
  runQueryOne: (...a: unknown[]) => { writes.push({ cypher: a[1] as string, params: a[2] as Record<string, unknown> }); return runQueryOne(...a) },
  getSession:  vi.fn(),
  toNumber:    (v: unknown) => Number(v ?? 0),
}))
vi.mock('../../ci-utils.js', () => ({
  withSession: (fn: (s: unknown) => unknown) => fn({ executeRead: vi.fn(), executeWrite: vi.fn() }),
  runQuery:    (...a: unknown[]) => runQuery(...(a as [])),
  runQueryOne: (...a: unknown[]) => { writes.push({ cypher: a[1] as string, params: a[2] as Record<string, unknown> }); return runQueryOne(...a) },
}))
vi.mock('../approvalCreation.js', () => ({
  areAllApprovalsSatisfied: (...a: unknown[]) => areAllApprovalsSatisfied(...(a as [])),
  getApprovalGateState: vi.fn(),
  assertAllApprovalsSatisfied: vi.fn(),
  createChangeApprovals: vi.fn(),
}))
vi.mock('../helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../helpers.js')>()),
  writeAudit: vi.fn(),
  getInstanceId: vi.fn(async () => 'wi-1'),
  requireTeamMembership: vi.fn(),
}))
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))

const { approveChangeApproval } = await import('../approvalGate.js')

const ctx = { tenantId: 'c-test', userId: 'u-approvatore', userEmail: 'a@b.c', role: 'admin', permissions: perms('admin') } as never

beforeEach(() => {
  writes.length = 0
  vi.clearAllMocks()
  areAllApprovalsSatisfied.mockResolvedValue(true)
  // La change è nel passo di SCOPO approvazione, il team esiste, il requisito
  // si aggiorna: le tre letture che precedono la scrittura dell'esito.
  runQueryOne.mockResolvedValue({ id: 'chg-1', step: 'CAB settimanale', purpose: 'approval', changeType: 'normal', teamName: 'CAB' })
})

describe('chi approva per ultimo resta scritto sulla change (B-14)', () => {
  it('scrive approval_at e la relazione APPROVED_BY verso chi ha approvato', async () => {
    await approveChangeApproval(null, { changeId: 'chg-1', teamId: 'team-cab' }, ctx).catch(() => null)
    const outcome = writes.find((w) => w.cypher.includes("c.approval_status = 'approved'"))
    expect(outcome, 'nessuna scrittura dell\'esito dell\'approvazione').toBeDefined()
    expect(outcome!.cypher).toContain('c.approval_at = $now')
    expect(outcome!.cypher).toContain('MERGE (c)-[:APPROVED_BY]->(u)')
    // La persona precedente non resta attaccata: l'esito è uno.
    expect(outcome!.cypher).toContain('DELETE old')
    expect(outcome!.params).toMatchObject({ changeId: 'chg-1', tenantId: 'c-test', userId: 'u-approvatore' })
    expect(outcome!.params['now']).toEqual(expect.any(String))
  })

  it('con requisiti ancora aperti non si scrive nessun esito', async () => {
    areAllApprovalsSatisfied.mockResolvedValue(false)
    await approveChangeApproval(null, { changeId: 'chg-1', teamId: 'team-cab' }, ctx).catch(() => null)
    expect(writes.some((w) => w.cypher.includes("c.approval_status = 'approved'"))).toBe(false)
  })
})
