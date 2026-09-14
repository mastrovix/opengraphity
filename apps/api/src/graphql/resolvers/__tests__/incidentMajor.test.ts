/**
 * IT-24 (revisione del 14 set 2026): dichiarare un Major Incident pubblica un
 * evento — prima solo il flag e l'audit, e nessuna regola poteva reagire. Solo
 * quando il flag cambia davvero.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'

let was = false
vi.mock('@opengraphity/neo4j', () => ({
  runQuery: vi.fn(async (_s: unknown, _c: string, p: Record<string, unknown>) => [{ props: { id: p['id'], title: 'DB giù', severity: 'critical', status: 'new', number: 'INC1', major: p['major'] }, was }]),
  runQueryOne: vi.fn(), getSession: vi.fn(), toNumber: (v: unknown) => Number(v ?? 0),
}))
vi.mock('../ci-utils.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../ci-utils.js')>()), withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn({})) }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))
vi.mock('../../../lib/publishEvent.js', () => ({ publishEvent: vi.fn() }))

const { incidentResolvers } = await import('../incident.js')
const { publishEvent } = await import('../../../lib/publishEvent.js')
const ctx: GraphQLContext = { tenantId: 't1', userId: 'u1', userEmail: 'a@x', role: 'operator' }

beforeEach(() => { vi.clearAllMocks(); was = false })

describe('setIncidentMajor', () => {
  it('dichiarato → incident.major_declared', async () => {
    await incidentResolvers.Mutation.setIncidentMajor(undefined, { id: 'i1', major: true }, ctx)
    expect(publishEvent).toHaveBeenCalledWith('incident.major_declared', 't1', 'u1', expect.objectContaining({ id: 'i1', number: 'INC1' }), expect.any(String))
  })
  it('ritirato → incident.major_cleared; nessun cambiamento → nessun evento', async () => {
    was = true
    await incidentResolvers.Mutation.setIncidentMajor(undefined, { id: 'i1', major: false }, ctx)
    expect(publishEvent).toHaveBeenCalledWith('incident.major_cleared', 't1', 'u1', expect.anything(), expect.any(String))
    vi.clearAllMocks()
    await incidentResolvers.Mutation.setIncidentMajor(undefined, { id: 'i1', major: true }, ctx)
    expect(publishEvent).not.toHaveBeenCalled()
  })
})
