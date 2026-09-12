export interface CITypeDefinition {
  id: string
  name: string
  label: string
  icon: string
  color: string
  scope: 'base' | 'tenant' | 'itil'
  tenantId: string
  active: boolean
  neo4jLabel: string
  validationScript: string | null
  /**
   * Ruolo del tipo nella mappa di un servizio (`component | infrastructure |
   * certificate`), ondata 6 · A-10. `null` quando il tipo non lo dichiara: chi
   * legge ricade sul seme dei tipi spediti e poi sulle famiglie di catena
   * (`lib/ciMetamodelForTenant.ts`), mai su un ruolo inventato qui.
   */
  serviceRole: string | null
}

export interface CIFieldDefinition {
  id: string
  name: string
  label: string
  fieldType: 'string' | 'number' | 'date' | 'boolean' | 'enum'
  required: boolean
  defaultValue: string | null
  enumValues: string[]
  order: number
  scope: 'base' | 'tenant' | 'itil'
  tenantId: string
  validationScript: string | null
  visibilityScript: string | null
  defaultScript: string | null
  isSystem: boolean
}

export interface CIRelationDefinition {
  id: string
  name: string
  label: string
  relationshipType: string
  targetType: string
  cardinality: 'one' | 'many'
  direction: 'outgoing' | 'incoming'
  order: number
}

export interface CISystemRelationDefinition {
  id: string
  name: string
  label: string
  relationshipType: string
  targetEntity: string
  required: boolean
  order: number
}

export interface CITypeWithDefinitions extends CITypeDefinition {
  fields: CIFieldDefinition[]
  relations: CIRelationDefinition[]
  systemRelations: CISystemRelationDefinition[]
  chainFamilies?: string[]
}
