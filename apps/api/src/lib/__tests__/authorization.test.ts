/**
 * Pinna la policy di autorizzazione centrale (lib/authorization.ts):
 * - ogni campo root dello SDL base ha una classificazione (default o esplicita)
 * - ogni nome nelle liste statiche esiste nello SDL base
 * - end_user vede solo la superficie del portale
 * - il wrapper rifiuta prima di chiamare il resolver
 */
import { describe, it, expect, vi } from 'vitest'
import { buildSchema, type GraphQLObjectType } from 'graphql'
import { buildBaseSDL } from '../../graphql/schema-base.js'
import {
  allowedRoles, authorize, applyAuthorizationPolicy,
  ADMIN_ONLY_QUERIES, ADMIN_ONLY_MUTATIONS, VIEWER_ALLOWED_MUTATIONS,
  END_USER_ALLOWED_QUERIES, END_USER_ALLOWED_MUTATIONS, ROLES,
} from '../authorization.js'

const schema = buildSchema(buildBaseSDL())
const rootFields = (name: 'Query' | 'Mutation') =>
  Object.keys((schema.getType(name) as GraphQLObjectType).getFields())
const queryFields    = rootFields('Query')
const mutationFields = rootFields('Mutation')

describe('policy ↔ schema', () => {
  it('ogni nome nelle liste statiche esiste nello SDL base', () => {
    const missing = [
      ...[...ADMIN_ONLY_QUERIES, ...END_USER_ALLOWED_QUERIES].filter((f) => !queryFields.includes(f)).map((f) => `Query.${f}`),
      ...[...ADMIN_ONLY_MUTATIONS, ...VIEWER_ALLOWED_MUTATIONS, ...END_USER_ALLOWED_MUTATIONS].filter((f) => !mutationFields.includes(f)).map((f) => `Mutation.${f}`),
    ]
    expect(missing).toEqual([])
  })

  it('ogni campo root ha almeno un ruolo e mai un ruolo sconosciuto', () => {
    for (const f of queryFields)    expect(allowedRoles('Query', f).length, f).toBeGreaterThan(0)
    for (const f of mutationFields) expect(allowedRoles('Mutation', f).length, f).toBeGreaterThan(0)
    for (const f of [...queryFields, ...mutationFields]) {
      for (const r of allowedRoles(queryFields.includes(f) ? 'Query' : 'Mutation', f)) expect(ROLES).toContain(r)
    }
  })

  it('end_user vede esattamente la superficie del portale', () => {
    const q = queryFields.filter((f) => allowedRoles('Query', f).includes('end_user')).sort()
    const m = mutationFields.filter((f) => allowedRoles('Mutation', f).includes('end_user')).sort()
    expect(q).toEqual([...END_USER_ALLOWED_QUERIES].sort())
    expect(m).toEqual([...END_USER_ALLOWED_MUTATIONS].sort())
  })

  it('viewer non scrive tranne le azioni personali', () => {
    const m = mutationFields.filter((f) => allowedRoles('Mutation', f).includes('viewer')).sort()
    expect(m).toEqual([...VIEWER_ALLOWED_MUTATIONS].sort())
  })

  it('la configurazione del tenant è admin-only (campione)', () => {
    for (const f of ['createTeam', 'createOutboundWebhook', 'triggerSync', 'saveWorkflowChanges', 'createBusinessRule', 'createUser']) {
      expect(allowedRoles('Mutation', f)).toEqual(['admin'])
    }
    for (const f of ['logs', 'apiKeys', 'syncSources', 'notificationChannels']) {
      expect(allowedRoles('Query', f)).toEqual(['admin'])
    }
  })
})

describe('authorize()', () => {
  it('rifiuta ruoli sconosciuti con messaggio esplicito', () => {
    expect(() => authorize('Query', 'incidents', 'manager')).toThrow(/Ruolo sconosciuto 'manager'/)
  })
  it('rifiuta operator su mutation admin-only e end_user fuori dal portale', () => {
    expect(() => authorize('Mutation', 'createTeam', 'operator')).toThrow(/createTeam/)
    expect(() => authorize('Query', 'incidents', 'end_user')).toThrow(/incidents/)
    expect(() => authorize('Mutation', 'createIncident', 'viewer')).toThrow(/createIncident/)
  })
  it('consente i casi base', () => {
    expect(() => authorize('Query', 'incidents', 'viewer')).not.toThrow()
    expect(() => authorize('Mutation', 'createIncident', 'operator')).not.toThrow()
    expect(() => authorize('Mutation', 'createTicket', 'end_user')).not.toThrow()
    expect(() => authorize('Mutation', 'watchEntity', 'viewer')).not.toThrow()
  })
})

describe('applyAuthorizationPolicy()', () => {
  const ctx = (role: string) => ({ tenantId: 't', userId: 'u', userEmail: 'e', role }) as never
  const info = {} as never

  it('fallisce all\'avvio se la policy cita campi inesistenti', () => {
    expect(() => applyAuthorizationPolicy({ Query: { me: () => 1 }, Mutation: {} })).toThrow(/campi inesistenti/)
  })

  it('avvolge i resolver: nega prima di chiamarli, passa altrimenti', () => {
    const Query: Record<string, (...a: unknown[]) => unknown>    = {}
    const Mutation: Record<string, (...a: unknown[]) => unknown> = {}
    for (const f of queryFields)    Query[f]    = vi.fn(() => `q:${f}`)
    for (const f of mutationFields) Mutation[f] = vi.fn(() => `m:${f}`)
    const wrapped = applyAuthorizationPolicy({ Query, Mutation })

    expect(() => wrapped.Mutation!['createTeam']!(null, {}, ctx('operator'), info)).toThrow(/createTeam/)
    expect(Mutation['createTeam']).not.toHaveBeenCalled()

    expect(wrapped.Mutation!['createTeam']!(null, {}, ctx('admin'), info)).toBe('m:createTeam')
    expect(wrapped.Query!['myTickets']!(null, {}, ctx('end_user'), info)).toBe('q:myTickets')
    expect(() => wrapped.Query!['incidents']!(null, {}, ctx('end_user'), info)).toThrow()
  })
})
