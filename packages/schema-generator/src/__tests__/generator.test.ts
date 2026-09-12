/**
 * `generateSDL` — il pacchetto non aveva NESSUN test (A-12, osservazione (b)1
 * della verifica). Questi pinnano la forma dell'SDL generato e i casi limite
 * che facevano fallire l'assemblaggio dello schema.
 *
 * La prova che l'SDL è davvero accettato da `makeExecutableSchema` vive in
 * `apps/api/src/lib/__tests__/metamodelNames.test.ts`: là ci sono `graphql` e
 * `@graphql-tools/schema`, e soprattutto c'è l'SDL di base VERO — che è
 * l'unico contro cui la validazione dei nomi ha senso.
 */
import { describe, it, expect } from 'vitest'
import { generateSDL, metamodelSDL, generateITILEnumsSDL, METAMODEL_MUTATION_FIELDS } from '../generator.js'
import { MetamodelNameError } from '../nameValidation.js'
import type { CITypeWithDefinitions, CIFieldDefinition } from '../types.js'

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

describe('generateSDL — un tipo del cliente', () => {
  const sdl = generateSDL([ciType({
    fields: [
      field({ id: 'f1', name: 'costCenter', label: 'Centro di costo' }),
      field({ id: 'f2', name: 'porte', fieldType: 'number', required: true }),
      field({ id: 'f3', name: 'status' }),                     // campo base: filtrato
      field({ id: 'f4', name: 'created_at', isSystem: true }),  // di sistema: filtrato
    ],
  })])

  it('emette il tipo concreto che implementa CIBase, con i campi specifici', () => {
    expect(sdl).toContain('type LoadBalancer implements CIBase {')
    expect(sdl).toContain('  costCenter: String')
    expect(sdl).toContain('  porte: Float!')
  })

  it('non ri-emette i campi base né quelli di sistema', () => {
    const concrete = sdl.slice(sdl.indexOf('type LoadBalancer implements CIBase'), sdl.indexOf('type LoadBalancersResult'))
    expect(concrete.match(/^\s+status: String$/gm)).toHaveLength(1)   // quello di CIBase, non il doppione
    expect(sdl).not.toContain('created_at')
  })

  it('emette il risultato paginato, le query, le mutation e i due input', () => {
    expect(sdl).toContain('type LoadBalancersResult {')
    expect(sdl).toContain('  loadBalancers(limit: Int')
    expect(sdl).toContain('  load_balancer(id: ID!): LoadBalancer')
    expect(sdl).toContain('  createLoadBalancer(input: CreateLoadBalancerInput!): LoadBalancer!')
    expect(sdl).toContain('  updateLoadBalancer(id: ID!, input: UpdateLoadBalancerInput!): LoadBalancer!')
    expect(sdl).toContain('  deleteLoadBalancer(id: ID!): Boolean!')
    expect(sdl).toContain('input CreateLoadBalancerInput {')
    expect(sdl).toContain('input UpdateLoadBalancerInput {')
  })

  it('porta con sé la parte statica del metamodello', () => {
    expect(sdl).toContain(METAMODEL_MUTATION_FIELDS.trim().split('\n')[1]!.trim())
    expect(sdl).toContain('input CreateCITypeInput {')
  })
})

describe('generateSDL — casi limite', () => {
  it('zero tipi: NON emette `extend type Query { }` col corpo vuoto', () => {
    // `extend type Query { }` non è SDL valido: «Syntax Error: Expected Name,
    // found "}"». Ci finiva chi chiama il generatore senza tipi — per esempio
    // lo schema «sicuro» servito quando quello del cliente non si assembla,
    // che scarta i tipi del cliente e può restare con zero.
    const sdl = generateSDL([])
    expect(sdl).not.toMatch(/extend type Query \{\s*\}/)
    expect(sdl).not.toContain('extend type Query')
  })

  it('zero tipi: restituisce la parte statica del metamodello, non stringa vuota', () => {
    // Stringa vuota toglierebbe `createCIType` dallo schema: un cliente senza
    // tipi CI non avrebbe più la mutation per crearne uno.
    const sdl = generateSDL([])
    expect(sdl).toContain('createCIType(input: CreateCITypeInput!): CITypeDefinition!')
    expect(sdl).toContain('input CreateCITypeInput {')
    expect(sdl.trim()).not.toBe('')
  })

  it('un tipo con zero campi specifici: l\'SDL resta ben formato', () => {
    const sdl = generateSDL([ciType({ fields: [] })])
    expect(sdl).toContain('type LoadBalancer implements CIBase {')
    expect(sdl).not.toMatch(/\{\s*\}/)
  })

  it('un fieldType sconosciuto ferma la generazione nominandolo', () => {
    expect(() => generateSDL([ciType({ fields: [field({ fieldType: 'json' as CIFieldDefinition['fieldType'] })] })]))
      .toThrow(/unknown fieldType "json"/)
  })

  it('enum → String: gli stati vengono dai workflow, non da un enum fisso', () => {
    const sdl = generateSDL([ciType({ fields: [field({ name: 'ambiente', fieldType: 'enum', enumValues: ['a', 'b'] })] })])
    expect(sdl).toContain('  ambiente: String')
    expect(generateITILEnumsSDL([])).toBe('')
  })
})

describe('generateSDL — la rete sui nomi (A-12)', () => {
  it('due tipi omonimi (uno base, uno del cliente): ferma la generazione', () => {
    expect(() => generateSDL([
      ciType({ id: 'b', name: 'server', label: 'Server', scope: 'base', tenantId: 'system' }),
      ciType({ id: 't', name: 'server', label: 'Server del reparto' }),
    ])).toThrow(MetamodelNameError)
  })

  it('un nome non identificatore: ferma la generazione PRIMA di interpolarlo', () => {
    // Senza questo, l'SDL conterrebbe `type 2fa implements CIBase` e
    // l'errore arriverebbe da dentro makeExecutableSchema.
    const err = (() => { try { generateSDL([ciType({ name: '2fa' })]); return null } catch (e) { return e } })()
    expect(err).toBeInstanceOf(MetamodelNameError)
    expect((err as MetamodelNameError).message).toContain('2fa')
  })

  it('un campo `tenantId`: ferma la generazione', () => {
    expect(() => generateSDL([ciType({ fields: [field({ name: 'tenantId' })] })])).toThrow(MetamodelNameError)
  })
})

describe('metamodelSDL', () => {
  it('è la parte statica, senza nessun tipo CI', () => {
    const sdl = metamodelSDL()
    expect(sdl).toContain('extend type Mutation {')
    expect(sdl).toContain('createCIType(input: CreateCITypeInput!): CITypeDefinition!')
    expect(sdl).not.toContain('implements CIBase')
  })
})
