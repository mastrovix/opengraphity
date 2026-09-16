/**
 * Pinna la policy di autorizzazione centrale (lib/authorization.ts):
 * - ogni campo root dello SDL ha una regola di permessi, e ogni regola un campo
 * - end_user vede solo la superficie del portale
 * - il wrapper rifiuta prima di chiamare il resolver
 *
 * Dall'ondata 7 di «Nulla cablato» un ruolo è un insieme di permessi: qui i
 * ruoli sono quelli di fabbrica (`FACTORY_ROLE_PERMISSIONS`). Il confronto con
 * il comportamento di prima, operazione per operazione, è
 * `authorizationBeforeAfter.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildSchema, parse, type GraphQLObjectType, type ObjectTypeExtensionNode } from 'graphql'
import { FACTORY_ROLE_PERMISSIONS, type Permission } from '@opengraphity/types'
import { metamodelSDL } from '@opengraphity/schema-generator'
import { buildBaseSDL } from '../../graphql/schema-base.js'
import { eventsSDL } from '../../graphql/schema-events.js'
import { servicesSDL } from '../../graphql/schema-services.js'
import { authorize as authorizeWith, applyAuthorizationPolicy, requirementOf, ROLES, type RootKind } from '../authorization.js'
import { OPERATION_PERMISSIONS, AUTHENTICATED } from '../operationPermissions.js'
import { allowedRoles, authorizeFactory, factoryPermissions } from './factoryRoles.js'

const schema = buildSchema(buildBaseSDL() + metamodelSDL())
const rootFields = (name: 'Query' | 'Mutation') =>
  Object.keys((schema.getType(name) as GraphQLObjectType).getFields())
const queryFields    = rootFields('Query')
const mutationFields = rootFields('Mutation')

const perms = factoryPermissions
const authorize = authorizeFactory

describe('policy ↔ schema', () => {
  it('ogni regola nomina un campo dello SDL, e ogni campo dello SDL ha una regola', () => {
    const sdl = new Set([...queryFields.map((f) => `Query.${f}`), ...mutationFields.map((f) => `Mutation.${f}`)])
    expect([...OPERATION_PERMISSIONS.keys()].filter((op) => !sdl.has(op))).toEqual([])
    expect([...sdl].filter((op) => !OPERATION_PERMISSIONS.has(op))).toEqual([])
  })

  it('ogni permesso citato esiste nel catalogo, e ogni campo si apre ad almeno un ruolo di fabbrica', () => {
    for (const [op, req] of OPERATION_PERMISSIONS) {
      if (req !== AUTHENTICATED) for (const p of req) expect(FACTORY_ROLE_PERMISSIONS.admin, op).toContain(p)
      const [kind, field] = op.split('.') as [RootKind, string]
      expect(allowedRoles(kind, field).length, op).toBeGreaterThan(0)
    }
  })

  it('i ruoli di fabbrica sono la lista condivisa', () => {
    expect(Object.keys(FACTORY_ROLE_PERMISSIONS).sort()).toEqual([...ROLES].sort())
  })

  it('end_user vede esattamente la superficie del portale', () => {
    const q = queryFields.filter((f) => allowedRoles('Query', f).includes('end_user')).sort()
    const m = mutationFields.filter((f) => allowedRoles('Mutation', f).includes('end_user')).sort()
    expect(q).toEqual([
      'attachmentPolicy',
      // Moduli del catalogo (ondata 1): il portale legge il modulo della voce
      // che l'utente ha scelto, quindi la query entra nella sua superficie.
      'catalogFormToFill',
      'fieldRequirementRules', 'fieldVisibilityRules', 'kbArticle', 'kbArticleBySlug', 'kbArticles', 'kbCategories',
      'me', 'myTicket', 'myTicketStats', 'myTickets', 'portalCustomFields', 'portalSeverityChoices', 'serviceCatalogItems',
      'tenantBrand', 'tenantLanguageSettings', 'ticketCategories',
    ])
    // setMyLanguage: la lingua della persona, anche dal portale (secondo giro UI del 15 set 2026)
    expect(m).toEqual(['addTicketComment', 'createServiceRequest', 'createTicket', 'deleteComment', 'rateKBArticle', 'reopenTicket', 'setMyLanguage', 'updateComment'])
  })

  it('viewer non scrive tranne le azioni personali', () => {
    const m = mutationFields.filter((f) => allowedRoles('Mutation', f).includes('viewer')).sort()
    expect(m).toEqual([
      'addDashboardWidget', 'cloneDashboard', 'createCustomWidget', 'createDashboard', 'deleteCustomWidget', 'deleteDashboard',
      'deleteReportConversation', 'dismissAllNotifications', 'linkSlackAccount', 'markAllNotificationsRead', 'markNotificationRead',
      'rateKBArticle', 'removeDashboardWidget', 'reorderCustomWidgets', 'reorderDashboardWidgets', 'saveDashboardLayout',
      'setMyEmailNotifications', 'setMyLanguage', 'unwatchEntity', 'updateCustomWidget', 'updateDashboard', 'updateDashboardWidget', 'watchEntity',
    ])
  })

  it('la configurazione del tenant è admin-only (campione)', () => {
    // `customizeEnumType` (personalizzazioni A1-1) crea la copia di un
    // vocabolario spedito: è configurazione del metamodello, come le altre
    // mutation sugli enum.
    // `updateDomainMatrix` (ondata 7) modifica una regola di dominio del
    // cliente — priorità = impatto × urgenza, criticità → impatto: è
    // configurazione del tenant come i vocabolari da cui prende i valori.
    for (const f of ['createTeam', 'createOutboundWebhook', 'triggerSync', 'saveWorkflowChanges', 'createBusinessRule', 'createUser',
      'createEnumType', 'updateEnumType', 'deleteEnumType', 'customizeEnumType', 'updateDomainMatrix']) {
      expect(allowedRoles('Mutation', f)).toEqual(['admin'])
    }
    for (const f of ['logs', 'apiKeys', 'syncSources', 'notificationChannels', 'domainMatrices']) {
      expect(allowedRoles('Query', f)).toEqual(['admin'])
    }
  })

  it('ondata 7: le criticità «critiche» le legge tutto lo staff, non solo l\'admin', () => {
    // Il banner della console allarmi le chiede per costruire il filtro: se
    // fosse admin-only, per un operatore il banner tacerebbe — che è
    // esattamente il guasto C-7 in un'altra forma.
    expect(allowedRoles('Query', 'criticalServiceCriticalities')).toEqual(['admin', 'operator', 'viewer'])
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
    // `monitoringSource(id)` (residuo D·5) ha la stessa politica della lista: è la stessa configurazione completa.
    monitoringSources: ADMIN, monitoringSource: ADMIN, payloadKeys: ADMIN, sampleInboundPayload: ADMIN,
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
    for (const f of ['monitoringSources', 'monitoringSource', 'payloadKeys', 'sampleInboundPayload']) {
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
    // ondata 3: le capacità di business sono una lettura come la pagina Servizi
    businessCapabilitiesHealth: STAFF,
    // strumento della creazione (BusinessApplication senza mappa) e strumenti
    // della configurazione (ondata 2): diff con il grafo e anteprima del calcolo
    serviceMapCandidates: ADMIN, serviceMapProposal: ADMIN, serviceImpactPreview: ADMIN,
    // secondo giro UI del 15 set 2026: l'anteprima dei componenti prima di creare la mappa
    serviceMapCreationPreview: ADMIN,
    // ondata 6 · C-3: i tipi di relazione percorribili dal cliente, per il
    // dialogo di creazione (admin come le candidate)
    serviceRelationshipTypes: ADMIN,
  }
  const EXPECTED_MUTATIONS: Record<string, readonly string[]> = {
    createServiceMap: ADMIN, reevaluateServiceMap: ADMIN, setServiceMapStatus: ADMIN, deleteServiceMap: ADMIN,
    // configurazione da interfaccia (ondata 2)
    updateServiceImpactRules: ADMIN, updateServiceMapNodes: ADMIN, applyServiceMapProposal: ADMIN, removeServiceMapExclusion: ADMIN,
    // mappa viva (ondata 5): interruttore e sincronizzazione immediata
    setServiceMapAutoSync: ADMIN, syncServiceMap: ADMIN,
    // revisione del 15 set 2026 · SV-6: tipi di relazione e profondità di una mappa esistente
    updateServiceMapScope: ADMIN,
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
    for (const f of ['serviceMapCandidates', 'serviceMapCreationPreview', 'serviceMapProposal', 'serviceImpactPreview', 'serviceRelationshipTypes']) {
      expect(() => authorize('Query', f, 'operator')).toThrow(new RegExp(f))
      expect(() => authorize('Query', f, 'viewer')).toThrow(new RegExp(f))
    }
    expect(() => authorize('Query', 'serviceMaps', 'viewer')).not.toThrow()
    expect(() => authorize('Query', 'businessCapabilitiesHealth', 'viewer')).not.toThrow()
    expect(() => authorize('Query', 'businessCapabilitiesHealth', 'end_user')).toThrow()
    expect(() => authorize('Query', 'servicesImpactedByCI', 'viewer')).not.toThrow()
    expect(() => authorize('Query', 'serviceMaps', 'end_user')).toThrow()
  })
})

describe('authorize()', () => {
  it('rifiuta operator su mutation admin-only e end_user fuori dal portale, nominando i permessi', () => {
    expect(() => authorize('Mutation', 'createTeam', 'operator')).toThrow(/createTeam.*admin\.users/)
    expect(() => authorize('Query', 'incidents', 'end_user')).toThrow(/incidents/)
    expect(() => authorize('Mutation', 'createIncident', 'viewer')).toThrow(/createIncident/)
  })
  it('consente i casi base', () => {
    expect(() => authorize('Query', 'incidents', 'viewer')).not.toThrow()
    expect(() => authorize('Mutation', 'createIncident', 'operator')).not.toThrow()
    expect(() => authorize('Mutation', 'createTicket', 'end_user')).not.toThrow()
    expect(() => authorize('Mutation', 'watchEntity', 'viewer')).not.toThrow()
  })
  it('un ruolo con i permessi del portale e della knowledge base li ha entrambi (si possono mescolare)', () => {
    const referente = new Set<Permission>(['portal.read', 'portal.submit', 'kb.read', 'kb.write'])
    expect(() => authorizeWith('Mutation', 'createTicket', 'referente', referente)).not.toThrow()
    expect(() => authorizeWith('Mutation', 'updateKBArticle', 'referente', referente)).not.toThrow()
    expect(() => authorizeWith('Query', 'incidents', 'referente', referente)).toThrow(/incident\.read/)
  })
  it('un ruolo senza permessi entra solo nelle letture di chiunque', () => {
    const vuoto = new Set<Permission>()
    expect(() => authorizeWith('Query', 'me', 'vuoto', vuoto)).not.toThrow()
    expect(() => authorizeWith('Query', 'myTickets', 'vuoto', vuoto)).toThrow()
  })
  it('i campi generati per un tipo di CI seguono cmdb.read / cmdb.write', () => {
    const dyn = new Set(['Query.servers', 'Mutation.createServer'])
    expect(requirementOf('Query', 'servers', dyn)).toEqual(['cmdb.read'])
    expect(requirementOf('Mutation', 'createServer', dyn)).toEqual(['cmdb.write'])
    expect(requirementOf('Query', 'servers')).toBeUndefined()
  })
})

describe('applyAuthorizationPolicy()', () => {
  const ctx = (role: string) => ({ tenantId: 't', userId: 'u', userEmail: 'e', role, permissions: perms(role) }) as never
  const info = {} as never
  const full = () => {
    const Query: Record<string, (...a: unknown[]) => unknown>    = {}
    const Mutation: Record<string, (...a: unknown[]) => unknown> = {}
    for (const f of queryFields)    Query[f]    = vi.fn(() => `q:${f}`)
    for (const f of mutationFields) Mutation[f] = vi.fn(() => `m:${f}`)
    return { Query, Mutation }
  }

  it('fallisce all\'avvio se la policy cita campi inesistenti', () => {
    expect(() => applyAuthorizationPolicy({ Query: { me: () => 1 }, Mutation: {} })).toThrow(/fields that do not exist/)
  })

  it('fallisce all\'avvio se un campo non ha una regola', () => {
    const r = full()
    r.Query['nuovaQuery'] = () => 1
    expect(() => applyAuthorizationPolicy(r)).toThrow(/without a permission rule.*Query\.nuovaQuery/)
    expect(() => applyAuthorizationPolicy(r, { dynamicCI: new Set(['Query.nuovaQuery']) })).not.toThrow()
  })

  it('avvolge i resolver: nega prima di chiamarli, passa altrimenti (i permessi vengono dal contesto)', () => {
    const { Query, Mutation } = full()
    const wrapped = applyAuthorizationPolicy({ Query, Mutation })

    expect(() => wrapped.Mutation!['createTeam']!(null, {}, ctx('operator'), info)).toThrow(/createTeam/)
    expect(Mutation['createTeam']).not.toHaveBeenCalled()

    expect(wrapped.Mutation!['createTeam']!(null, {}, ctx('admin'), info)).toBe('m:createTeam')
    expect(wrapped.Query!['myTickets']!(null, {}, ctx('end_user'), info)).toBe('q:myTickets')
    expect(() => wrapped.Query!['incidents']!(null, {}, ctx('end_user'), info)).toThrow()
  })
})
