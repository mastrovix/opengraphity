/**
 * Il registro unico delle mutation (giro UI del 15 set 2026 · U-25).
 *
 * Nel giro, confrontando l'Audit Log col grafo, mancavano le voci per la
 * creazione di un tipo CI, di un campo ITIL, di una policy SLA, per il
 * collegamento di un CI a un incident e per la creazione di una change: circa
 * 120 mutation su 257 non scrivevano niente. Ora ogni mutation riuscita senza
 * una voce sua ne riceve una dal registro.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ApolloServer } from '@apollo/server'
import { makeExecutableSchema } from '@graphql-tools/schema'

const audit = vi.hoisted(() => vi.fn())
vi.mock('../../lib/audit.js', async () => {
  const { noteAuditWritten } = await import('../../lib/auditScope.js')
  return { audit: vi.fn((...a: unknown[]) => { noteAuditWritten(); audit(...a); return Promise.resolve() }) }
})
const logError = vi.hoisted(() => vi.fn())
vi.mock('../../lib/logger.js', () => ({ logger: { child: () => ({ error: logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) } }))

const { auditMutationsPlugin, AUDIT_REGISTRY_SKIPPED, auditableArgs, auditEntityId, auditEntityType } = await import('../auditMutationsPlugin.js')
const { runInAuditScope } = await import('../../lib/auditScope.js')
const auditModule = await import('../../lib/audit.js')
const { OPERATION_PERMISSIONS } = await import('../../lib/operationPermissions.js')

const typeDefs = /* GraphQL */ `
  type SLAPolicy { id: ID! name: String! }
  type Query { ok: Boolean }
  type Mutation {
    createSLAPolicy(input: SLAInput!): SLAPolicy!
    deleteSLAPolicy(id: ID!): Boolean!
    createApiKey(name: String!, apiKey: String): Boolean!
    explicitAudit(id: ID!): Boolean!
    failing(id: ID!): Boolean!
    markNotificationRead(id: ID!): Boolean!
  }
  input SLAInput { name: String! description: String }
`
const resolvers = {
  Mutation: {
    createSLAPolicy: (_: unknown, a: { input: { name: string } }) => ({ id: 'sla-1', name: a.input.name }),
    deleteSLAPolicy: () => true,
    createApiKey: () => true,
    explicitAudit: (_: unknown, a: { id: string }, ctx: never) => { void auditModule.audit(ctx, 'thing.done', 'Thing', a.id); return true },
    failing: () => { throw new Error('nope') },
    markNotificationRead: () => true,
  },
}
const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'admin', permissions: new Set() }

async function run(query: string, variables: Record<string, unknown> = {}, scoped = true) {
  const server = new ApolloServer({ schema: makeExecutableSchema({ typeDefs, resolvers }), plugins: [auditMutationsPlugin()] })
  await server.start()
  const exec = () => server.executeOperation({ query, variables }, { contextValue: ctx as never })
  const res = scoped ? await runInAuditScope(exec) : await exec()
  await server.stop()
  return res
}

beforeEach(() => { audit.mockClear(); logError.mockClear() })

describe('registro unico delle mutation', () => {
  it('una mutation senza voce sua viene registrata: azione, tipo e id dall\'oggetto restituito, argomenti', async () => {
    await run('mutation { createSLAPolicy(input: { name: "Rete", description: "x" }) { id } }')
    expect(audit).toHaveBeenCalledWith(ctx, 'mutation.createSLAPolicy', 'SLAPolicy', 'sla-1', { args: { input: { name: 'Rete', description: 'x' } }, source: 'audit-registry' })
  })

  it('una mutation che restituisce un Boolean: tipo dal nome senza verbo, id dagli argomenti', async () => {
    await run('mutation { deleteSLAPolicy(id: "sla-9") }')
    expect(audit).toHaveBeenCalledWith(ctx, 'mutation.deleteSLAPolicy', 'SLAPolicy', 'sla-9', expect.anything())
  })

  it('i segreti non entrano mai nella voce', async () => {
    await run('mutation { createApiKey(name: "ci", apiKey: "sk-123") }')
    expect(audit.mock.calls[0]![4]).toEqual({ args: { name: 'ci', apiKey: '[redacted]' }, source: 'audit-registry' })
    expect(auditableArgs({ webhook_url: 'https://h', nested: { signingSecret: 's', ok: 1 } })).toEqual({ webhook_url: '[redacted]', nested: { signingSecret: '[redacted]', ok: 1 } })
  })

  it('una mutation che ha già scritto la sua voce non ne riceve una seconda', async () => {
    await run('mutation { explicitAudit(id: "x") }')
    expect(audit.mock.calls.map((c) => c[1])).toEqual(['thing.done'])
  })

  it('più mutation nella stessa richiesta: il conto è per mutation', async () => {
    await run('mutation { a: explicitAudit(id: "x") b: deleteSLAPolicy(id: "sla-2") }')
    expect(audit.mock.calls.map((c) => c[1])).toEqual(['thing.done', 'mutation.deleteSLAPolicy'])
  })

  it('una mutation fallita e le mutation escluse non vanno nel registro', async () => {
    await run('mutation { failing(id: "x") }')
    await run('mutation { markNotificationRead(id: "n1") }')
    expect(audit).not.toHaveBeenCalled()
  })

  it('senza il conto della richiesta non si registra alla cieca: lo dice il log', async () => {
    await run('mutation { deleteSLAPolicy(id: "sla-3") }', {}, false)
    expect(audit).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ mutation: 'deleteSLAPolicy' }), expect.stringContaining('no audit scope'))
  })

  it('le esclusioni sono mutation vere dell\'API (niente nomi scaduti)', () => {
    for (const name of Object.keys(AUDIT_REGISTRY_SKIPPED)) {
      expect(OPERATION_PERMISSIONS.has(`Mutation.${name}`), name).toBe(true)
    }
  })

  it('id e tipo: ordine delle fonti', () => {
    expect(auditEntityId({ input: { id: 'in' } }, { id: 'res' })).toBe('in')
    expect(auditEntityId({ ciId: 'ci-1', incidentId: 'inc-1' }, true)).toBe('ci-1')
    expect(auditEntityId({}, null)).toBe('')
    expect(auditEntityType('addAffectedCI', 'Boolean!')).toBe('AffectedCI')
    expect(auditEntityType('updateIncident', '[Incident!]!')).toBe('Incident')
    // «…ToChange»: la voce è della change, non del wrapper restituito (secondo giro UI del 15 set 2026)
    expect(auditEntityType('addCIToChange', 'ChangeAffectedCI!', { changeId: 'chg-1', ciId: 'ci-1' })).toBe('Change')
    expect(auditEntityId({ changeId: 'chg-1', ciId: 'ci-1' }, { ci: {} }, 'addCIToChange')).toBe('chg-1')
    expect(auditEntityType('removeCIFromServiceRequest', 'Boolean!', { requestId: 'r-1', ciId: 'c' })).toBe('ServiceRequest')
    expect(auditEntityId({ requestId: 'r-1', ciId: 'c' }, true, 'removeCIFromServiceRequest')).toBe('r-1')
    expect(auditEntityType('assignIncidentToTeam', 'Incident!', { incidentId: 'i', teamId: 't' })).toBe('Incident')
    // senza l'argomento del contenitore resta la regola di prima
    expect(auditEntityType('addAffectedCI', 'Boolean!', { incidentId: 'i', ciId: 'c' })).toBe('AffectedCI')
  })
})
