/**
 * B0-1: la parte statica dello schema del metamodello è ora una sorgente sola
 * (`metamodelSDL()` in @opengraphity/schema-generator) usata sia dallo schema
 * per tenant (`generateSDL`) sia dal test di contratto API ↔ web. Qui si pinna
 * che le due restino la stessa cosa, che l'SDL generato si parsi e che
 * `chainFamilies` sia dichiarato in ENTRAMBI gli input dei tipi CI — la sua
 * assenza da `UpdateCITypeInput` faceva rifiutare da Apollo ogni «Salva
 * impostazioni» del disegnatore.
 */
import { describe, it, expect } from 'vitest'
import { parse } from 'graphql'
import { generateSDL, metamodelSDL } from '@opengraphity/schema-generator'
import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'

const server: CITypeWithDefinitions = {
  id: 't1', name: 'server', label: 'Server', icon: 'server', color: '#000', scope: 'tenant',
  tenantId: 'c-one', active: true, neo4jLabel: 'Server', validationScript: null,
  chainFamilies: ['Infrastructure'],
  fields: [{
    id: 'f1', name: 'cpu', label: 'CPU', fieldType: 'number', required: false, defaultValue: null,
    enumValues: [], order: 1, scope: 'tenant', tenantId: 'c-one',
    validationScript: null, visibilityScript: null, defaultScript: null, isSystem: false,
  }],
  relations: [], systemRelations: [],
}

describe('SDL del metamodello', () => {
  it('generateSDL produce SDL valido e contiene la parte statica del metamodello', () => {
    const sdl = generateSDL([server])
    expect(() => parse(sdl)).not.toThrow()
    expect(sdl).toContain('createCIType(input: CreateCITypeInput!)')
    expect(sdl).toContain('input UpdateCITypeInput')
  })

  it('metamodelSDL() si parsa da solo (è quello che il test di contratto concatena)', () => {
    expect(() => parse(metamodelSDL())).not.toThrow()
  })

  it('chainFamilies è dichiarato in CreateCITypeInput e UpdateCITypeInput', () => {
    for (const input of ['CreateCITypeInput', 'UpdateCITypeInput']) {
      const block = new RegExp(`input ${input} \\{[\\s\\S]*?\\n\\}`).exec(metamodelSDL())
      expect(block, input).not.toBeNull()
      expect(block![0]).toContain('chainFamilies: [String!]')
    }
  })
})
