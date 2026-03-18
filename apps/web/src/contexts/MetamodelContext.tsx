import { createContext, useContext, type ReactNode } from 'react'
import { useQuery } from '@apollo/client/react'
import { GET_CI_TYPES } from '../graphql/queries'

export interface CIFieldDef {
  id: string
  name: string
  label: string
  fieldType: string
  required: boolean
  enumValues: string[]
  order: number
  isSystem: boolean
  validationScript: string | null
  visibilityScript: string | null
  defaultScript: string | null
}

export interface CIRelationDef {
  id: string
  name: string
  label: string
  relationshipType: string
  targetType: string
  cardinality: string
  direction: string
  order: number
}

export interface CISystemRelationDef {
  id: string
  name: string
  label: string
  relationshipType: string
  targetEntity: string
  required: boolean
  order: number
}

export interface CITypeDef {
  id: string
  name: string
  label: string
  icon: string
  color: string
  active: boolean
  validationScript: string | null
  fields: CIFieldDef[]
  relations: CIRelationDef[]
  systemRelations: CISystemRelationDef[]
}

interface MetamodelContextType {
  ciTypes: CITypeDef[]
  loading: boolean
  getCIType: (name: string) => CITypeDef | undefined
}

const MetamodelContext = createContext<MetamodelContextType>({
  ciTypes: [],
  loading: true,
  getCIType: () => undefined,
})

export function MetamodelProvider({ children }: { children: ReactNode }) {
  const { data, loading } = useQuery<{ ciTypes: CITypeDef[] }>(GET_CI_TYPES)
  const ciTypes: CITypeDef[] = data?.ciTypes ?? []

  return (
    <MetamodelContext.Provider value={{
      ciTypes,
      loading,
      getCIType: (name) => ciTypes.find(t => t.name === name),
    }}>
      {children}
    </MetamodelContext.Provider>
  )
}

export const useMetamodel = () => useContext(MetamodelContext)
