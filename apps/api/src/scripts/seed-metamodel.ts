import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'

const TENANT_ID = 'system'
const now = new Date().toISOString()

interface FieldDef {
  name:               string
  label:              string
  field_type:         string
  required?:          boolean
  default_value?:     string
  enum_values?:       string[]
  order:              number
  validation_script?: string
  visibility_script?: string
  default_script?:    string
}

interface RelationDef {
  name:              string
  label:             string
  relationship_type: string
  target_type:       string
  cardinality:       string
  direction:         string
  order:             number
}

interface SystemRelDef {
  name:              string
  label:             string
  relationship_type: string
  target_entity:     string
  required:          boolean
  order:             number
}

interface CIType {
  name:               string
  label:              string
  icon:               string
  color:              string
  neo4j_label:        string
  fields:             FieldDef[]
  relations:          RelationDef[]
  systemRels:         SystemRelDef[]
  validation_script?: string
}

const CI_TYPES: CIType[] = [
  {
    name: 'application', label: 'Application', icon: 'box', color: '#4f46e5', neo4j_label: 'Application',
    fields: [
      { name: 'url', label: 'URL', field_type: 'string', order: 1,
        validation_script: `
          if (value && !value.startsWith('http'))
            throw "L'URL deve iniziare con http/https"
          if (input.environment === 'production' && value && !value.startsWith('https'))
            throw "In production l'URL deve essere HTTPS"
        `,
        visibility_script: `return true` },
      { name: 'description', label: 'Descrizione', field_type: 'string', order: 2 },
      { name: 'notes',       label: 'Note',        field_type: 'string', order: 3 },
      { name: 'status',      label: 'Stato',       field_type: 'enum',   order: 4, enum_values: ['active', 'inactive', 'maintenance'] },
      { name: 'environment', label: 'Ambiente',    field_type: 'enum',   order: 5, enum_values: ['production', 'staging', 'development'] },
    ],
    relations: [
      { name: 'dependencies', label: 'Dipendenze', relationship_type: 'DEPENDS_ON', target_type: 'any', cardinality: 'many', direction: 'outgoing', order: 1 },
      { name: 'dependents',   label: 'Dipendenti', relationship_type: 'DEPENDS_ON', target_type: 'any', cardinality: 'many', direction: 'incoming', order: 2 },
    ],
    systemRels: [
      { name: 'ownerGroup',   label: 'Owner Group',   relationship_type: 'OWNED_BY',     target_entity: 'Team', required: true,  order: 1 },
      { name: 'supportGroup', label: 'Support Group', relationship_type: 'SUPPORTED_BY', target_entity: 'Team', required: false, order: 2 },
    ],
  },
  {
    name: 'database', label: 'Database', icon: 'database', color: '#0891b2', neo4j_label: 'Database',
    fields: [
      { name: 'port',         label: 'Porta',         field_type: 'string', order: 1 },
      { name: 'instanceType', label: 'Instance Type', field_type: 'enum',   order: 2, enum_values: ['PostgreSQL', 'Oracle', 'SQL Server'] },
      { name: 'description',  label: 'Descrizione',   field_type: 'string', order: 3 },
      { name: 'notes',        label: 'Note',          field_type: 'string', order: 4 },
      { name: 'status',       label: 'Stato',         field_type: 'enum',   order: 5, enum_values: ['active', 'inactive', 'maintenance'] },
      { name: 'environment',  label: 'Ambiente',      field_type: 'enum',   order: 6, enum_values: ['production', 'staging', 'development'] },
    ],
    relations: [
      { name: 'dependencies', label: 'Dipendenze', relationship_type: 'DEPENDS_ON', target_type: 'any', cardinality: 'many', direction: 'outgoing', order: 1 },
      { name: 'dependents',   label: 'Dipendenti', relationship_type: 'DEPENDS_ON', target_type: 'any', cardinality: 'many', direction: 'incoming', order: 2 },
    ],
    systemRels: [
      { name: 'ownerGroup',   label: 'Owner Group',   relationship_type: 'OWNED_BY',     target_entity: 'Team', required: true,  order: 1 },
      { name: 'supportGroup', label: 'Support Group', relationship_type: 'SUPPORTED_BY', target_entity: 'Team', required: false, order: 2 },
    ],
  },
  {
    name: 'database_instance', label: 'Database Instance', icon: 'server', color: '#0e7490', neo4j_label: 'DatabaseInstance',
    fields: [
      { name: 'ipAddress',    label: 'IP Address',    field_type: 'string', order: 1 },
      { name: 'port', label: 'Porta', field_type: 'string', order: 2,
        visibility_script: `return input.instanceType !== null && input.instanceType !== undefined`,
        default_script: `
          if (input.instanceType === 'PostgreSQL') return '5432'
          if (input.instanceType === 'Oracle')     return '1521'
          if (input.instanceType === 'SQL Server') return '1433'
          return null
        ` },
      { name: 'instanceType', label: 'Instance Type', field_type: 'enum', order: 3, enum_values: ['PostgreSQL', 'Oracle', 'SQL Server'] },
      { name: 'version', label: 'Versione', field_type: 'string', order: 4,
        visibility_script: `return input.instanceType !== null && input.instanceType !== undefined`,
        default_script: `
          if (input.instanceType === 'PostgreSQL') return '14.5'
          if (input.instanceType === 'Oracle')     return '19c'
          if (input.instanceType === 'SQL Server') return '2022'
          return null
        ` },
      { name: 'description',  label: 'Descrizione',   field_type: 'string', order: 5 },
      { name: 'notes',        label: 'Note',          field_type: 'string', order: 6 },
      { name: 'status',       label: 'Stato',         field_type: 'enum',   order: 7, enum_values: ['active', 'inactive', 'maintenance'] },
      { name: 'environment',  label: 'Ambiente',      field_type: 'enum',   order: 8, enum_values: ['production', 'staging', 'development'] },
    ],
    relations: [
      { name: 'dependencies', label: 'Dipendenze', relationship_type: 'DEPENDS_ON', target_type: 'any', cardinality: 'many', direction: 'outgoing', order: 1 },
      { name: 'dependents',   label: 'Dipendenti', relationship_type: 'DEPENDS_ON', target_type: 'any', cardinality: 'many', direction: 'incoming', order: 2 },
    ],
    systemRels: [
      { name: 'ownerGroup',   label: 'Owner Group',   relationship_type: 'OWNED_BY',     target_entity: 'Team', required: true,  order: 1 },
      { name: 'supportGroup', label: 'Support Group', relationship_type: 'SUPPORTED_BY', target_entity: 'Team', required: false, order: 2 },
    ],
  },
  {
    name: 'server', label: 'Server', icon: 'monitor', color: '#059669', neo4j_label: 'Server',
    fields: [
      { name: 'ipAddress', label: 'IP Address', field_type: 'string', order: 1, validation_script: `
        if (value) {
          const ipRegex = /^(\\d{1,3}\\.){3}\\d{1,3}$/
          if (!ipRegex.test(value)) {
            throw "Formato IP non valido (es. 192.168.1.1)"
          }
          const parts = value.split('.').map(Number)
          if (parts.some(p => p > 255)) {
            throw "Ogni ottetto IP deve essere tra 0 e 255"
          }
        }
      ` },
      { name: 'location',    label: 'Location',    field_type: 'string', order: 2 },
      { name: 'vendor',      label: 'Vendor',      field_type: 'string', order: 3 },
      { name: 'os',          label: 'OS',          field_type: 'enum',   order: 4, enum_values: ['Windows', 'Linux'] },
      { name: 'version',     label: 'Versione',    field_type: 'string', order: 5 },
      { name: 'description', label: 'Descrizione', field_type: 'string', order: 6 },
      { name: 'notes',       label: 'Note',        field_type: 'string', order: 7 },
      { name: 'status',      label: 'Stato',       field_type: 'enum',   order: 8, enum_values: ['active', 'inactive', 'maintenance'] },
      { name: 'environment', label: 'Ambiente',    field_type: 'enum',   order: 9, enum_values: ['production', 'staging', 'development'] },
    ],
    relations: [
      { name: 'dependencies', label: 'Dipendenze', relationship_type: 'DEPENDS_ON|HOSTED_ON',             target_type: 'any', cardinality: 'many', direction: 'outgoing', order: 1 },
      { name: 'dependents',   label: 'Dipendenti', relationship_type: 'DEPENDS_ON|HOSTED_ON|INSTALLED_ON', target_type: 'any', cardinality: 'many', direction: 'incoming', order: 2 },
    ],
    systemRels: [
      { name: 'ownerGroup',   label: 'Owner Group',   relationship_type: 'OWNED_BY',     target_entity: 'Team', required: true,  order: 1 },
      { name: 'supportGroup', label: 'Support Group', relationship_type: 'SUPPORTED_BY', target_entity: 'Team', required: false, order: 2 },
    ],
  },
  {
    name: 'certificate', label: 'Certificate', icon: 'shield', color: '#d97706', neo4j_label: 'Certificate',
    validation_script: `
      if (input.expiresAt && new Date(input.expiresAt) < new Date()) {
        throw 'La data di scadenza deve essere futura'
      }
    `,
    fields: [
      { name: 'serialNumber', label: 'Numero Seriale', field_type: 'string', required: true, order: 1 },
      { name: 'expiresAt', label: 'Scadenza', field_type: 'date', required: true, order: 2,
        validation_script: `
          if (!value) throw 'Data obbligatoria'
          if (new Date(value) < new Date()) throw 'La data deve essere futura'
        ` },
      { name: 'certificateType', label: 'Tipo', field_type: 'enum', required: true, order: 3,
        enum_values: ['public', 'external'],
        default_script: `return 'public'` },
      { name: 'description',       label: 'Descrizione',    field_type: 'string', order: 4 },
      { name: 'notes',             label: 'Note',           field_type: 'string', order: 5 },
      { name: 'status',            label: 'Stato',          field_type: 'enum',   order: 6, enum_values: ['active', 'expired', 'revoked'] },
      { name: 'environment',       label: 'Ambiente',       field_type: 'enum',   order: 7, enum_values: ['production', 'staging', 'development'] },
    ],
    relations: [
      { name: 'dependencies', label: 'Dipendenze', relationship_type: 'INSTALLED_ON',     target_type: 'Server',      cardinality: 'many', direction: 'outgoing', order: 1 },
      { name: 'dependents',   label: 'Dipendenti', relationship_type: 'USES_CERTIFICATE', target_type: 'Application', cardinality: 'many', direction: 'incoming', order: 2 },
    ],
    systemRels: [
      { name: 'ownerGroup',   label: 'Owner Group',   relationship_type: 'OWNED_BY',     target_entity: 'Team', required: true,  order: 1 },
      { name: 'supportGroup', label: 'Support Group', relationship_type: 'SUPPORTED_BY', target_entity: 'Team', required: false, order: 2 },
    ],
  },
]

