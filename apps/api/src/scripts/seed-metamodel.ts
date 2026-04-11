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
  is_system?:         boolean
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
  description?:      string
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
  active?:            boolean
  chain_families?:    string[]
  fields:             FieldDef[]
  relations:          RelationDef[]
  systemRels:         SystemRelDef[]
  validation_script?: string
}

// ── __base__ virtual type ─────────────────────────────────────────────────────
const BASE_TYPE: CIType = {
  name: '__base__', label: 'Base', icon: '', color: '', neo4j_label: '__base__',
  active: false,
  fields: [
    { name: 'id',          label: 'ID',           field_type: 'string', is_system: true, order: 0 },
    { name: 'name',        label: 'Nome',         field_type: 'string', is_system: true, order: 1 },
    { name: 'status',      label: 'Stato',        field_type: 'enum',   is_system: true, order: 2,
      enum_values: ['active', 'inactive', 'maintenance'] },
    { name: 'environment', label: 'Ambiente',     field_type: 'enum',   is_system: true, order: 3,
      enum_values: ['production', 'staging', 'development'] },
    { name: 'description', label: 'Descrizione',  field_type: 'string', is_system: true, order: 4 },
    { name: 'notes',       label: 'Note',         field_type: 'string', is_system: true, order: 5 },
    { name: 'createdAt',   label: 'Creato il',    field_type: 'date',   is_system: true, order: 6 },
    { name: 'updatedAt',   label: 'Aggiornato il',field_type: 'date',   is_system: true, order: 7 },
    { name: 'chain',       label: 'Chain',        field_type: 'enum',   is_system: true, order: 8,
      enum_values: ['Application', 'Infrastructure'] },
  ],
  relations:  [],
  systemRels: [],
}

