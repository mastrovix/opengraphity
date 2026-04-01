/**
 * Seeds ITIL type definitions in Neo4j metamodel (scope: 'itil').
 * Incident, Change, Problem, ServiceRequest get CITypeDefinition + CIFieldDefinition nodes
 * so the schema generator can build real GraphQL enums from their enum fields at runtime.
 *
 * Usage:
 *   pnpm tsx apps/api/src/scripts/seed-itil-metamodel.ts [--slug acme]
 *   (--slug defaults to 'system' for shared/global definitions)
 *
 * MERGE-based: safe to run multiple times.
 */

import { v4 as uuidv4 } from 'uuid'
import { parseArgs } from 'node:util'
import { getSession } from '@opengraphity/neo4j'

const { values: args } = parseArgs({
  options: { slug: { type: 'string', default: 'system' } },
})

const TENANT_ID = args['slug']!
const now = new Date().toISOString()

// ── Field definition ──────────────────────────────────────────────────────────

interface FieldDef {
  name:         string
  label:        string
  field_type:   'string' | 'enum' | 'date' | 'number' | 'boolean'
  required:     boolean
  enum_values?: string[]
  order:        number
}

// ── ITIL type definitions ─────────────────────────────────────────────────────

interface ITILType {
  name:        string
  label:       string
  neo4j_label: string
  fields:      FieldDef[]
}

