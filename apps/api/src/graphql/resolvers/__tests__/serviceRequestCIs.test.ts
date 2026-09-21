/**
 * I CI di una richiesta di servizio (revisione del 15 set 2026 · CM-8).
 *
 * Le richieste non si collegavano a nessun CI: «accesso al server X» non
 * poteva dire quale server. Il collegamento è `CONCERNS_CI`, e i tipi di CI
 * esclusi per le richieste non si collegano, come per gli altri ticket.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../ci-utils.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../ci-utils.js')>()
  return { ...orig, withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn({})) }
})
vi.mock('../../../services/requestService.js', () => ({ createRequest: vi.fn(), mapRequest: vi.fn((p: Record<string, unknown>) => p) }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/ciLabelsForTenant.js', () => ({ ciLabelPredicateForTenant: vi.fn(async (a: string) => `(${a}:Server OR ${a}:Firewall)`) }))
vi.mock('../../../lib/ciTypeFromLabels.js', () => ({ ciTypeFromLabels: vi.fn((_t: string, l: string[]) => l[0]!.toLowerCase()) }))
const excluded = { value: false }
const assertCIsLinkable = vi.fn(async () => { if (excluded.value) throw new Error('These CIs cannot be linked to a service_request') })
vi.mock('../../../lib/ticketCIExclusions.js', () => ({ assertCIsLinkable: (...a: unknown[]) => (assertCIsLinkable as (...x: unknown[]) => Promise<void>)(...a) }))

const { serviceRequestResolvers } = await import('../service_request.js')
const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { audit } = await import('../../../lib/audit.js')

const ctx: GraphQLContext = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'operator', permissions: perms('operator') }

beforeEach(() => { vi.clearAllMocks(); excluded.value = false })

describe('addCIToServiceRequest', () => {
  it('collega con CONCERNS_CI, nel tenant, dopo il controllo delle esclusioni per le richieste', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ props: { id: 'sr-1' }, linked: 1 } as never)
    await serviceRequestResolvers.Mutation.addCIToServiceRequest(null, { requestId: 'sr-1', ciId: 'fw-1' }, ctx)
    expect(assertCIsLinkable).toHaveBeenCalledWith('t1', 'service_request', ['fw-1'])
    const [, cypher, params] = vi.mocked(runQueryOne).mock.calls[0]!
    expect(cypher).toContain('MERGE (r)-[l:CONCERNS_CI]->(ci)')
    expect(cypher).toContain('(ci:Server OR ci:Firewall)')
    expect(params).toMatchObject({ requestId: 'sr-1', ciId: 'fw-1', tenantId: 't1' })
    expect(audit).toHaveBeenCalledWith(ctx, 'request.ci_added', 'ServiceRequest', 'sr-1', { ciId: 'fw-1' })
  })

  it('un tipo escluso per le richieste → rifiutato senza scrivere', async () => {
    excluded.value = true
    await expect(serviceRequestResolvers.Mutation.addCIToServiceRequest(null, { requestId: 'sr-1', ciId: 'cert-1' }, ctx)).rejects.toThrow(/cannot be linked/)
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('richiesta o CI che non esistono nel tenant → errore, non «collegato»', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(null as never)
    await expect(serviceRequestResolvers.Mutation.addCIToServiceRequest(null, { requestId: 'sr-x', ciId: 'ci-x' }, ctx))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.ciLink.request' } } })
  })
})

describe('removeCIFromServiceRequest', () => {
  it('un collegamento che non c\'è → NOT_FOUND, niente audit', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ props: { id: 'sr-1' }, removed: 0 } as never)
    await expect(serviceRequestResolvers.Mutation.removeCIFromServiceRequest(null, { requestId: 'sr-1', ciId: 'ci-9' }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(audit).not.toHaveBeenCalled()
  })
})

describe('ServiceRequest.affectedCIs', () => {
  it('legge i CI collegati nel tenant, col tipo dall\'etichetta', async () => {
    vi.mocked(runQuery).mockResolvedValue([{ props: { id: 'fw-1', name: 'FW-01' }, label: 'Firewall' }] as never)
    const out = await serviceRequestResolvers.ServiceRequest.affectedCIs({ id: 'sr-1' }, null, ctx) as Record<string, unknown>[]
    expect(String(vi.mocked(runQuery).mock.calls[0]![1])).toContain('-[:CONCERNS_CI]->(ci)')
    expect(out[0]).toMatchObject({ id: 'fw-1', name: 'FW-01', type: 'firewall', __typename: 'Firewall' })
  })
})