// ── CI types — no base fields (status, environment, description, notes) ───────
const CI_TYPES: CIType[] = [
  {
    name: 'application', label: 'Application', icon: 'box', color: '#4f46e5', neo4j_label: 'Application',
    chain_families: ['Application'],
    fields: [
      { name: 'url', label: 'URL', field_type: 'string', order: 10,
        validation_script: `
          if (value && !value.startsWith('http'))
            throw "L'URL deve iniziare con http/https"
          if (input.environment === 'production' && value && !value.startsWith('https'))
            throw "In production l'URL deve essere HTTPS"
        `,
        visibility_script: `return true` },
    ],
    relations: [
      { name: 'dependencies', label: 'Dipendenze',             relationship_type: 'DEPENDS_ON',      target_type: 'any',         cardinality: 'many', direction: 'outgoing', order: 1, description: 'CI da cui questa applicazione dipende (database, server, altre applicazioni)' },
      { name: 'dependents',   label: 'Dipendenti',             relationship_type: 'DEPENDS_ON',      target_type: 'any',         cardinality: 'many', direction: 'incoming', order: 2, description: 'CI che dipendono da questa applicazione' },
      { name: 'hostedOn',     label: 'Hosted On',              relationship_type: 'HOSTED_ON',       target_type: 'Server',      cardinality: 'many', direction: 'outgoing', order: 3, description: 'Server su cui è ospitata questa applicazione' },
      { name: 'certificates', label: 'Uses Certificate',       relationship_type: 'USES_CERTIFICATE',target_type: 'Certificate', cardinality: 'many', direction: 'outgoing', order: 4, description: 'Certificati SSL/TLS utilizzati da questa applicazione' },
    ],
    systemRels: [
      { name: 'ownerGroup',   label: 'Owner Group',   relationship_type: 'OWNED_BY',     target_entity: 'Team', required: true,  order: 1 },
      { name: 'supportGroup', label: 'Support Group', relationship_type: 'SUPPORTED_BY', target_entity: 'Team', required: false, order: 2 },
    ],
  },
  {
    name: 'database', label: 'Database', icon: 'database', color: '#0891b2', neo4j_label: 'Database',
    chain_families: ['Application', 'Infrastructure'],
    fields: [
      { name: 'port',         label: 'Porta',         field_type: 'string', order: 10 },
      { name: 'instanceType', label: 'Instance Type', field_type: 'enum',   order: 11, enum_values: ['PostgreSQL', 'Oracle', 'SQL Server'] },
    ],
    relations: [
      { name: 'dependencies', label: 'Dipendenze', relationship_type: 'DEPENDS_ON', target_type: 'any', cardinality: 'many', direction: 'outgoing', order: 1, description: 'Istanze database su cui gira questo database' },
      { name: 'dependents',   label: 'Dipendenti', relationship_type: 'DEPENDS_ON', target_type: 'any', cardinality: 'many', direction: 'incoming', order: 2, description: 'CI che dipendono da questo database' },
    ],
    systemRels: [
      { name: 'ownerGroup',   label: 'Owner Group',   relationship_type: 'OWNED_BY',     target_entity: 'Team', required: true,  order: 1 },
      { name: 'supportGroup', label: 'Support Group', relationship_type: 'SUPPORTED_BY', target_entity: 'Team', required: false, order: 2 },
    ],
  },
  {
    name: 'database_instance', label: 'Database Instance', icon: 'server', color: '#0e7490', neo4j_label: 'DatabaseInstance',
    chain_families: ['Application', 'Infrastructure'],
    fields: [
      { name: 'ipAddress',    label: 'IP Address',    field_type: 'string', order: 10 },
      { name: 'port', label: 'Porta', field_type: 'string', order: 11,
        visibility_script: `return input.instanceType !== null && input.instanceType !== undefined`,
        default_script: `
          if (input.instanceType === 'PostgreSQL') return '5432'
          if (input.instanceType === 'Oracle')     return '1521'
          if (input.instanceType === 'SQL Server') return '1433'
          return null
        ` },
      { name: 'instanceType', label: 'Instance Type', field_type: 'enum', order: 12, enum_values: ['PostgreSQL', 'Oracle', 'SQL Server'] },
      { name: 'version', label: 'Versione', field_type: 'string', order: 13,
        visibility_script: `return input.instanceType !== null && input.instanceType !== undefined`,
        default_script: `
          if (input.instanceType === 'PostgreSQL') return '14.5'
          if (input.instanceType === 'Oracle')     return '19c'
          if (input.instanceType === 'SQL Server') return '2022'
          return null
        ` },
    ],
    relations: [
      { name: 'dependencies', label: 'Dipendenze', relationship_type: 'DEPENDS_ON', target_type: 'any',    cardinality: 'many', direction: 'outgoing', order: 1, description: 'CI da cui questa istanza dipende' },
      { name: 'dependents',   label: 'Dipendenti', relationship_type: 'DEPENDS_ON', target_type: 'any',    cardinality: 'many', direction: 'incoming', order: 2, description: 'Database che girano su questa istanza' },
      { name: 'hostedOn',     label: 'Hosted On',  relationship_type: 'HOSTED_ON',  target_type: 'Server', cardinality: 'many', direction: 'outgoing', order: 3, description: 'Server che ospita questa istanza database' },
    ],
    systemRels: [
      { name: 'ownerGroup',   label: 'Owner Group',   relationship_type: 'OWNED_BY',     target_entity: 'Team', required: true,  order: 1 },
      { name: 'supportGroup', label: 'Support Group', relationship_type: 'SUPPORTED_BY', target_entity: 'Team', required: false, order: 2 },
    ],
  },
  {
    name: 'server', label: 'Server', icon: 'monitor', color: '#059669', neo4j_label: 'Server',
    chain_families: ['Application', 'Infrastructure'],
    fields: [
      { name: 'ipAddress', label: 'IP Address', field_type: 'string', order: 10, validation_script: `
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
      { name: 'location', label: 'Location', field_type: 'string', order: 11 },
      { name: 'vendor',   label: 'Vendor',   field_type: 'string', order: 12 },
      { name: 'os',       label: 'OS',       field_type: 'enum',   order: 13, enum_values: ['Windows', 'Linux'] },
      { name: 'version',  label: 'Versione', field_type: 'string', order: 14 },
    ],
    relations: [
      { name: 'dependencies', label: 'Dipendenze', relationship_type: 'DEPENDS_ON|HOSTED_ON',             target_type: 'any', cardinality: 'many', direction: 'outgoing', order: 1, description: 'CI da cui questo server dipende o che ospita' },
      { name: 'dependents',   label: 'Dipendenti', relationship_type: 'DEPENDS_ON|HOSTED_ON|INSTALLED_ON', target_type: 'any', cardinality: 'many', direction: 'incoming', order: 2, description: 'CI che dipendono da questo server, sono ospitati su di esso, o vi hanno installato certificati' },
    ],
    systemRels: [
      { name: 'ownerGroup',   label: 'Owner Group',   relationship_type: 'OWNED_BY',     target_entity: 'Team', required: true,  order: 1 },
      { name: 'supportGroup', label: 'Support Group', relationship_type: 'SUPPORTED_BY', target_entity: 'Team', required: false, order: 2 },
    ],
  },
  {
    name: 'certificate', label: 'Certificate', icon: 'shield', color: '#d97706', neo4j_label: 'Certificate',
    chain_families: ['Application', 'Infrastructure'],
    validation_script: `
      if (input.expiresAt && new Date(input.expiresAt) < new Date()) {
        throw 'La data di scadenza deve essere futura'
      }
    `,
    fields: [
      { name: 'serialNumber', label: 'Numero Seriale', field_type: 'string', required: true, order: 10 },
      { name: 'expiresAt', label: 'Scadenza', field_type: 'date', required: true, order: 11,
        validation_script: `
          if (!value) throw 'Data obbligatoria'
          if (new Date(value) < new Date()) throw 'La data deve essere futura'
        ` },
      { name: 'certificateType', label: 'Tipo', field_type: 'enum', required: true, order: 12,
        enum_values: ['public', 'external'],
        default_script: `return 'public'` },
    ],
    relations: [
      { name: 'dependencies', label: 'Dipendenze', relationship_type: 'INSTALLED_ON',     target_type: 'Server',      cardinality: 'many', direction: 'outgoing', order: 1, description: 'Server su cui è installato questo certificato' },
      { name: 'dependents',   label: 'Dipendenti', relationship_type: 'USES_CERTIFICATE', target_type: 'Application', cardinality: 'many', direction: 'incoming', order: 2, description: 'Applicazioni che utilizzano questo certificato' },
    ],
    systemRels: [
      { name: 'ownerGroup',   label: 'Owner Group',   relationship_type: 'OWNED_BY',     target_entity: 'Team', required: true,  order: 1 },
      { name: 'supportGroup', label: 'Support Group', relationship_type: 'SUPPORTED_BY', target_entity: 'Team', required: false, order: 2 },
    ],
  },
]

async function seedCIType(session: Awaited<ReturnType<typeof getSession>>, ci: CIType) {
  const typeId = uuidv4()
  const isActive = ci.active !== false

  await session.executeWrite(tx =>
    tx.run(
      `MERGE (t:CITypeDefinition {name: $name, tenant_id: $tenantId})
       ON CREATE SET
         t.id                = $id,
         t.label             = $label,
         t.icon              = $icon,
         t.color             = $color,
         t.scope             = 'base',
         t.neo4j_label       = $neo4jLabel,
         t.active            = $active,
         t.validation_script = $validationScript,
         t.chain_families    = $chainFamilies,
         t.created_at        = $now
       ON MATCH SET
         t.label             = $label,
         t.icon              = $icon,
         t.color             = $color,
         t.neo4j_label       = $neo4jLabel,
         t.active            = $active,
         t.validation_script = $validationScript,
         t.chain_families    = $chainFamilies`,
      { id: typeId, name: ci.name, label: ci.label, icon: ci.icon, color: ci.color,
        neo4jLabel: ci.neo4j_label, validationScript: ci.validation_script ?? null,
        chainFamilies: JSON.stringify(ci.chain_families ?? ['Application', 'Infrastructure']),
        active: isActive, tenantId: TENANT_ID, now },
    ),
  )

  for (const f of ci.fields) {
    const fieldId = uuidv4()
    await session.executeWrite(tx =>
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
           f.is_system         = $isSystem,
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
           f.is_system         = $isSystem,
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
          isSystem: f.is_system ?? false,
          validationScript: f.validation_script ?? null,
          visibilityScript: f.visibility_script ?? null,
          defaultScript:    f.default_script    ?? null,
          order: f.order, now,
        },
      ),
    )
  }

  for (const r of ci.relations) {
    const relId = uuidv4()
    await session.executeWrite(tx =>
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
           r.description       = $description,
           r.scope             = 'base',
           r.created_at        = $now
         ON MATCH SET
           r.label             = $label,
           r.relationship_type = $relType,
           r.target_type       = $targetType,
           r.cardinality       = $cardinality,
           r.direction         = $direction,
           r.order             = $order,
           r.description       = $description
         WITH t, r
         MERGE (t)-[:HAS_RELATION]->(r)`,
        {
          id: relId, typeName: ci.name, tenantId: TENANT_ID,
          name: r.name, label: r.label, relType: r.relationship_type,
          targetType: r.target_type, cardinality: r.cardinality,
          direction: r.direction, order: r.order,
          description: r.description ?? null, now,
        },
      ),
    )
  }

  for (const s of ci.systemRels) {
    const sysId = uuidv4()
    await session.executeWrite(tx =>
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
  }

  return ci
}

async function main() {
  const session = getSession(undefined, 'WRITE')

  try {
    // 1. Seed __base__ type
    await seedCIType(session, BASE_TYPE)
    console.log(`✓ __base__: ${BASE_TYPE.fields.length} system fields`)

    // 2. Seed concrete CI types + EXTENDS relationship to __base__
    let typesCount = 0
    for (const ci of CI_TYPES) {
      await seedCIType(session, ci)

      // Create EXTENDS relationship
      await session.executeWrite(tx =>
        tx.run(
          `MATCH (t:CITypeDefinition {name: $name, tenant_id: $tenantId})
           MATCH (base:CITypeDefinition {name: '__base__', tenant_id: $tenantId})
           MERGE (t)-[:EXTENDS]->(base)`,
          { name: ci.name, tenantId: TENANT_ID },
        ),
      )

      typesCount++
      console.log(`✓ ${ci.label}: ${ci.fields.length} fields, ${ci.relations.length} relations, ${ci.systemRels.length} system rels`)
    }

    // 3. Remove stale base fields from concrete types (cleanup for idempotency)
    const baseFieldNames = BASE_TYPE.fields.map(f => f.name)
    const removed = await session.executeWrite(tx =>
      tx.run(
        `MATCH (t:CITypeDefinition)
         WHERE t.name <> '__base__' AND t.tenant_id = $tenantId
         MATCH (t)-[r:HAS_FIELD]->(f:CIFieldDefinition)
         WHERE f.name IN $baseFieldNames AND f.tenant_id = $tenantId AND f.is_system IS NULL
         DELETE r
         RETURN count(r) AS removed`,
        { tenantId: TENANT_ID, baseFieldNames },
      ),
    )
    const rawRemoved = removed.records[0]?.get('removed')
    const removedCount = typeof rawRemoved === 'number' ? rawRemoved : typeof (rawRemoved as { toNumber?: () => number })?.toNumber === 'function' ? (rawRemoved as { toNumber: () => number }).toNumber() : Number(rawRemoved ?? 0)
    if (removedCount > 0) {
      console.log(`\n  Removed ${removedCount} stale HAS_FIELD edges (base fields on concrete types)`)
    }

    // 4. Create ci_chain enum + link via USES_ENUM
    await session.executeWrite(tx =>
      tx.run(
        `MERGE (e:EnumTypeDefinition {name: 'ci_chain', tenant_id: $tenantId})
         ON CREATE SET e.id = randomUUID(), e.label = 'CI Chain', e.values = $values,
           e.is_system = true, e.scope = 'cmdb', e.created_at = $now, e.updated_at = $now
         ON MATCH SET e.values = $values, e.updated_at = $now
         WITH e
         MATCH (f:CIFieldDefinition {name: 'chain', tenant_id: $tenantId})
         MERGE (f)-[:USES_ENUM]->(e)`,
        { tenantId: TENANT_ID, values: JSON.stringify(['Application', 'Infrastructure']), now },
      ),
    )
    console.log('✓ ci_chain enum created + linked via USES_ENUM')

    console.log('\n── Metamodello creato ──────────────────────────────')
    console.log(`  __base__ type:      1 (${BASE_TYPE.fields.length} system fields)`)
    console.log(`  CI types:           ${typesCount}`)
  } finally {
    await session.close()
    process.exit(0)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
