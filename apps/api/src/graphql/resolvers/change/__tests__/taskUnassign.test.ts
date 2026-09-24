/**
 * Revisione totale · F-4: la tendina dell'assegnatario di un'attività offriva
 * «Non assegnato», ma la mutation esigeva un `userId` e il web non chiamava
 * nulla: la scelta non faceva niente e nessun messaggio lo diceva. Ora
 * `userId: null` stacca la persona, l'attività torna al team e l'audit lo
 * registra.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { perms } from '../../../../lib/__tests__/testPermissions.js'

const write = vi.fn<(q: string, p?: Record<string, unknown>) => Promise<{ records: unknown[] }>>()
const runQueryOne = vi.fn()
const runQuery = vi.fn(async () => [])
const writeAudit = vi.fn()
const getCIName = vi.fn(async () => 'db-01')
const assertUserInCITeam = vi.fn()
const assertAssignablePerson = vi.fn()

vi.mock('../../ci-utils.js', () => ({
  withSession: (fn: (s: unknown) => unknown) => fn({
    executeWrite: (w: (tx: unknown) => unknown) => w({ run: write }),
    executeRead:  (w: (tx: unknown) => unknown) => w({ run: write }),
  }),
  runQuery:    (...a: unknown[]) => runQuery(...(a as [])),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
}))
vi.mock('../../../../services/change/helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../services/change/helpers.js')>()),
  writeAudit:           (...a: unknown[]) => writeAudit(...a),
  getCIName:            (...a: unknown[]) => getCIName(...(a as [])),
  assertUserInCITeam:   (...a: unknown[]) => assertUserInCITeam(...a),
  recomputeCIRiskIfReady: vi.fn(),
  afterEnterStep:       vi.fn(),
}))
vi.mock('../../../../services/ticketAssignment.js', () => ({
  assertAssignablePerson: (...a: unknown[]) => assertAssignablePerson(...a),
  setTicketUser: vi.fn(),
}))
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))

const { assignAssessmentTaskToUser, assignDeployPlanTaskToUser } = await import('../assessmentMutations.js')

const ctx = { tenantId: 'c-test', userId: 'u1', userEmail: 'a@b.c', role: 'admin', permissions: perms('admin') } as never

beforeEach(() => {
  vi.clearAllMocks()
  write.mockResolvedValue({ records: [] })
  getCIName.mockResolvedValue('db-01')
  // 1ª lettura: il contesto dell'attività; 2ª: l'attività aggiornata.
  runQueryOne
    .mockResolvedValueOnce({ changeId: 'chg-1', ciId: 'ci-1', role: 'owner' })
    .mockResolvedValue({ props: { id: 'task-1', tenant_id: 'c-test', status: 'pending' } })
})

describe('togliere l\'assegnazione di un\'attività (userId null)', () => {
  it('assessment: cancella la relazione con la persona, non ne crea un\'altra, e scrive l\'audit', async () => {
    const out = await assignAssessmentTaskToUser(null, { taskId: 'task-1', userId: null }, ctx)
    expect(out).toMatchObject({ id: 'task-1' })
    const cypher = write.mock.calls.map((c) => c[0]).join('\n')
    expect(cypher).toContain('MATCH (t:AssessmentTask {id: $taskId, tenant_id: $tenantId})')
    expect(cypher).toContain('DELETE old')
    expect(cypher).not.toContain('CREATE (t)-[:ASSIGNED_TO]->(u)')
    // Nessun controllo di appartenenza al team: non c'è nessuna persona da controllare.
    expect(assertAssignablePerson).not.toHaveBeenCalled()
    expect(writeAudit).toHaveBeenCalledTimes(1)
    expect(writeAudit.mock.calls[0]![5]).toMatch(/assignment removed/)
    expect(writeAudit.mock.calls[0]![6]).toMatchObject({ key: 'userUnassigned', params: { ci: 'db-01' } })
  })

  it('piano di deploy: stessa cosa sul suo nodo, con la chiave dell\'audit del piano', async () => {
    const out = await assignDeployPlanTaskToUser(null, { taskId: 'task-2', userId: null }, ctx)
    expect(out).toMatchObject({ id: 'task-1' })
    const cypher = write.mock.calls.map((c) => c[0]).join('\n')
    expect(cypher).toContain('MATCH (t:DeployPlanTask {id: $taskId, tenant_id: $tenantId})')
    expect(cypher).toContain('DELETE old')
    expect(writeAudit.mock.calls[0]![6]).toMatchObject({ key: 'planUserUnassigned' })
  })

  it('il permesso sul team del CI resta richiesto anche per togliere l\'assegnazione', async () => {
    assertUserInCITeam.mockRejectedValueOnce(new Error('forbidden'))
    await expect(assignAssessmentTaskToUser(null, { taskId: 'task-1', userId: null }, ctx)).rejects.toThrow('forbidden')
    expect(write).not.toHaveBeenCalled()
  })
})
