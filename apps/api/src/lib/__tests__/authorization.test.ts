/**
 * Pinna la policy di autorizzazione centrale (lib/authorization.ts):
 * - ogni campo root dello SDL base ha una classificazione (default o esplicita)
 * - ogni nome nelle liste statiche esiste nello SDL base
 * - end_user vede solo la superficie del portale
 * - il wrapper rifiuta prima di chiamare il resolver
 */
import { describe, it, expect, vi } from 'vitest'
import { buildSchema, parse, type GraphQLObjectType, type ObjectTypeExtensionNode } from 'graphql'
import { buildBaseSDL } from '../../graphql/schema-base.js'
import { eventsSDL } from '../../graphql/schema-events.js'
import { servicesSDL } from '../../graphql/schema-services.js'
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

/**
 * Event Management (X-1 della revisione): tabella campo → ruoli attesi per
 * OGNI Query e Mutation di eventsSDL(). Un campo nuovo nello SDL senza riga
 * qui fa fallire il test (la policy va decisa, non ereditata per caso); una
 * riga senza campo idem.
 */
describe('Event Management: ogni campo root di eventsSDL() ha i ruoli attesi', () => {
  const STAFF: readonly string[] = ['admin', 'operator', 'viewer']
  const OPERATORS: readonly string[] = ['admin', 'operator']
  const ADMIN: readonly string[] = ['admin']

  const EXPECTED_QUERIES: Record<string, readonly string[]> = {
    events: STAFF, event: STAFF, eventStats: STAFF, ciAliases: STAFF, eventPolicy: STAFF,
    ciHealth: STAFF, ciHealthOverview: STAFF,
    // riferimenti leggeri per il filtro della console
    monitoringSourceRefs: STAFF,
    // configurazione delle sorgenti e strumenti del wizard (A-1, A-3)
    monitoringSources: ADMIN, payloadKeys: ADMIN, sampleInboundPayload: ADMIN,
  }
  const EXPECTED_MUTATIONS: Record<string, readonly string[]> = {
    acknowledgeEvent: OPERATORS, resolveEvent: OPERATORS, linkEventToCI: OPERATORS,
    createIncidentFromEvent: OPERATORS, reevaluateEvent: OPERATORS, setCIHealthOverride: OPERATORS,
    createCIAlias: ADMIN, deleteCIAlias: ADMIN, updateEventPolicy: ADMIN, sendSampleEvent: ADMIN,
    previewInboundEvents: ADMIN,
  }

  const rootFieldsOf = (kind: 'Query' | 'Mutation') =>
    parse(eventsSDL()).definitions
      .filter((d): d is ObjectTypeExtensionNode => d.kind === 'ObjectTypeExtension' && d.name.value === kind)
      .flatMap((d) => (d.fields ?? []).map((f) => f.name.value))
      .sort()

  it('la tabella copre esattamente i campi di eventsSDL()', () => {
    expect(rootFieldsOf('Query')).toEqual(Object.keys(EXPECTED_QUERIES).sort())
    expect(rootFieldsOf('Mutation')).toEqual(Object.keys(EXPECTED_MUTATIONS).sort())
  })

  it.each(Object.entries(EXPECTED_QUERIES))('Query.%s → %j', (field, roles) => {
    expect(allowedRoles('Query', field)).toEqual(roles)
  })
  it.each(Object.entries(EXPECTED_MUTATIONS))('Mutation.%s → %j', (field, roles) => {
    expect(allowedRoles('Mutation', field)).toEqual(roles)
  })

  it('viewer non esegue le mutation operative né legge la configurazione delle sorgenti; end_user niente', () => {
    for (const f of ['acknowledgeEvent', 'resolveEvent', 'linkEventToCI', 'createIncidentFromEvent']) {
      expect(() => authorize('Mutation', f, 'viewer')).toThrow(new RegExp(f))
      expect(() => authorize('Mutation', f, 'end_user')).toThrow(new RegExp(f))
    }
    for (const f of ['monitoringSources', 'payloadKeys', 'sampleInboundPayload']) {
      expect(() => authorize('Query', f, 'viewer')).toThrow(new RegExp(f))
      expect(() => authorize('Query', f, 'operator')).toThrow(new RegExp(f))
    }
    expect(() => authorize('Query', 'monitoringSourceRefs', 'viewer')).not.toThrow()
    expect(() => authorize('Query', 'events', 'end_user')).toThrow()
  })
})

