/**
 * La porta sui nomi del metamodello (A-12), contro lo schema di base VERO.
 *
 * Qui si dimostrano tre cose:
 * 1. l'elenco riservato è **calcolato** da `buildBaseSDL()` — non una lista
 *    scritta a mano che divergerebbe al primo tipo nuovo aggiunto allo schema;
 * 2. **la correzione al rapporto A-12**: due tipi GraphQL con lo stesso nome
 *    non fanno lanciare `makeExecutableSchema` — vengono FUSI in silenzio, e i
 *    campi del tipo del cliente entrano nel tipo del prodotto. Non c'è nessuna
 *    rete a valle: la validazione in scrittura è l'unica difesa;
 * 3. l'SDL generato per un tipo con un nome accettato si assembla davvero
 *    insieme a quello di base.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { makeExecutableSchema } from '@graphql-tools/schema'
import { generateSDL, MetamodelNameError, type CITypeWithDefinitions, type CIFieldDefinition } from '@opengraphity/schema-generator'
import {
  reservedNamesFromSDL, reservedNamesOfBaseSchema, resetBaseSchemaNamesCache,
  assertNewCITypeName, assertNewCIFieldName, type ExistingCIType,
} from '../metamodelNames.js'
import { buildBaseSDL } from '../../graphql/schema-base.js'
import { ValidationError } from '../errors.js'

/** I tipi CI del grafo dal vivo (`t.scope` + `t.name`, verificato 12 set 2026). */
const EXISTING: ExistingCIType[] = [
  ...['__base__', 'application', 'business_application', 'business_capability',
    'certificate', 'database', 'database_instance', 'dynamic_ci_group', 'server']
    .map((name) => ({ name, scope: 'base' })),
  ...['change', 'incident', 'problem', 'service_request'].map((name) => ({ name, scope: 'itil' })),
]

beforeEach(() => resetBaseSchemaNamesCache())

// ── L'elenco riservato si LEGGE dallo schema ──────────────────────────────────

describe('reservedNamesFromSDL — calcolato, non scritto a mano', () => {
  it('legge i tipi, le query e le mutation dichiarati', () => {
    const r = reservedNamesFromSDL(`
      type Query { pippo(id: ID!): Pluto }
      type Mutation { creaPluto: Pluto! }
      type Pluto { id: ID! }
      input PlutoInput { id: ID }
      enum Colore { ROSSO }
      interface Cosa { id: ID! }
      extend type Query { altro: Pluto }
    `)
    expect([...r.types.keys()]).toEqual(expect.arrayContaining(['pluto', 'plutoinput', 'colore', 'cosa', 'query', 'mutation']))
    expect([...r.queryFields.keys()]).toEqual(expect.arrayContaining(['pippo', 'altro']))
    expect([...r.mutationFields.keys()]).toEqual(expect.arrayContaining(['creapluto']))
  })

  it('un SDL illeggibile ferma tutto: un elenco riservato incompleto lascerebbe passare una collisione', () => {
    expect(() => reservedNamesFromSDL('type { nope')).toThrow(/SDL non analizzabile/)
  })

  it('sullo schema di base vero trova i tipi e le query del prodotto', () => {
    const r = reservedNamesOfBaseSchema()
    for (const t of ['incident', 'change', 'problem', 'team', 'user', 'event', 'cibase', 'citypedefinition']) {
      expect(r.types.has(t), `tipo ${t}`).toBe(true)
    }
    for (const q of ['incidents', 'incident', 'teams', 'users']) {
      expect(r.queryFields.has(q), `query ${q}`).toBe(true)
    }
    // La parte statica del metamodello è compresa: `createCIType` è una
    // mutation già presa.
    expect(r.mutationFields.has('createcitype')).toBe(true)
  })
})

// ── La porta ──────────────────────────────────────────────────────────────────

describe('assertNewCITypeName — contro lo schema di base vero', () => {
  it.each([
    // `server` e `application` non compaiono nell'SDL di base (i tipi CI sono
    // generati): li prende l'altra metà dell'elenco, quella dei tipi CI.
    ['server',      'un tipo CI spedito col prodotto'],
    ['application', 'un tipo CI spedito col prodotto'],
    // `incident` e `change` sono ANCHE tipi dell'SDL di base, e lì la
    // collisione si vede prima.
    ['incident',    'è un tipo dello schema di base'],
    ['change',      'è un tipo dello schema di base'],
  ])('rifiuta «%s»: %s', (name, origin) => {
    const err = (() => { try { assertNewCITypeName(name, EXISTING); return null } catch (e) { return e } })()
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as Error).message).toContain(origin)
  })

  it.each(['team', 'user', 'event', 'dashboard'])(
    'rifiuta «%s»: è un tipo dello schema di base, anche se non è un tipo CI', (name) => {
      expect(() => assertNewCITypeName(name, EXISTING)).toThrow(ValidationError)
    })

  it('«report» invece passa: `Report` non esiste (ci sono ReportTemplate, ReportResult…)', () => {
    // La prova che l'elenco è CALCOLATO e non indovinato: non rifiuta un nome
    // che somiglia a qualcosa di preso ma non lo è — e l'SDL si assembla.
    expect(assertNewCITypeName('report', EXISTING)).toBe('report')
  })

  it('rifiuta un nome già usato da un tipo del CLIENTE', () => {
    const withOwn = [...EXISTING, { name: 'load_balancer', scope: 'tenant' }]
    const err = (() => { try { assertNewCITypeName('load_balancer', withOwn); return null } catch (e) { return e } })()
    expect((err as Error).message).toContain('un tuo tipo CI')
  })

  it.each(['2fa_token', 'my-type', 'Load Balancer', ''])('rifiuta «%s»: non è un identificatore', (name) => {
    expect(() => assertNewCITypeName(name, EXISTING)).toThrow(ValidationError)
  })

  it.each(['load_balancer', 'firewall', 'nas', 'server_edge'])('accetta «%s»', (name) => {
    expect(assertNewCITypeName(name, EXISTING)).toBe(name)
  })

  it('il rifiuto dice cosa scrivere invece, non solo che è sbagliato', () => {
    const err = (() => { try { assertNewCITypeName('server', EXISTING); return null } catch (e) { return e as Error } })()!
    expect(err.message).toContain('«server_custom»')
    expect(err.message).toContain('label')
  })
})

