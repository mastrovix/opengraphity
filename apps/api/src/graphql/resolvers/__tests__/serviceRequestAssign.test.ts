/**
 * assignServiceRequestToUser — giro nel browser del 14 set 2026 (#41): una
 * richiesta non si poteva assegnare a nessuno, e ASSIGNEE restava «—» per
 * sempre. Le richieste non hanno un gruppo assegnatario, quindi la regola
 * «prima il gruppo» degli incident non vale; valgono queste:
 *  - si assegna a chi ha il permesso «Ricevere ticket» (ruoli di fabbrica admin,
 *    operator), non a un viewer o a un utente del portale;
 *  - una richiesta conclusa non si riassegna;
 *  - userId null toglie l'assegnatario.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

const h = vi.hoisted(() => ({ session: {} }))

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(h.session)),
}))
vi.mock('../../../services/requestService.js', () => ({
  createRequest: vi.fn(),
  mapRequest:    vi.fn((p: Record<string, unknown>) => p),
}))
vi.mock('../../../services/ticketAssignment.js', () => ({ setTicketUser: vi.fn().mockResolvedValue({ userName: 'Ada' }) }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
// Chi riceve i ticket lo dice il ruolo dell'assegnatario (ondata 7): qui i ruoli di fabbrica.
vi.mock('../../../lib/roles.js', async () => {
  const { FACTORY_ROLE_PERMISSIONS, isUserRole } = await import('@opengraphity/types')
  return {
    roleHasPermission: vi.fn(async (_t: string, role: string, p: string) => isUserRole(role) && (FACTORY_ROLE_PERMISSIONS[role] as readonly string[]).includes(p)),
  }
})

const { serviceRequestResolvers } = await import('../service_request.js')
const { runQueryOne } = await import('@opengraphity/neo4j')
const { setTicketUser } = await import('../../../services/ticketAssignment.js')
const { audit } = await import('../../../lib/audit.js')

const assign = serviceRequestResolvers.Mutation.assignServiceRequestToUser
const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'u@test.io', role: 'operator', permissions: perms('operator') }

async function failure(promise: Promise<unknown>): Promise<GraphQLError> {
  const err = await promise.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(GraphQLError)
  return err as GraphQLError
}

beforeEach(() => { vi.clearAllMocks() })

describe('assignServiceRequestToUser', () => {
  it('assegna a un operator: scrive l\'arco, registra l\'audit, restituisce la richiesta', async () => {
    vi.mocked(runQueryOne)
      .mockResolvedValueOnce({ completedAt: null, assigneeRole: 'operator', assigneeFound: true })
      .mockResolvedValueOnce({ props: { id: 'sr-1', title: 'T' } })
    const r = await assign(undefined, { id: 'sr-1', userId: 'user-9' }, ctx)
    expect(setTicketUser).toHaveBeenCalledWith(h.session, 'ServiceRequest', 'sr-1', 'user-9', 'tenant-1')
    expect(audit).toHaveBeenCalledWith(ctx, 'request.assigned', 'ServiceRequest', 'sr-1')
    expect(r).toEqual({ id: 'sr-1', title: 'T' })
  })

  it('NOT_FOUND se la richiesta non esiste nel tenant', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(null)
    const err = await failure(assign(undefined, { id: 'sr-x', userId: 'user-9' }, ctx))
    expect(err.extensions['code']).toBe('NOT_FOUND')
    expect(setTicketUser).not.toHaveBeenCalled()
  })

  it('una richiesta conclusa non si riassegna', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ completedAt: '2026-09-14T10:00:00Z', assigneeRole: 'operator', assigneeFound: true })
    const err = await failure(assign(undefined, { id: 'sr-1', userId: 'user-9' }, ctx))
    expect(err.extensions['i18n']).toMatchObject({ key: 'errors.request.assignConcluded' })
    expect(setTicketUser).not.toHaveBeenCalled()
  })

  it('un viewer o un utente del portale non è un assegnatario; un utente inesistente è NOT_FOUND', async () => {
    for (const role of ['viewer', 'end_user']) {
      vi.mocked(runQueryOne).mockResolvedValueOnce({ completedAt: null, assigneeRole: role, assigneeFound: true })
      const err = await failure(assign(undefined, { id: 'sr-1', userId: 'user-9' }, ctx))
      expect(err.extensions['i18n']).toMatchObject({ key: 'errors.request.assigneeCannotWork' })
    }
    vi.mocked(runQueryOne).mockResolvedValueOnce({ completedAt: null, assigneeRole: null, assigneeFound: false })
    const err = await failure(assign(undefined, { id: 'sr-1', userId: 'user-x' }, ctx))
    expect(err.extensions['code']).toBe('NOT_FOUND')
    expect(setTicketUser).not.toHaveBeenCalled()
  })

  it('userId null toglie l\'assegnatario senza controllare ruoli', async () => {
    vi.mocked(runQueryOne)
      .mockResolvedValueOnce({ completedAt: null, assigneeRole: null, assigneeFound: false })
      .mockResolvedValueOnce({ props: { id: 'sr-1' } })
    await assign(undefined, { id: 'sr-1', userId: null }, ctx)
    expect(setTicketUser).toHaveBeenCalledWith(h.session, 'ServiceRequest', 'sr-1', null, 'tenant-1')
  })
})
