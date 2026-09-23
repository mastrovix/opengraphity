/**
 * Revisione del 14 set 2026 · F3: l'eliminazione di un problem.
 *
 * Prima: bastava essere operatore; restavano lo `SLAStatus`, i commenti del
 * modello generico e gli allegati; i job di breach SLA e OLA/UC restavano in
 * coda; nessun evento. Dal vivo c'erano 85 `SLAStatus` senza proprietario.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

const runs: string[] = []
let found = true
const session = {
  executeWrite: vi.fn(async (fn: (tx: unknown) => unknown) => fn({
    run: async (c: string) => { runs.push(c); return { records: found ? [{ get: () => ['/data/att/1.pdf', null] }] : [] } },
  })),
}

vi.mock('@opengraphity/neo4j', () => ({ runQuery: vi.fn(), runQueryOne: vi.fn(), getSession: vi.fn(), toNumber: (v: unknown) => Number(v ?? 0) }))
vi.mock('../ci-utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ci-utils.js')>()),
  withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(session)),
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))
vi.mock('../../../lib/publishEvent.js', () => ({ publishEvent: vi.fn() }))
vi.mock('@opengraphity/sla', () => ({
  cancelSLAJobs: vi.fn(),
  getActiveOLAContractsFor: vi.fn(async () => [{ id: 'ola-1' }]),
  cancelOLABreaches: vi.fn(),
}))
vi.mock('node:fs/promises', () => ({ rm: vi.fn(async () => undefined) }))

const { problemResolvers } = await import('../problem.js')
const sla = await import('@opengraphity/sla')
const { publishEvent } = await import('../../../lib/publishEvent.js')
const fs = await import('node:fs/promises')

const admin: GraphQLContext = { tenantId: 'tenant-1', userId: 'u1', userEmail: 'a@x', role: 'admin', permissions: perms('admin') }
const operator: GraphQLContext = { ...admin, role: 'operator', permissions: perms('operator') }

beforeEach(() => { vi.clearAllMocks(); runs.length = 0; found = true })

describe('deleteProblem', () => {
  it('solo admin: un operatore è rifiutato prima di scrivere', async () => {
    await expect(problemResolvers.Mutation.deleteProblem(undefined, { id: 'p1' }, operator)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } })
    expect(runs).toHaveLength(0)
  })

  it('porta via stato SLA, commenti, allegati e notifiche insieme al problem', async () => {
    await problemResolvers.Mutation.deleteProblem(undefined, { id: 'p1' }, admin)
    const cypher = runs[0]!
    for (const piece of ['[:HAS_SLA]->(sla:SLAStatus)', '[:HAS_COMMENT]->(c)', 'x:Attachment', 'x:Notification', 'DETACH DELETE p']) {
      expect(cypher, piece).toContain(piece)
    }
  })

  it('dopo il commit annulla i job di breach SLA e OLA, toglie i file e pubblica problem.deleted', async () => {
    await problemResolvers.Mutation.deleteProblem(undefined, { id: 'p1' }, admin)
    // In the tenant's own queues (23 Sep 2026): the tenant comes first.
    expect(sla.cancelSLAJobs).toHaveBeenCalledWith('tenant-1', 'p1', 'both')
    expect(sla.cancelOLABreaches).toHaveBeenCalledWith('tenant-1', 'p1', ['ola-1'])
    expect(fs.rm).toHaveBeenCalledWith('/data/att/1.pdf', { force: true })
    expect(publishEvent).toHaveBeenCalledWith('problem.deleted', 'tenant-1', 'u1', { id: 'p1' }, expect.any(String))
  })

  it('problem inesistente → NOT_FOUND, nessun job toccato', async () => {
    found = false
    await expect(problemResolvers.Mutation.deleteProblem(undefined, { id: 'nope' }, admin)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(sla.cancelSLAJobs).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
  })
})
