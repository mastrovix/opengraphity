/**
 * Fetches enum values for a given entity type + field name from ITIL/CI type definitions.
 * Uses the ITIL metamodel (GET_ITIL_TYPES) for ITIL entities (incident, problem, change,
 * service_request) and GET_CI_TYPES for CMDB entities (server, application, etc.).
 *
 * Returns { values, loading } — values is empty while loading.
 */
import { useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import { GET_ITIL_TYPES, GET_CI_TYPES } from '@/graphql/queries'

const ITIL_ENTITIES = new Set(['incident', 'problem', 'change', 'service_request'])

interface TypeDef {
  name:   string
  fields: { name: string; fieldType: string; enumValues?: string[] | null }[]
}

export function useEnumValues(entityType: string, fieldName: string): { values: string[]; loading: boolean } {
  const isITIL = ITIL_ENTITIES.has(entityType)

  const { data: itilData, loading: itilLoading } = useQuery(GET_ITIL_TYPES, {
    skip: !isITIL,
    fetchPolicy: 'cache-first',
  })
  const { data: ciData, loading: ciLoading } = useQuery(GET_CI_TYPES, {
    skip: isITIL,
    fetchPolicy: 'cache-first',
  })

  const loading = isITIL ? itilLoading : ciLoading

  const values = useMemo(() => {
    const types = isITIL
      ? (itilData as { itilTypes?: TypeDef[] } | undefined)?.itilTypes
      : (ciData   as { ciTypes?:   TypeDef[] } | undefined)?.ciTypes

    if (!types) return []

    const typeDef = types.find(t => t.name === entityType)
    if (!typeDef) return []

    const field = typeDef.fields.find(f => f.name === fieldName)
    if (!field || field.fieldType !== 'enum') return []

    return field.enumValues ?? []
  }, [isITIL, entityType, fieldName, itilData, ciData])

  return { values, loading }
}
