/**
 * Contratto dell'Event Management (C-1, C-2, C-4 della revisione): gli enum
 * SDL sono generati da lib/eventVocabularies.ts e devono coincidere con le
 * liste TS che i servizi usano davvero (un valore nuovo scritto dalla pipeline
 * senza enum sarebbe un errore di serializzazione a runtime); i campi che
 * prima erano `String` con un vocabolario nel commento sono ora enum;
 * `Event.source` è MonitoringSourceRef, `labels` non-null, la policy porta
 * version/updatedAt e l'input expectedVersion.
 */
import { describe, it, expect } from 'vitest'
import { buildSchema, isEnumType, isNonNullType, isListType, type GraphQLObjectType, type GraphQLInputObjectType, type GraphQLType } from 'graphql'
import { buildBaseSDL } from '../schema-base.js'
import { eventsSDL } from '../schema-events.js'
import { EVENT_SDL_ENUMS, CI_HEALTHS } from '../../lib/eventVocabularies.js'
import { OPEN_INCIDENT_FROM as openFromPolicy, GROUP_BY as groupByFromPolicy } from '../../lib/eventPolicy.js'

const schema = buildSchema(buildBaseSDL())

function unwrap(t: GraphQLType): GraphQLType {
  let cur = t
  while (isNonNullType(cur) || isListType(cur)) cur = cur.ofType
  return cur
}
const fieldType = (typeName: string, field: string) => {
  const t = schema.getType(typeName) as GraphQLObjectType | GraphQLInputObjectType
  const f = t.getFields()[field]
  if (!f) throw new Error(`${typeName}.${field} not in schema`)
  return f.type
}
const enumName = (typeName: string, field: string) => {
  const t = unwrap(fieldType(typeName, field))
  return isEnumType(t) ? t.name : null
}

describe('enum SDL ↔ liste TS (lib/eventVocabularies.ts)', () => {
  it.each(Object.entries(EVENT_SDL_ENUMS))('enum %s ha esattamente i valori della lista', (name, values) => {
    const t = schema.getType(name)
    expect(t, `enum ${name} assente dallo schema`).toBeDefined()
    expect(isEnumType(t!)).toBe(true)
    expect((t as import('graphql').GraphQLEnumType).getValues().map((v) => v.name)).toEqual([...values])
  })

  it('lib/eventPolicy.ts usa le stesse liste (ri-esportate, non copiate); i servizi le ri-esportano allo stesso modo (verificato in events.test.ts, che li importa con i mock)', () => {
    expect(openFromPolicy).toBe(EVENT_SDL_ENUMS['OpenIncidentFrom'])
    expect(groupByFromPolicy).toBe(EVENT_SDL_ENUMS['EventGroupBy'])
    expect(CI_HEALTHS).toEqual(['operational', 'degraded', 'down'])
  })
})

describe('campi a vocabolario chiuso sono enum (C-1)', () => {
  it.each([
    ['Event', 'resourceKind', 'ResourceKind'],
    ['Event', 'correlation', 'EventCorrelation'],
    ['ConfigurationItemRef', 'health', 'CIHealth'],
    ['CIAlias', 'source', 'CIAliasSource'],
    ['EventPolicy', 'openIncidentFrom', 'OpenIncidentFrom'],
    ['EventPolicy', 'groupBy', 'EventGroupBy'],
    ['EventPolicyInput', 'openIncidentFrom', 'OpenIncidentFrom'],
    ['EventPolicyInput', 'groupBy', 'EventGroupBy'],
    ['NormalizedEventPreview', 'status', 'EventInputStatus'],
    ['NormalizedEventPreview', 'severity', 'EventSeverity'],
    ['NormalizedEventPreview', 'resourceKind', 'ResourceKind'],
    ['InboundEventPreviewInput', 'connectorKind', 'ConnectorKind'],
    ['MonitoringSourceRef', 'connectorKind', 'ConnectorKind'],
    ['CIHealthInfo', 'health', 'CIHealth'],
    ['CIHealthInfo', 'healthSource', 'HealthSource'],
    ['CIHealthRow', 'health', 'CIHealth'],
    ['CIHealthRow', 'healthSource', 'HealthSource'],
    ['CIHealthFilter', 'health', 'CIHealth'],
    // cronologia dell'allarme
    ['EventHistoryEntry', 'kind', 'EventHistoryKind'],
    ['EventHistoryEntry', 'outcome', 'EventCorrelation'],
    ['EventHistoryEntry', 'severity', 'EventSeverity'],
  ])('%s.%s: %s', (type, field, expected) => {
    expect(enumName(type, field)).toBe(expected)
  })

  it('argomenti: sampleInboundPayload(connectorKind: ConnectorKind!), setCIHealthOverride(health: CIHealth)', () => {
    const q = (schema.getType('Query') as GraphQLObjectType).getFields()
    const m = (schema.getType('Mutation') as GraphQLObjectType).getFields()
    const arg = (f: { args: readonly { name: string; type: GraphQLType }[] }, name: string) => unwrap(f.args.find((a) => a.name === name)!.type)
    expect((arg(q['sampleInboundPayload']!, 'connectorKind') as import('graphql').GraphQLEnumType).name).toBe('ConnectorKind')
    expect(isNonNullType(q['sampleInboundPayload']!.args.find((a) => a.name === 'connectorKind')!.type)).toBe(true)
    expect((arg(m['setCIHealthOverride']!, 'health') as import('graphql').GraphQLEnumType).name).toBe('CIHealth')
    expect(isNonNullType(m['setCIHealthOverride']!.args.find((a) => a.name === 'health')!.type)).toBe(false)   // null = toglie la forzatura
  })
})

