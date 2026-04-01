/**
 * Derives the set of filterable scalar/enum field names for a GraphQL object type
 * directly from the compiled schema — no manual allowlists needed.
 */
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLNonNull,
  GraphQLList,
  GraphQLScalarType,
  GraphQLEnumType,
} from 'graphql'

/** Returns the names of all scalar and enum fields on a named GraphQL object type. */
export function getScalarFields(schema: GraphQLSchema, typeName: string): Set<string> {
  const type = schema.getType(typeName)
  if (!(type instanceof GraphQLObjectType)) return new Set()

  const result = new Set<string>()

  for (const [name, field] of Object.entries(type.getFields())) {
    // Unwrap NonNull and List wrappers; if a LIST appears, skip the field
    let inner = field.type
    let hasList = false
    while (inner instanceof GraphQLNonNull || inner instanceof GraphQLList) {
      if (inner instanceof GraphQLList) { hasList = true; break }
      inner = inner.ofType
    }
    if (hasList) continue

    if (inner instanceof GraphQLScalarType || inner instanceof GraphQLEnumType) {
      result.add(name)
    }
  }

  return result
}
