/**
 * IT-24 (revisione del 14 set 2026): dichiarare un Major Incident pubblica un
 * evento — prima solo il flag e l'audit, e nessuna regola poteva reagire. Solo
 * quando il flag cambia davvero.
 *
 * 24 Sep 2026 (owner's decision «Diventa Critical»): declaring raises the
 * priority to the one of the customer's matrix `major_incident_priority`,
 * through the ordinary update (impact, urgency, `ticket.updated` for the
 * SLA); revoking does not lower it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

let was = false
let current: { severity: string | null; major: boolean; closed?: boolean } | null = { severity: 'medium', major: false }
vi.mock('@opengraphity/neo4j', () => ({
  runQuery: vi.fn(async (_s: unknown, _c: string, p: Record<string, unknown>) => [{ props: { id: p['id'], title: 'DB giù', severity: 'critical', status: 'new', number: 'INC1', major: p['major'] }, was }]),
  runQueryOne: vi.fn(async () => current), getSession: vi.fn(), toNumber: (v: unknown) => Number(v ?? 0),
}))
vi.mock('../ci-utils.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../ci-utils.js')>()), withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn({})) }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))
vi.mock('../../../lib/publishEvent.js', () => ({ publishEvent: vi.fn() }))
vi.mock('../../../lib/domainValue.js', () => ({ resolveDomainValue: vi.fn(async () => 'p1') }))
vi.mock('../../../services/incidentService.js', () => ({ updateIncident: vi.fn() }))

const { incidentResolvers } = await import('../incident.js')
const { publishEvent } = await import('../../../lib/publishEvent.js')
const { resolveDomainValue } = await import('../../../lib/domainValue.js')
const { updateIncident } = await import('../../../services/incidentService.js')
const ctx: GraphQLContext = { tenantId: 't1', userId: 'u1', userEmail: 'a@x', role: 'operator', permissions: perms('operator') }

beforeEach(() => { vi.clearAllMocks(); was = false; current = { severity: 'medium', major: false } })

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

  it('declaring raises the priority to the matrix value, through the ordinary update, before the flag', async () => {
    await incidentResolvers.Mutation.setIncidentMajor(undefined, { id: 'i1', major: true }, ctx)
    expect(resolveDomainValue).toHaveBeenCalledWith('t1', 'major_incident_priority', 'declared')
    expect(updateIncident).toHaveBeenCalledWith('i1', { severity: 'p1' }, ctx)
    expect(vi.mocked(updateIncident).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(publishEvent).mock.invocationCallOrder[0]!)
  })

  it('nothing to raise when it already has that priority or is already major; revoking never lowers it', async () => {
    current = { severity: 'p1', major: false }
    await incidentResolvers.Mutation.setIncidentMajor(undefined, { id: 'i1', major: true }, ctx)
    current = { severity: 'medium', major: true }
    await incidentResolvers.Mutation.setIncidentMajor(undefined, { id: 'i1', major: true }, ctx)
    await incidentResolvers.Mutation.setIncidentMajor(undefined, { id: 'i1', major: false }, ctx)
    expect(updateIncident).not.toHaveBeenCalled()
  })

  it('a closed incident is not declared major (G17)', async () => {
    current = { severity: 'medium', major: false, closed: true } as typeof current
    await expect(incidentResolvers.Mutation.setIncidentMajor(undefined, { id: 'i1', major: true }, ctx)).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.incident.majorOnClosed' } } })
    expect(updateIncident).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('a matrix with no value stops the declaration whole: no flag, no event', async () => {
    vi.mocked(resolveDomainValue).mockRejectedValueOnce(new Error('Matrix "major_incident_priority": no value for declared'))
    await expect(incidentResolvers.Mutation.setIncidentMajor(undefined, { id: 'i1', major: true }, ctx)).rejects.toThrow('no value')
    expect(publishEvent).not.toHaveBeenCalled()
  })
})