describe('contratto (A-2, C-2, C-4)', () => {
  it('Event.source è MonitoringSourceRef {id name connectorKind enabled}: la configurazione (mappature, script, lastError) non è raggiungibile dalla console', () => {
    const t = unwrap(fieldType('Event', 'source')) as GraphQLObjectType
    expect(t.name).toBe('MonitoringSourceRef')
    expect(Object.keys(t.getFields()).sort()).toEqual(['connectorKind', 'enabled', 'id', 'name'])
    expect(unwrap(fieldType('Query', 'monitoringSourceRefs'))).toBe(t)
    expect((unwrap(fieldType('Query', 'monitoringSources')) as GraphQLObjectType).name).toBe('InboundWebhook')
  })

  it('Event.labels e NormalizedEventPreview.labels sono String! (l\'ingest scrive sempre labels)', () => {
    expect(isNonNullType(fieldType('Event', 'labels'))).toBe(true)
    expect(isNonNullType(fieldType('NormalizedEventPreview', 'labels'))).toBe(true)
  })

  it('EventPolicy.version: Int! e updatedAt: String; EventPolicyInput.expectedVersion: Int (opzionale)', () => {
    expect(fieldType('EventPolicy', 'version').toString()).toBe('Int!')
    expect(fieldType('EventPolicy', 'updatedAt').toString()).toBe('String')
    expect(fieldType('EventPolicyInput', 'expectedVersion').toString()).toBe('Int')
  })

  it('cronologia dell\'allarme: Event.history(limit: Int = 100): [EventHistoryEntry!]!, Event.historyCount: Int!, voce con id/at/kind/actorId non-null e actor/incident/change/ci come riferimenti', () => {
    const history = (schema.getType('Event') as GraphQLObjectType).getFields()['history']!
    expect(history.type.toString()).toBe('[EventHistoryEntry!]!')
    expect(history.args.map((a) => [a.name, a.type.toString(), a.defaultValue])).toEqual([['limit', 'Int', 100]])
    expect(fieldType('Event', 'historyCount').toString()).toBe('Int!')
    const entry = schema.getType('EventHistoryEntry') as GraphQLObjectType
    expect(Object.fromEntries(Object.entries(entry.getFields()).map(([k, f]) => [k, f.type.toString()]))).toEqual({
      id: 'ID!', at: 'String!', kind: 'EventHistoryKind!', outcome: 'EventCorrelation', actorId: 'String!',
      actor: 'User', incident: 'Incident', change: 'Change', ci: 'ConfigurationItemRef', severity: 'EventSeverity', note: 'String',
    })
  })

  it('le descrizioni SDL non replicano i ruoli (C-6): la policy è in lib/authorization.ts', () => {
    const sdl = eventsSDL()
    expect(sdl).not.toMatch(/\(admin\/operator\)/)
    expect(sdl).not.toMatch(/admin-only/i)
  })
})
