/**
 * Campi filtrabili di un tipo GraphQL, calcolati lato server dallo schema
 * eseguibile (`info.schema`).
 *
 * Il FilterBuilder del web li otteneva con una query di introspezione
 * (`__type(name)`), che in produzione è disattivata: qui esponiamo la sola
 * informazione che serve (nome, kind, scalare, valori enum) senza riaprire
 * l'introspezione. Liste e oggetti (relazioni) sono esclusi: non sono
 * filtrabili come scalari. I tipi interni (`__*`) e i non-object sono
 * rifiutati con errore.
 */
import { GraphQLObjectType, getNamedType, isEnumType, isListType, isNonNullType, isScalarType, type GraphQLResolveInfo, type GraphQLOutputType } from 'graphql'
import { ValidationError } from '../../lib/errors.js'

export interface EntityFilterField {
  name:       string
  kind:       'SCALAR' | 'ENUM'
  scalarName: string | null
  enumValues: string[] | null
}

function classify(type: GraphQLOutputType): EntityFilterField | null {
  const inner = isNonNullType(type) ? type.ofType : type
  if (isListType(inner)) return null                       // liste = relazioni/array
  const named = getNamedType(inner)
  if (isScalarType(named)) return { name: '', kind: 'SCALAR', scalarName: named.name, enumValues: null }
  if (isEnumType(named))   return { name: '', kind: 'ENUM', scalarName: null, enumValues: named.getValues().map((v) => v.name) }
  return null                                              // object/interface/union
}

export function entityFilterFieldsFromSchema(schema: GraphQLResolveInfo['schema'], typeName: string): EntityFilterField[] {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(typeName)) throw new ValidationError(`typeName non valido: "${typeName}"`)
  const type = schema.getType(typeName)
  if (!type || !(type instanceof GraphQLObjectType)) throw new ValidationError(`Tipo "${typeName}" inesistente o non filtrabile`)
  const out: EntityFilterField[] = []
  for (const [name, field] of Object.entries(type.getFields())) {
    const c = classify(field.type)
    if (c) out.push({ ...c, name })
  }
  return out
}

export const entityFilterFieldsResolvers = {
  Query: {
    entityFilterFields: (_: unknown, args: { typeName: string }, _ctx: unknown, info: GraphQLResolveInfo) =>
      entityFilterFieldsFromSchema(info.schema, args.typeName),
  },
}
