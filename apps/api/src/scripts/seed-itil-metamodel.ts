/**
 * Seeds ITIL type definitions in Neo4j metamodel (scope: 'itil').
 * Incident, Change, Problem, ServiceRequest get CITypeDefinition + CIFieldDefinition nodes
 * so the schema generator can build real GraphQL enums from their enum fields at runtime.
 *
 * Non-status enum fields are linked to their EnumTypeDefinition via USES_ENUM.
 * Status fields keep inline enum_values (they are workflow-driven).
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
import { runScript } from './lib/runScript.js'
// H-43: i workflow SPEDITI, per leggerne i nomi dei passi (vedi `stepNames`).
import { INCIDENT_WORKFLOW_BASE, INCIDENT_SECURITY_WORKFLOW, PROBLEM_WORKFLOW } from '@opengraphity/workflow'
import { CHANGE_RFC_WORKFLOW, SERVICE_REQUEST_WORKFLOW } from './lib/workflowDefinitions.js'

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
  /** Name of the EnumTypeDefinition to link via USES_ENUM (skips inline enum_values) */
  uses_enum?:   string
  order:        number
}

// ── ITIL type definitions ─────────────────────────────────────────────────────

interface ITILType {
  name:        string
  label:       string
  neo4j_label: string
  fields:      FieldDef[]
}

/**
 * Gli status del metamodello sono i PASSI del workflow spedito
 * (revisione totale · H-43).
 *
 * Erano quattro elenchi scritti a mano e nessuno coincideva col suo workflow:
 * l'incident aveva un `open` che nessun passo ha, la richiesta di servizio
 * diceva `open/in_progress/completed/cancelled` mentre il workflow fa
 * `submitted/approval/in_progress/fulfilled/closed/rejected`, la change
 * elencava dodici valori di un workflow che non esiste piu (`draft`,
 * `cab_approval`, `post_review`, …) e il problem dimenticava `known_error` e
 * aggiungeva `deferred`. Il campo `status` di un ticket lo scrive il motore
 * dei workflow: i valori ammessi sono i nomi dei suoi passi, e vanno letti da
 * li — una sorgente sola, che non si puo dimenticare di aggiornare.
 *
 * Un cliente che aggiunge un passo suo non deve tornare qui: questo e il
 * metamodello SPEDITO, cioe come nasce un tenant nuovo.
 */
function stepNames(...workflows: ReadonlyArray<{ steps: ReadonlyArray<{ name: string }> }>): string[] {
  const out: string[] = []
  for (const wf of workflows) {
    for (const step of wf.steps) if (!out.includes(step.name)) out.push(step.name)
  }
  return out
}

