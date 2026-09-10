/**
 * Contratto dei Servizi monitorati (ondata 1, schema-services.ts): gli enum
 * SDL sono generati da lib/serviceVocabularies.ts e coincidono con le liste
 * TS del motore; i tipi e i campi root sono quelli del contratto condiviso
 * con il web (nomi non negoziabili); ConfigurationItemRef e CIHealth sono
 * quelli dell'Event Management; Team è il tipo esistente.
 */
import { describe, it, expect } from 'vitest'
import { buildSchema, isEnumType, isNonNullType, isListType, type GraphQLObjectType, type GraphQLInputObjectType, type GraphQLType, type GraphQLEnumType } from 'graphql'
import { buildBaseSDL } from '../schema-base.js'
import { servicesSDL } from '../schema-services.js'
import { SERVICE_SDL_ENUMS, SERVICE_HEALTHS, SERVICE_HEALTH_SEVERITY_ORDER } from '../../lib/serviceVocabularies.js'

const schema = buildSchema(buildBaseSDL())

function unwrap(t: GraphQLType): GraphQLType {
  let cur = t
  while (isNonNullType(cur) || isListType(cur)) cur = cur.ofType
  return cur
}
const fieldsOf = (typeName: string) => {
  const t = schema.getType(typeName) as GraphQLObjectType | GraphQLInputObjectType | undefined
  if (!t) throw new Error(`${typeName} not in schema`)
  return Object.fromEntries(Object.entries(t.getFields()).map(([k, f]) => [k, f.type.toString()]))
}
const fieldType = (typeName: string, field: string) => {
  const t = schema.getType(typeName) as GraphQLObjectType | GraphQLInputObjectType
  const f = t.getFields()[field]
  if (!f) throw new Error(`${typeName}.${field} not in schema`)
  return f.type
}

describe('enum SDL ↔ liste TS (lib/serviceVocabularies.ts)', () => {
  it.each(Object.entries(SERVICE_SDL_ENUMS))('enum %s ha esattamente i valori della lista', (name, values) => {
    const t = schema.getType(name)
    expect(t, `enum ${name} assente dallo schema`).toBeDefined()
    expect(isEnumType(t!)).toBe(true)
    expect((t as GraphQLEnumType).getValues().map((v) => v.name)).toEqual([...values])
  })

  it('le liste sono quelle del contratto; l\'ordine di gravità copre ogni salute una volta', () => {
    expect(SERVICE_SDL_ENUMS['ServiceHealth']).toEqual(['operational', 'degraded', 'down', 'maintenance', 'unknown'])
    expect(SERVICE_SDL_ENUMS['ServiceMapStatus']).toEqual(['draft', 'active', 'paused'])
    expect(SERVICE_SDL_ENUMS['NodePropagation']).toEqual(['always', 'never', 'weighted'])
    expect(SERVICE_SDL_ENUMS['ServiceNodeRole']).toEqual(['entry', 'component', 'infrastructure', 'certificate'])
    expect(SERVICE_SDL_ENUMS['ServiceHealthTrigger']).toEqual(['created', 'ci_health', 'rules_changed', 'map_changed', 'maintenance', 'manual', 'periodic'])
    expect(SERVICE_SDL_ENUMS['UnknownNodesMode']).toEqual(['ignore', 'operational'])
    expect(SERVICE_SDL_ENUMS['ServiceOpenIncidentFrom']).toEqual(['never', 'down', 'degraded'])
    expect([...SERVICE_HEALTH_SEVERITY_ORDER].sort()).toEqual([...SERVICE_HEALTHS].sort())
  })
})