async function main() {
  const session = getSession(undefined, 'WRITE')
  let typesCount = 0
  let fieldsCount = 0
  let relationsCount = 0
  let sysRelsCount = 0

  try {
    for (const ci of CI_TYPES) {
      const typeId = uuidv4()

      // Crea CITypeDefinition
      await session.executeWrite((tx) =>
        tx.run(
          `MERGE (t:CITypeDefinition {name: $name, tenant_id: $tenantId})
           ON CREATE SET
             t.id                = $id,
             t.label             = $label,
             t.icon              = $icon,
             t.color             = $color,
             t.scope             = 'base',
             t.neo4j_label       = $neo4jLabel,
             t.active            = true,
             t.validation_script = $validationScript,
             t.created_at        = $now
           ON MATCH SET
             t.label             = $label,
             t.icon              = $icon,
             t.color             = $color,
             t.neo4j_label       = $neo4jLabel,
             t.active            = true,
             t.validation_script = $validationScript`,
          { id: typeId, name: ci.name, label: ci.label, icon: ci.icon, color: ci.color,
            neo4jLabel: ci.neo4j_label, validationScript: ci.validation_script ?? null,
            tenantId: TENANT_ID, now },
        ),
      )
      typesCount++

      // Crea CIFieldDefinition e collega
      for (const f of ci.fields) {
        const fieldId = uuidv4()
        await session.executeWrite((tx) =>
          tx.run(
            `MATCH (t:CITypeDefinition {name: $typeName, tenant_id: $tenantId})
             MERGE (f:CIFieldDefinition {name: $name, tenant_id: $tenantId})
               -[:BELONGS_TO]->(t)
             ON CREATE SET
               f.id                = $id,
               f.label             = $label,
               f.field_type        = $fieldType,
               f.required          = $required,
               f.default_value     = $defaultValue,
               f.enum_values       = $enumValues,
               f.order             = $order,
               f.scope             = 'base',
               f.validation_script = $validationScript,
               f.visibility_script = $visibilityScript,
               f.default_script    = $defaultScript,
               f.created_at        = $now
             ON MATCH SET
               f.label             = $label,
               f.field_type        = $fieldType,
               f.required          = $required,
               f.enum_values       = $enumValues,
               f.order             = $order,
               f.validation_script = $validationScript,
               f.visibility_script = $visibilityScript,
               f.default_script    = $defaultScript
             WITH t, f
             MERGE (t)-[:HAS_FIELD]->(f)`,
            {
              id: fieldId, typeName: ci.name, tenantId: TENANT_ID,
              name: f.name, label: f.label, fieldType: f.field_type,
              required: f.required ?? false,
              defaultValue: f.default_value ?? null,
              enumValues: f.enum_values ? JSON.stringify(f.enum_values) : null,
              validationScript: f.validation_script ?? null,
              visibilityScript: f.visibility_script ?? null,
              defaultScript:    f.default_script    ?? null,
              order: f.order, now,
            },
          ),
        )
        fieldsCount++
      }

      // Crea CIRelationDefinition e collega
      for (const r of ci.relations) {
        const relId = uuidv4()
        await session.executeWrite((tx) =>
          tx.run(
            `MATCH (t:CITypeDefinition {name: $typeName, tenant_id: $tenantId})
             MERGE (r:CIRelationDefinition {name: $name, tenant_id: $tenantId})
               -[:BELONGS_TO]->(t)
             ON CREATE SET
               r.id                = $id,
               r.label             = $label,
               r.relationship_type = $relType,
               r.target_type       = $targetType,
               r.cardinality       = $cardinality,
               r.direction         = $direction,
               r.order             = $order,
               r.scope             = 'base',
               r.created_at        = $now
             ON MATCH SET
               r.label             = $label,
               r.relationship_type = $relType,
               r.target_type       = $targetType,
               r.cardinality       = $cardinality,
               r.direction         = $direction,
               r.order             = $order
             WITH t, r
             MERGE (t)-[:HAS_RELATION]->(r)`,
            {
              id: relId, typeName: ci.name, tenantId: TENANT_ID,
              name: r.name, label: r.label, relType: r.relationship_type,
              targetType: r.target_type, cardinality: r.cardinality,
              direction: r.direction, order: r.order, now,
            },
          ),
        )
        relationsCount++
      }

      // Crea CISystemRelationDefinition e collega
      for (const s of ci.systemRels) {
        const sysId = uuidv4()
        await session.executeWrite((tx) =>
          tx.run(
            `MATCH (t:CITypeDefinition {name: $typeName, tenant_id: $tenantId})
             MERGE (s:CISystemRelationDefinition {name: $name, tenant_id: $tenantId})
               -[:BELONGS_TO]->(t)
             ON CREATE SET
               s.id                = $id,
               s.label             = $label,
               s.relationship_type = $relType,
               s.target_entity     = $targetEntity,
               s.required          = $required,
               s.order             = $order,
               s.scope             = 'base',
               s.created_at        = $now
             ON MATCH SET
               s.label             = $label,
               s.relationship_type = $relType,
               s.target_entity     = $targetEntity,
               s.required          = $required,
               s.order             = $order
             WITH t, s
             MERGE (t)-[:HAS_SYSTEM_RELATION]->(s)`,
            {
              id: sysId, typeName: ci.name, tenantId: TENANT_ID,
              name: s.name, label: s.label, relType: s.relationship_type,
              targetEntity: s.target_entity, required: s.required,
              order: s.order, now,
            },
          ),
        )
        sysRelsCount++
      }

      console.log(`✓ ${ci.label}: ${ci.fields.length} fields, ${ci.relations.length} relations, ${ci.systemRels.length} system rels`)
    }

    console.log('\n── Metamodello creato ──────────────────────────────')
    console.log(`  CITypeDefinition:             ${typesCount}`)
    console.log(`  CIFieldDefinition:            ${fieldsCount}`)
    console.log(`  CIRelationDefinition:         ${relationsCount}`)
    console.log(`  CISystemRelationDefinition:   ${sysRelsCount}`)
    console.log(`  Totale nodi:                  ${typesCount + fieldsCount + relationsCount + sysRelsCount}`)
  } finally {
    await session.close()
    process.exit(0)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
