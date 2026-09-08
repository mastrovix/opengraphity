import { describe, it, expect } from 'vitest'
import { buildSchema } from 'graphql'
import { buildBaseSDL } from '../../schema-base.js'
import { entityFilterFieldsFromSchema } from '../entityFilterFields.js'

const schema = buildSchema(buildBaseSDL())

describe('entityFilterFields (sostituto dell\'introspezione per il FilterBuilder)', () => {
  it('Incident: scalari ed enum inclusi, liste e oggetti esclusi', () => {
    const fields = entityFilterFieldsFromSchema(schema, 'Incident')
    const byName = new Map(fields.map((f) => [f.name, f]))
    expect(byName.get('title')).toEqual({ name: 'title', kind: 'SCALAR', scalarName: 'String', enumValues: null })
    expect(byName.get('createdAt')?.kind).toBe('SCALAR')
    expect(byName.has('affectedCIs')).toBe(false)   // lista
    expect(byName.has('assignee')).toBe(false)      // oggetto
    expect(fields.every((f) => f.kind === 'SCALAR' || f.kind === 'ENUM')).toBe(true)
  })

  it('tipi interni o inesistenti → ValidationError', () => {
    expect(() => entityFilterFieldsFromSchema(schema, '__Schema')).toThrow(/typeName non valido/)
    expect(() => entityFilterFieldsFromSchema(schema, 'NonEsiste')).toThrow(/inesistente/)
    expect(() => entityFilterFieldsFromSchema(schema, 'String')).toThrow(/non filtrabile/)
  })
})