/** Esportato per il test del contratto status ↔ passi del workflow (H-43). */
export const ITIL_TYPES: ITILType[] = [
  {
    name: 'incident', label: 'Incident', neo4j_label: 'Incident',
    fields: [
      { name: 'title',       label: 'Title',        field_type: 'string', required: true,  order: 1 },
      { name: 'description', label: 'Description',   field_type: 'string', required: false, order: 2 },
      { name: 'status',      label: 'Status',         field_type: 'enum',   required: true,  order: 3,
        // Entrambi i workflow incident spediti (base e «Security»).
        enum_values: stepNames(INCIDENT_WORKFLOW_BASE, INCIDENT_SECURITY_WORKFLOW) },
      { name: 'severity',    label: 'Severity',      field_type: 'enum',   required: true,  order: 4,
        uses_enum: 'severity' },
      { name: 'category',    label: 'Category',     field_type: 'enum',   required: false, order: 5,
        uses_enum: 'category' },
      { name: 'root_cause',  label: 'Root Cause',    field_type: 'string', required: false, order: 6 },
      { name: 'created_at',  label: 'Created at',     field_type: 'date',   required: true,  order: 7 },
      { name: 'updated_at',  label: 'Updated at', field_type: 'date',   required: true,  order: 8 },
      { name: 'resolved_at', label: 'Resolved at',    field_type: 'date',   required: false, order: 9 },
      /*
       * ONDATA 2 (13 set 2026) — impatto, urgenza e priorità nel metamodello.
       *
       * Il nodo Incident LI HA e l'interfaccia li mostra, ma il metamodello no:
       * quindi trigger e business rule non li potevano nominare né nelle
       * condizioni né nelle azioni, e la tendina delle policy SLA cercava
       * `incident.priority` senza trovarlo. Scritto nel nodo da sempre, non
       * dichiarato da nessuna parte.
       *
       * `required: false` di proposito: `required` guida
       * `validateRequiredFields`, che gira anche sul percorso REST v1 —
       * marcarli obbligatori comincerebbe a rifiutare richieste che ieri
       * passavano. Qui il campo serve a essere NOMINABILE; chi deve esserci lo
       * impongono già il form e la matrice.
       *
       * In coda per non rinumerare i campi esistenti, il cui ordine decide la
       * disposizione nelle pagine che li rendono.
       */
      { name: 'impact',      label: 'Impact',       field_type: 'enum',   required: false, order: 10,
        uses_enum: 'impact' },
      { name: 'urgency',     label: 'Urgency',       field_type: 'enum',   required: false, order: 11,
        uses_enum: 'urgency' },
      { name: 'priority',    label: 'Priority',      field_type: 'enum',   required: false, order: 12,
        uses_enum: 'priority' },
    ],
  },
  {
    name: 'change', label: 'Change', neo4j_label: 'Change',
    fields: [
      { name: 'title',          label: 'Title',        field_type: 'string', required: true,  order: 1 },
      { name: 'description',    label: 'Description',   field_type: 'string', required: false, order: 2 },
      { name: 'status',         label: 'Status',         field_type: 'enum',   required: true,  order: 3,
        enum_values: stepNames(CHANGE_RFC_WORKFLOW) },
      { name: 'type',           label: 'Type',          field_type: 'enum',   required: true,  order: 4,
        uses_enum: 'change_type' },
      { name: 'priority',       label: 'Priority',      field_type: 'enum',   required: true,  order: 5,
        uses_enum: 'priority' },
      { name: 'risk',           label: 'Risk',       field_type: 'enum',   required: false, order: 6,
        uses_enum: 'risk' },
      { name: 'impact',         label: 'Impact',       field_type: 'enum',   required: false, order: 7,
        uses_enum: 'impact' },
      { name: 'scheduled_start',label: 'Scheduled start', field_type: 'date',   required: false, order: 8 },
      { name: 'scheduled_end',  label: 'Scheduled end',  field_type: 'date',   required: false, order: 9 },
      { name: 'created_at',     label: 'Created at',     field_type: 'date',   required: true,  order: 10 },
      { name: 'updated_at',     label: 'Updated at', field_type: 'date',   required: true,  order: 11 },
    ],
  },
  {
    name: 'problem', label: 'Problem', neo4j_label: 'Problem',
    fields: [
      { name: 'title',       label: 'Title',        field_type: 'string', required: true,  order: 1 },
      { name: 'description', label: 'Description',   field_type: 'string', required: false, order: 2 },
      { name: 'status',      label: 'Status',         field_type: 'enum',   required: true,  order: 3,
        enum_values: stepNames(PROBLEM_WORKFLOW) },
      { name: 'priority',    label: 'Priority',      field_type: 'enum',   required: true,  order: 4,
        uses_enum: 'priority' },
      { name: 'category',    label: 'Category',     field_type: 'enum',   required: false, order: 5,
        uses_enum: 'category' },
      { name: 'root_cause',  label: 'Root Cause',    field_type: 'string', required: false, order: 6 },
      { name: 'workaround',  label: 'Workaround',    field_type: 'string', required: false, order: 7 },
      { name: 'created_at',  label: 'Created at',     field_type: 'date',   required: true,  order: 8 },
      { name: 'updated_at',  label: 'Updated at', field_type: 'date',   required: true,  order: 9 },
      // Ondata 2: il problem ha già `priority`, ma non impatto e urgenza — e il
      // suo form li scrive (priorità = impatto × urgenza, come per l'incident).
      { name: 'impact',      label: 'Impact',       field_type: 'enum',   required: false, order: 10,
        uses_enum: 'impact' },
      { name: 'urgency',     label: 'Urgency',       field_type: 'enum',   required: false, order: 11,
        uses_enum: 'urgency' },
    ],
  },
  {
    name: 'service_request', label: 'Service Request', neo4j_label: 'ServiceRequest',
    fields: [
      { name: 'title',       label: 'Title',        field_type: 'string', required: true,  order: 1 },
      { name: 'description', label: 'Description',   field_type: 'string', required: false, order: 2 },
      { name: 'status',      label: 'Status',         field_type: 'enum',   required: true,  order: 3,
        enum_values: stepNames(SERVICE_REQUEST_WORKFLOW) },
      { name: 'priority',    label: 'Priority',      field_type: 'enum',   required: true,  order: 4,
        uses_enum: 'priority' },
      { name: 'category',    label: 'Category',     field_type: 'enum',   required: false, order: 5,
        uses_enum: 'category' },
      { name: 'created_at',  label: 'Created at',     field_type: 'date',   required: true,  order: 6 },
      { name: 'updated_at',  label: 'Updated at', field_type: 'date',   required: true,  order: 7 },
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

    // Fields with uses_enum get null enum_values (values come from the linked EnumTypeDefinition)
    const enumValues = f.uses_enum ? null : (f.enum_values ? JSON.stringify(f.enum_values) : null)

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
          enumValues,
          order:      f.order,
          now,
        },
      ),
    )

    // Aggancio a EnumTypeDefinition via USES_ENUM quando c'è `uses_enum`.
    //
    // A-2 / C-6: il vocabolario deve essere quello SPEDITO
    // (`tenant_id = 'system'`). Il `MATCH (e {name: $enumName})` di prima —
    // «pick any available instance» — è la riga che ha agganciato i 30 campi
    // condivisi alle copie di c-one, cioè che ha fatto vedere a ogni altro
    // cliente i valori di c-one. Se il vocabolario di sistema non c'è, ci si
    // ferma: `seed-enum-types.ts` lo semina.
    if (f.uses_enum) {
      const linked = await session.executeWrite(tx =>
        tx.run(
          `MATCH (f:CIFieldDefinition {name: $fieldName, tenant_id: $tenantId})
                 -[:BELONGS_TO]->(t:CITypeDefinition {name: $typeName, tenant_id: $tenantId})
           MATCH (e:EnumTypeDefinition {name: $enumName, tenant_id: 'system'})
           MERGE (f)-[:USES_ENUM]->(e)
           RETURN e.id AS id`,
          {
            fieldName: f.name,
            typeName:  itil.name,
            tenantId:  TENANT_ID,
            enumName:  f.uses_enum,
          },
        ),
      )
      if (!linked.records.length) {
        throw new Error(
          `${itil.name}.${f.name}: nessun vocabolario spedito "${f.uses_enum}" ` +
          `(EnumTypeDefinition {name: "${f.uses_enum}", tenant_id: "system"}). ` +
          `Esegui prima scripts/seed-enum-types.ts.`,
        )
      }
    }
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
      const enumLinked = itil.fields.filter(f => f.uses_enum).length
      console.log(`✓ ${itil.label}: ${itil.fields.length} fields (${enumLinked} enum-linked)`)
    }

    console.log('\n── ITIL metamodello creato ─────────────────────────────')
    console.log(`  Tipi: ${ITIL_TYPES.length} (${ITIL_TYPES.map(t => t.label).join(', ')})`)
    console.log(`  Scope: itil | tenant_id: ${TENANT_ID}`)
  } finally {
    // Mai `process.exit(0)` qui (revisione totale · H-9): il `finally` gira
    // anche quando il `try` lancia, e terminava il processo con esito 0 prima
    // che il `.catch` potesse stampare l'errore e uscire 1 — in una pipeline
    // di onboarding un metamodello rimasto a metà passava per riuscito.
    await session.close()
  }
}

// H-45: il runner uniforme — errore intero, exit code 1, driver Neo4j chiuso.
runScript('seed-itil-metamodel', main)
