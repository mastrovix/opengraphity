import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { GET_CI_TYPES } from '../graphql/queries'
import { shippedLabel } from '@/lib/shippedLabel'

export interface CIFieldDef {
  id: string
  name: string
  label: string
  fieldType: string
  required: boolean
  enumValues: string[]
  /** Il vocabolario da cui vengono i valori (per le etichette), se il campo ne usa uno. */
  enumTypeName?: string | null
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
  /** base | itil | tenant. Diverso da `tenant` = spedito col prodotto, in sola lettura (A-6). */
  scope: string
  /** Il cliente proprietario: `system` per i tipi spediti col prodotto. */
  tenantId: string
  validationScript: string | null
  chainFamilies: string[]
  /**
   * Ruolo del tipo nella mappa di un servizio (`component | infrastructure |
   * certificate`, ondata 6 · A-10). `null` = non dichiarato: lo propone il
   * prodotto (dalle famiglie di catena), e il disegnatore lo mostra così.
   */
  serviceRole: string | null
  fields: CIFieldDef[]
  relations: CIRelationDef[]
  systemRelations: CISystemRelationDef[]
}

interface MetamodelContextType {
  ciTypes: CITypeDef[]
  loading: boolean
  error: Error | null
  getCIType: (name: string) => CITypeDef | undefined
}

const MetamodelContext = createContext<MetamodelContextType>({
  ciTypes: [],
  loading: true,
  error: null,
  getCIType: () => undefined,
})

export function MetamodelProvider({ children }: { children: ReactNode }) {
  const { data, loading, error } = useQuery<{ ciTypes: CITypeDef[] }>(GET_CI_TYPES)
  const { i18n } = useTranslation()
  // Le etichette spedite nella lingua di chi guarda (`shippedLabel`): chi legge
  // il metamodello da qui (CMDB, dettaglio CI, filtri) le riceve già tradotte;
  // i disegnatori leggono il nodo com'è, perché è quello che si modifica.
  const ciTypes: CITypeDef[] = useMemo(() => (data?.ciTypes ?? []).map((ct) => ({
    ...ct,
    fields:    ct.fields.map((f) => ({ ...f, label: shippedLabel('field', f.name, f.label) })),
    relations: ct.relations.map((r) => ({ ...r, label: shippedLabel('relation', r.name, r.label) })),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- la lingua cambia le etichette
  })), [data, i18n.language])

  return (
    <MetamodelContext.Provider value={{
      ciTypes,
      loading,
      error: error ?? null,
      getCIType: (name) => ciTypes.find(t => t.name === name),
    }}>
      {children}
    </MetamodelContext.Provider>
  )
}

export const useMetamodel = () => useContext(MetamodelContext)