describe('tipi del contratto', () => {
  it('ServiceMap', () => {
    expect(fieldsOf('ServiceMap')).toEqual({
      id: 'ID!', service: 'ServiceRef!', name: 'String!', status: 'ServiceMapStatus!', version: 'Int!', updatedAt: 'String',
      maxDepth: 'Int!', relationshipTypes: '[String!]!', builtFrom: 'String!', stale: 'Boolean!',
      rules: 'ServiceImpactRules!',
      health: 'ServiceHealth!', healthSince: 'String', impactScore: 'Int!', evaluatedAt: 'String',
      explanation: '[ImpactCause!]!',
      nodes: '[ServiceMapNode!]!', nodeCount: 'Int!',
      edges: '[ServiceMapEdge!]!',
      history: '[ServiceHealthEntry!]!', historyCount: 'Int!',
      excluded: '[ConfigurationItemRef!]!',
      openIncident: 'Incident',
    })
    const history = (schema.getType('ServiceMap') as GraphQLObjectType).getFields()['history']!
    expect(history.args.map((a) => [a.name, a.type.toString(), a.defaultValue])).toEqual([['limit', 'Int', 100]])
  })

  it('ServiceMapNode, ImpactCause, ServiceMapEdge, ServiceHealthEntry, ServiceImpactRules, ServiceRef, ServiceMapCounts, ServiceMapPage, ServiceMapFilter', () => {
    expect(fieldsOf('ServiceMapNode')).toEqual({ ci: 'ConfigurationItemRef!', level: 'Int!', role: 'ServiceNodeRole!', propagate: 'NodePropagation!', weight: 'Int!', critical: 'Boolean!', via: 'ID', addedBy: 'String!', health: 'CIHealth', inMaintenance: 'Boolean!', contributes: 'Boolean!' })
    expect(fieldsOf('ImpactCause')).toEqual({ ci: 'ConfigurationItemRef!', health: 'CIHealth!', weight: 'Int!', critical: 'Boolean!', path: '[ConfigurationItemRef!]!' })
    expect(fieldsOf('ServiceMapEdge')).toEqual({ source: 'ID!', target: 'ID!', relType: 'String!' })
    expect(fieldsOf('ServiceHealthEntry')).toEqual({ id: 'ID!', at: 'String!', health: 'ServiceHealth!', previousHealth: 'ServiceHealth', impactScore: 'Int!', trigger: 'ServiceHealthTrigger!', causes: '[ImpactCause!]!', note: 'String' })
    expect(fieldsOf('ServiceImpactRules')).toEqual({ version: 'Int!', downSharePct: 'Int!', degradedSharePct: 'Int!', minNodes: 'Int!', unknownNodes: 'UnknownNodesMode!', openIncidentFrom: 'ServiceOpenIncidentFrom!' })
    expect(fieldsOf('ServiceRef')).toEqual({ id: 'ID!', name: 'String!', criticality: 'String', ownerGroup: 'Team' })
    expect(fieldsOf('ServiceMapCounts')).toEqual({ total: 'Int!', operational: 'Int!', degraded: 'Int!', down: 'Int!', maintenance: 'Int!', unknown: 'Int!' })
    expect(fieldsOf('ServiceMapPage')).toEqual({ items: '[ServiceMap!]!', total: 'Int!', counts: 'ServiceMapCounts!' })
    expect(fieldsOf('ServiceMapFilter')).toEqual({ health: '[ServiceHealth!]', status: 'ServiceMapStatus', search: 'String' })
    // riusa i tipi dell'Event Management e dei team
    expect((unwrap(fieldType('ImpactCause', 'ci')) as GraphQLObjectType).name).toBe('ConfigurationItemRef')
    expect((unwrap(fieldType('ServiceMapNode', 'health')) as GraphQLEnumType).name).toBe('CIHealth')
    expect((unwrap(fieldType('ServiceRef', 'ownerGroup')) as GraphQLObjectType).name).toBe('Team')
  })

  it('campi root con argomenti e default del contratto', () => {
    const q = (schema.getType('Query') as GraphQLObjectType).getFields()
    const m = (schema.getType('Mutation') as GraphQLObjectType).getFields()
    const sig = (f: { args: readonly { name: string; type: GraphQLType; defaultValue?: unknown }[]; type: GraphQLType }) => ({ args: f.args.map((a) => [a.name, a.type.toString(), a.defaultValue ?? null]), type: f.type.toString() })
    expect(sig(q['serviceMaps']!)).toEqual({ args: [['filter', 'ServiceMapFilter', null], ['limit', 'Int', 50], ['offset', 'Int', 0]], type: 'ServiceMapPage!' })
    expect(sig(q['serviceMap']!)).toEqual({ args: [['id', 'ID!', null]], type: 'ServiceMap' })
    expect(sig(q['servicesImpactedByCI']!)).toEqual({ args: [['ciId', 'ID!', null]], type: '[ServiceMap!]!' })
    expect(sig(q['serviceMapCandidates']!)).toEqual({ args: [['search', 'String', null], ['limit', 'Int', 20]], type: '[ServiceRef!]!' })
    expect(sig(q['serviceMapProposal']!)).toEqual({ args: [['id', 'ID!', null]], type: 'ServiceMapProposal!' })
    expect(sig(q['serviceImpactPreview']!)).toEqual({ args: [['id', 'ID!', null], ['rules', 'ServiceImpactRulesInput', null], ['nodes', '[ServiceMapNodeInput!]', null]], type: 'ServiceImpactPreview!' })
    expect(sig(q['businessCapabilitiesHealth']!)).toEqual({ args: [], type: '[BusinessCapabilityHealth!]!' })
    expect(sig(m['createServiceMap']!)).toEqual({ args: [['serviceId', 'ID!', null], ['maxDepth', 'Int', null], ['relationshipTypes', '[String!]', null], ['status', 'ServiceMapStatus', null]], type: 'ServiceMap!' })
    expect(sig(m['reevaluateServiceMap']!)).toEqual({ args: [['id', 'ID!', null]], type: 'ServiceMap!' })
    expect(sig(m['setServiceMapStatus']!)).toEqual({ args: [['id', 'ID!', null], ['expectedVersion', 'Int!', null], ['status', 'ServiceMapStatus!', null]], type: 'ServiceMap!' })
    expect(sig(m['updateServiceImpactRules']!)).toEqual({ args: [['id', 'ID!', null], ['expectedVersion', 'Int!', null], ['rules', 'ServiceImpactRulesInput!', null]], type: 'ServiceMap!' })
    expect(sig(m['updateServiceMapNodes']!)).toEqual({ args: [['id', 'ID!', null], ['expectedVersion', 'Int!', null], ['nodes', '[ServiceMapNodeInput!]!', null]], type: 'ServiceMap!' })
    expect(sig(m['applyServiceMapProposal']!)).toEqual({ args: [['id', 'ID!', null], ['expectedVersion', 'Int!', null], ['add', '[ID!]!', null], ['exclude', '[ID!]!', null], ['remove', '[ID!]!', null]], type: 'ServiceMap!' })
    expect(sig(m['removeServiceMapExclusion']!)).toEqual({ args: [['id', 'ID!', null], ['expectedVersion', 'Int!', null], ['ciId', 'ID!', null]], type: 'ServiceMap!' })
    expect(sig(m['deleteServiceMap']!)).toEqual({ args: [['id', 'ID!', null]], type: 'Boolean!' })
  })

  it('tipi e input dell\'ondata 2 (configurazione da interfaccia)', () => {
    expect(fieldsOf('ServiceImpactRulesInput')).toEqual({ downSharePct: 'Int!', degradedSharePct: 'Int!', minNodes: 'Int!', unknownNodes: 'UnknownNodesMode!', openIncidentFrom: 'ServiceOpenIncidentFrom!' })
    expect(fieldsOf('ServiceMapNodeInput')).toEqual({ ciId: 'ID!', propagate: 'NodePropagation!', weight: 'Int!', critical: 'Boolean!' })
    expect(fieldsOf('ServiceMapProposalNode')).toEqual({ ci: 'ConfigurationItemRef!', level: 'Int!', role: 'ServiceNodeRole!', propagate: 'NodePropagation!', weight: 'Int!', critical: 'Boolean!', via: 'ID' })
    expect(fieldsOf('ServiceMapMovedNode')).toEqual({ ci: 'ConfigurationItemRef!', level: 'Int!', proposedLevel: 'Int!', via: 'ID', proposedVia: 'ID' })
    expect(fieldsOf('ServiceMapProposal')).toEqual({
      mapId: 'ID!', version: 'Int!', maxDepth: 'Int!', relationshipTypes: '[String!]!',
      added: '[ServiceMapProposalNode!]!', removed: '[ServiceMapNode!]!', moved: '[ServiceMapMovedNode!]!',
      excluded: '[ConfigurationItemRef!]!', totalProposed: 'Int!',
    })
    expect(fieldsOf('ServiceImpactPreview')).toEqual({ health: 'ServiceHealth!', impactScore: 'Int!', causes: '[ImpactCause!]!', contributingCount: 'Int!', nodeCount: 'Int!' })
  })

  it('ondata 3: incident del servizio e capacità di business', () => {
    // ServiceMap.openIncident e Incident.impactedServices riusano i tipi esistenti
    // (Incident dello SDL base, ServiceMap di questo modulo): nessun tipo parallelo.
    expect((unwrap(fieldType('ServiceMap', 'openIncident')) as GraphQLObjectType).name).toBe('Incident')
    expect(fieldType('Incident', 'impactedServices').toString()).toBe('[ServiceMap!]!')
    expect(fieldsOf('BusinessCapabilityHealth')).toEqual({
      id: 'ID!', name: 'String!', health: 'ServiceHealth!', services: '[ServiceRef!]!', downServices: 'Int!', degradedServices: 'Int!',
    })
    expect((unwrap(fieldType('BusinessCapabilityHealth', 'services')) as GraphQLObjectType).name).toBe('ServiceRef')
  })

  it('le descrizioni SDL non replicano i ruoli: la policy è in lib/authorization.ts', () => {
    const sdl = servicesSDL()
    expect(sdl).not.toMatch(/\(admin\/operator\)/)
    expect(sdl).not.toMatch(/admin-only/i)
    expect(sdl).not.toMatch(/\bstaff\b/)
  })
})