const ITIL_TYPES: ITILType[] = [
  {
    name: 'incident', label: 'Incident', neo4j_label: 'Incident',
    fields: [
      { name: 'title',       label: 'Titolo',        field_type: 'string', required: true,  order: 1 },
      { name: 'description', label: 'Descrizione',   field_type: 'string', required: false, order: 2 },
      { name: 'status',      label: 'Stato',         field_type: 'enum',   required: true,  order: 3,
        enum_values: ['new', 'open', 'assigned', 'in_progress', 'pending', 'escalated', 'resolved', 'closed'] },
      { name: 'severity',    label: 'Severità',      field_type: 'enum',   required: true,  order: 4,
        enum_values: ['low', 'medium', 'high', 'critical'] },
      { name: 'root_cause',  label: 'Root Cause',    field_type: 'string', required: false, order: 5 },
      { name: 'created_at',  label: 'Creato il',     field_type: 'date',   required: true,  order: 6 },
      { name: 'updated_at',  label: 'Aggiornato il', field_type: 'date',   required: true,  order: 7 },
      { name: 'resolved_at', label: 'Risolto il',    field_type: 'date',   required: false, order: 8 },
    ],
  },
  {
    name: 'change', label: 'Change', neo4j_label: 'Change',
    fields: [
      { name: 'title',          label: 'Titolo',        field_type: 'string', required: true,  order: 1 },
      { name: 'description',    label: 'Descrizione',   field_type: 'string', required: false, order: 2 },
      { name: 'status',         label: 'Stato',         field_type: 'enum',   required: true,  order: 3,
        enum_values: ['draft', 'approved', 'scheduled', 'assessment', 'cab_approval',
                      'emergency_approval', 'validation', 'deployment', 'post_review',
                      'completed', 'failed', 'rejected'] },
      { name: 'type',           label: 'Tipo',          field_type: 'enum',   required: true,  order: 4,
        enum_values: ['standard', 'normal', 'emergency'] },
      { name: 'priority',       label: 'Priorità',      field_type: 'enum',   required: true,  order: 5,
        enum_values: ['low', 'medium', 'high', 'critical'] },
      { name: 'risk',           label: 'Rischio',       field_type: 'enum',   required: false, order: 6,
        enum_values: ['low', 'medium', 'high'] },
      { name: 'impact',         label: 'Impatto',       field_type: 'enum',   required: false, order: 7,
        enum_values: ['low', 'medium', 'high'] },
      { name: 'scheduled_start',label: 'Inizio Prev.',  field_type: 'date',   required: false, order: 8 },
      { name: 'scheduled_end',  label: 'Fine Prev.',    field_type: 'date',   required: false, order: 9 },
      { name: 'created_at',     label: 'Creato il',     field_type: 'date',   required: true,  order: 10 },
      { name: 'updated_at',     label: 'Aggiornato il', field_type: 'date',   required: true,  order: 11 },
    ],
  },
  {
    name: 'problem', label: 'Problem', neo4j_label: 'Problem',
    fields: [
      { name: 'title',       label: 'Titolo',        field_type: 'string', required: true,  order: 1 },
      { name: 'description', label: 'Descrizione',   field_type: 'string', required: false, order: 2 },
      { name: 'status',      label: 'Stato',         field_type: 'enum',   required: true,  order: 3,
        enum_values: ['new', 'under_investigation', 'change_requested', 'change_in_progress',
                      'deferred', 'resolved', 'closed'] },
      { name: 'priority',    label: 'Priorità',      field_type: 'enum',   required: true,  order: 4,
        enum_values: ['low', 'medium', 'high', 'critical'] },
      { name: 'category',    label: 'Categoria',     field_type: 'string', required: false, order: 5 },
      { name: 'root_cause',  label: 'Root Cause',    field_type: 'string', required: false, order: 6 },
      { name: 'workaround',  label: 'Workaround',    field_type: 'string', required: false, order: 7 },
      { name: 'created_at',  label: 'Creato il',     field_type: 'date',   required: true,  order: 8 },
      { name: 'updated_at',  label: 'Aggiornato il', field_type: 'date',   required: true,  order: 9 },
    ],
  },
  {
    name: 'service_request', label: 'Service Request', neo4j_label: 'ServiceRequest',
    fields: [
      { name: 'title',       label: 'Titolo',        field_type: 'string', required: true,  order: 1 },
      { name: 'description', label: 'Descrizione',   field_type: 'string', required: false, order: 2 },
      { name: 'status',      label: 'Stato',         field_type: 'enum',   required: true,  order: 3,
        enum_values: ['open', 'in_progress', 'completed', 'cancelled'] },
      { name: 'priority',    label: 'Priorità',      field_type: 'enum',   required: true,  order: 4,
        enum_values: ['low', 'medium', 'high', 'critical'] },
      { name: 'category',    label: 'Categoria',     field_type: 'string', required: false, order: 5 },
      { name: 'created_at',  label: 'Creato il',     field_type: 'date',   required: true,  order: 6 },
      { name: 'updated_at',  label: 'Aggiornato il', field_type: 'date',   required: true,  order: 7 },
    ],
  },
]

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedITILType(
  session: Awaited<ReturnType<typeof getSession>>,
  itil: ITILType,
) {
  const typeId = uuidv4()

  // Upsert CITypeDefinition with scope: 'itil'
  await session.executeWrite(tx =>
    tx.run(
      `MERGE (t:CITypeDefinition {name: $name, tenant_id: $tenantId})
       ON CREATE SET
         t.id          = $id,
         t.label       = $label,
         t.icon        = '',
         t.color       = '#0284c7',
         t.scope       = 'itil',
         t.neo4j_label = $neo4jLabel,
         t.active      = true,
         t.created_at  = $now
       ON MATCH SET
         t.label       = $label,
         t.scope       = 'itil',
         t.neo4j_label = $neo4jLabel,
         t.active      = true`,
      { id: typeId, name: itil.name, label: itil.label,
        neo4jLabel: itil.neo4j_label, tenantId: TENANT_ID, now },
    ),
  )

  // Upsert each field
  for (const f of itil.fields) {
    const fieldId = uuidv4()
    await session.executeWrite(tx =>
      tx.run(
        `MATCH (t:CITypeDefinition {name: $typeName, tenant_id: $tenantId})
         MERGE (f:CIFieldDefinition {name: $name, tenant_id: $tenantId})
           -[:BELONGS_TO]->(t)
         ON CREATE SET
           f.id          = $id,
           f.label       = $label,
           f.field_type  = $fieldType,
           f.required    = $required,
           f.enum_values = $enumValues,
           f.order       = $order,
           f.scope       = 'itil',
           f.is_system   = true,
           f.created_at  = $now
         ON MATCH SET
           f.label       = $label,
           f.field_type  = $fieldType,
           f.required    = $required,
           f.enum_values = $enumValues,
           f.order       = $order,
           f.scope       = 'itil',
           f.is_system   = true
         WITH t, f
         MERGE (t)-[:HAS_FIELD]->(f)`,
        {
          id:         fieldId,
          typeName:   itil.name,
          tenantId:   TENANT_ID,
          name:       f.name,
          label:      f.label,
          fieldType:  f.field_type,
          required:   f.required,
          enumValues: f.enum_values ? JSON.stringify(f.enum_values) : null,
          order:      f.order,
          now,
        },
      ),
    )
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const session = getSession(undefined, 'WRITE')

  console.log(`\n╔══════════════════════════════════════════╗`)
  console.log(`║  OpenGrafo — Seed ITIL Metamodel          ║`)
  console.log(`║  tenant_id: ${TENANT_ID.padEnd(29)}║`)
  console.log(`╚══════════════════════════════════════════╝\n`)

  try {
    for (const itil of ITIL_TYPES) {
      await seedITILType(session, itil)
      console.log(`✓ ${itil.label}: ${itil.fields.length} fields`)
    }

    console.log('\n── ITIL metamodello creato ─────────────────────────────')
    console.log(`  Tipi: ${ITIL_TYPES.length} (${ITIL_TYPES.map(t => t.label).join(', ')})`)
    console.log(`  Scope: itil | tenant_id: ${TENANT_ID}`)
  } finally {
    await session.close()
    process.exit(0)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