/**
 * Servizi monitorati (ondate 1 e 2): tabella campo → ruoli attesi per OGNI Query e
 * Mutation di servicesSDL(). Letture per lo staff (come event(id)), scritture
 * e strumento di creazione solo admin.
 */
describe('Servizi monitorati: ogni campo root di servicesSDL() ha i ruoli attesi', () => {
  const STAFF: readonly string[] = ['admin', 'operator', 'viewer']
  const ADMIN: readonly string[] = ['admin']

  const EXPECTED_QUERIES: Record<string, readonly string[]> = {
    serviceMaps: STAFF, serviceMap: STAFF, servicesImpactedByCI: STAFF,
    // strumento della creazione (BusinessApplication senza mappa) e strumenti
    // della configurazione (ondata 2): diff con il grafo e anteprima del calcolo
    serviceMapCandidates: ADMIN, serviceMapProposal: ADMIN, serviceImpactPreview: ADMIN,
  }
  const EXPECTED_MUTATIONS: Record<string, readonly string[]> = {
    createServiceMap: ADMIN, reevaluateServiceMap: ADMIN, setServiceMapStatus: ADMIN, deleteServiceMap: ADMIN,
    // configurazione da interfaccia (ondata 2)
    updateServiceImpactRules: ADMIN, updateServiceMapNodes: ADMIN, applyServiceMapProposal: ADMIN, removeServiceMapExclusion: ADMIN,
  }

  const rootFieldsOf = (kind: 'Query' | 'Mutation') =>
    parse(servicesSDL()).definitions
      .filter((d): d is ObjectTypeExtensionNode => d.kind === 'ObjectTypeExtension' && d.name.value === kind)
      .flatMap((d) => (d.fields ?? []).map((f) => f.name.value))
      .sort()

  it('la tabella copre esattamente i campi di servicesSDL()', () => {
    expect(rootFieldsOf('Query')).toEqual(Object.keys(EXPECTED_QUERIES).sort())
    expect(rootFieldsOf('Mutation')).toEqual(Object.keys(EXPECTED_MUTATIONS).sort())
  })

  it.each(Object.entries(EXPECTED_QUERIES))('Query.%s → %j', (field, roles) => {
    expect(allowedRoles('Query', field)).toEqual(roles)
  })
  it.each(Object.entries(EXPECTED_MUTATIONS))('Mutation.%s → %j', (field, roles) => {
    expect(allowedRoles('Mutation', field)).toEqual(roles)
  })

  it('operator e viewer non scrivono né vedono le candidate; viewer legge la pagina Servizi; end_user niente', () => {
    for (const f of Object.keys(EXPECTED_MUTATIONS)) {
      expect(() => authorize('Mutation', f, 'operator')).toThrow(new RegExp(f))
      expect(() => authorize('Mutation', f, 'viewer')).toThrow(new RegExp(f))
    }
    for (const f of ['serviceMapCandidates', 'serviceMapProposal', 'serviceImpactPreview']) {
      expect(() => authorize('Query', f, 'operator')).toThrow(new RegExp(f))
      expect(() => authorize('Query', f, 'viewer')).toThrow(new RegExp(f))
    }
    expect(() => authorize('Query', 'serviceMaps', 'viewer')).not.toThrow()
    expect(() => authorize('Query', 'servicesImpactedByCI', 'viewer')).not.toThrow()
    expect(() => authorize('Query', 'serviceMaps', 'end_user')).toThrow()
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