describe('assertNewCIFieldName — il caso tenantId', () => {
  it('tenantId è rifiutato come ValidationError, con il perché', () => {
    const err = (() => { try { assertNewCIFieldName('tenantId', { typeLabel: 'Load Balancer' }); return null } catch (e) { return e as Error } })()!
    expect(err).toBeInstanceOf(ValidationError)
    expect(err.message).toContain('tenant_id')
    expect(err.message).toContain('il CI nascerebbe nel cliente scelto dal chiamante')
  })

  it('accetta un nome camelCase libero', () => {
    expect(assertNewCIFieldName('costCenter', { existingFieldNames: ['os'] })).toBe('costCenter')
  })
})

// ── La correzione: il merge è SILENZIOSO ──────────────────────────────────────

describe('due tipi GraphQL omonimi: @graphql-tools li FONDE, non lancia', () => {
  it('i campi del secondo tipo entrano nel primo, senza nessun errore', () => {
    // È la ragione d'esistere della porta: se questo test cominciasse a
    // lanciare, la validazione in scrittura avrebbe una rete; finché passa,
    // non ce l'ha.
    const schema = makeExecutableSchema({
      typeDefs: [
        'type Query { incident(id: ID!): Incident }\ntype Incident { id: ID!\n title: String! }',
        'type Incident { campoDelCliente: String }',
      ],
    })
    const fields = Object.keys((schema.getType('Incident') as { getFields(): Record<string, unknown> }).getFields())
    expect(fields).toEqual(expect.arrayContaining(['id', 'title', 'campoDelCliente']))
  })

  it('una query omonima con tipo diverso, invece, lancia', () => {
    expect(() => makeExecutableSchema({
      typeDefs: [
        'type Query { incidents: String }\ntype Incident { id: ID! }',
        'extend type Query { incidents: Incident }',
      ],
    })).toThrow(/Unable to merge GraphQL type "Query"/)
  })

  it('un nome non identificatore lancia con un errore di sintassi che non dice di chi è la colpa', () => {
    expect(() => makeExecutableSchema({ typeDefs: ['type Query { a: String }', 'type 2fa { id: ID! }'] }))
      .toThrow(/Syntax Error/)
  })
})

// ── L'SDL generato si assembla ────────────────────────────────────────────────

const field = (over: Partial<CIFieldDefinition>): CIFieldDefinition => ({
  id: 'f', name: 'x', label: 'X', fieldType: 'string', required: false,
  defaultValue: null, enumValues: [], order: 0, scope: 'tenant', tenantId: 'c-two',
  validationScript: null, visibilityScript: null, defaultScript: null, isSystem: false,
  ...over,
})
const ciType = (over: Partial<CITypeWithDefinitions>): CITypeWithDefinitions => ({
  id: 't', name: 'load_balancer', label: 'Load Balancer', icon: 'box', color: '#000',
  scope: 'tenant', tenantId: 'c-two', active: true, neo4jLabel: 'LoadBalancer',
  validationScript: null, fields: [], relations: [], systemRelations: [],
  ...over,
})

/** Come lo assembla `schemaCache`, ma senza resolver (qui conta solo l'SDL). */
const assemble = (types: CITypeWithDefinitions[]) =>
  makeExecutableSchema({ typeDefs: [buildBaseSDL(), generateSDL(types)] })

describe('l\'SDL dei tipi del cliente si assembla con quello di base', () => {
  it('un nome accettato dalla porta produce uno schema valido', () => {
    const name = assertNewCITypeName('load_balancer', EXISTING)
    const schema = assemble([ciType({ name, fields: [field({ name: 'costCenter' })] })])
    expect(schema.getType('LoadBalancer')).toBeDefined()
    expect(schema.getQueryType()!.getFields()['loadBalancers']).toBeDefined()
    expect(schema.getMutationType()!.getFields()['createLoadBalancer']).toBeDefined()
    const inputFields = Object.keys((schema.getType('CreateLoadBalancerInput') as { getFields(): Record<string, unknown> }).getFields())
    expect(inputFields).toContain('costCenter')
    expect(inputFields).not.toContain('tenantId')
  })

  it('zero tipi del cliente: lo schema «sicuro» si assembla, con createCIType dentro', () => {
    const schema = assemble([])
    expect(schema.getMutationType()!.getFields()['createCIType']).toBeDefined()
  })

  it('tutti i tipi spediti col prodotto insieme: nessuna collisione fra loro', () => {
    const types = EXISTING.filter((t) => t.scope === 'base' && t.name !== '__base__')
      .map((t, i) => ciType({ id: `t${i}`, name: t.name, scope: 'base', tenantId: 'system' }))
    expect(() => assemble(types)).not.toThrow()
  })

  it('un tipo con un nome riservato non arriva all\'assemblaggio: lo ferma il generatore', () => {
    expect(() => assemble([
      ciType({ id: 'b', name: 'server', scope: 'base', tenantId: 'system' }),
      ciType({ id: 't', name: 'server', label: 'Server del reparto' }),
    ])).toThrow(MetamodelNameError)
  })
})
