/**
 * Seed field visibility and requirement rules for the c-one tenant.
 *
 * Usage:
 *   pnpm tsx apps/api/src/scripts/seed-field-rules.ts [--tenant-id <uuid>]
 *
 * If --tenant-id is not provided, looks up the first tenant with slug "c-one".
 */

import { parseArgs } from 'node:util'
import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'

const { values: args } = parseArgs({
  options: { 'tenant-id': { type: 'string' } },
})

async function resolveTenantId(provided?: string): Promise<string> {
  if (provided) return provided
  const session = getSession()
  try {
    const res = await session.executeRead((tx) =>
      tx.run(`MATCH (t:Tenant {slug: 'c-one'}) RETURN t.id AS id LIMIT 1`),
    )
    const id = res.records[0]?.get('id') as string | null
    if (!id) throw new Error('Tenant "c-one" not found. Pass --tenant-id explicitly.')
    return id
  } finally {
    await session.close()
  }
}

interface VisibilityRule {
  entityType:   string
  triggerField: string
  triggerValue: string
  targetField:  string
  action:       'show' | 'hide'
}

interface RequirementRule {
  entityType:   string
  fieldName:    string
  required:     boolean
  workflowStep: string | null
}

const VISIBILITY_RULES: VisibilityRule[] = [
  // When incident category = "hardware" → show "device_model"
  {
    entityType:   'incident',
    triggerField: 'category',
    triggerValue: 'hardware',
    targetField:  'device_model',
    action:       'show',
  },
]

const REQUIREMENT_RULES: RequirementRule[] = [
  // Incident: assigned_to required for step "in_progress"
  { entityType: 'incident', fieldName: 'assigned_to',      required: true, workflowStep: 'in_progress' },
  // Incident: resolution_notes required for step "resolved"
  { entityType: 'incident', fieldName: 'resolution_notes', required: true, workflowStep: 'resolved' },
  // Change: risk_assessment required for step "assessment"
  { entityType: 'change',   fieldName: 'risk_assessment',  required: true, workflowStep: 'assessment' },
]

async function seedVisibilityRule(tenantId: string, rule: VisibilityRule): Promise<void> {
  const session = getSession(undefined, 'WRITE')
  try {
    const existing = await session.executeRead((tx) =>
      tx.run(`
        MATCH (r:FieldVisibilityRule {
          tenant_id:     $tenantId,
          entity_type:   $entityType,
          trigger_field: $triggerField,
          trigger_value: $triggerValue,
          target_field:  $targetField
        }) RETURN r.id AS id LIMIT 1
      `, { tenantId, ...rule }),
    )
    if (existing.records.length > 0) {
      process.stdout.write(`  ↩ VisibilityRule ${rule.entityType}:${rule.triggerField}=${rule.triggerValue}→${rule.action} ${rule.targetField} — già esistente\n`)
      return
    }
    const id  = uuidv4()
    const now = new Date().toISOString()
    await session.executeWrite((tx) =>
      tx.run(`
        CREATE (:FieldVisibilityRule {
          id:            $id,
          tenant_id:     $tenantId,
          entity_type:   $entityType,
          trigger_field: $triggerField,
          trigger_value: $triggerValue,
          target_field:  $targetField,
          action:        $action,
          created_at:    $now,
          updated_at:    $now
        })
      `, { id, tenantId, now, ...rule }),
    )
    process.stdout.write(`  ✓ VisibilityRule ${rule.entityType}:${rule.triggerField}=${rule.triggerValue}→${rule.action} ${rule.targetField}\n`)
  } finally {
    await session.close()
  }
}

async function seedRequirementRule(tenantId: string, rule: RequirementRule): Promise<void> {
  const session = getSession(undefined, 'WRITE')
  try {
    const existing = await session.executeRead((tx) =>
      tx.run(`
        MATCH (r:FieldRequirementRule {
          tenant_id:     $tenantId,
          entity_type:   $entityType,
          field_name:    $fieldName,
          workflow_step: $workflowStep
        }) RETURN r.id AS id LIMIT 1
      `, { tenantId, entityType: rule.entityType, fieldName: rule.fieldName, workflowStep: rule.workflowStep }),
    )
    if (existing.records.length > 0) {
      process.stdout.write(`  ↩ RequirementRule ${rule.entityType}:${rule.fieldName}@${rule.workflowStep ?? 'all'} — già esistente\n`)
      return
    }
    const id  = uuidv4()
    const now = new Date().toISOString()
    await session.executeWrite((tx) =>
      tx.run(`
        CREATE (:FieldRequirementRule {
          id:            $id,
          tenant_id:     $tenantId,
          entity_type:   $entityType,
          field_name:    $fieldName,
          required:      $required,
          workflow_step: $workflowStep,
          created_at:    $now,
          updated_at:    $now
        })
      `, { id, tenantId, now, ...rule }),
    )
    process.stdout.write(`  ✓ RequirementRule ${rule.entityType}:${rule.fieldName}@${rule.workflowStep ?? 'all'} required=${rule.required}\n`)
  } finally {
    await session.close()
  }
}

async function main() {
  const tenantId = await resolveTenantId(args['tenant-id'])
  process.stdout.write(`Seeding field rules for tenant ${tenantId}…\n\n`)

  for (const rule of VISIBILITY_RULES) {
    await seedVisibilityRule(tenantId, rule)
  }
  for (const rule of REQUIREMENT_RULES) {
    await seedRequirementRule(tenantId, rule)
  }

  process.stdout.write('\nDone.\n')
  process.exit(0)
}

main().catch((err) => {
  process.stderr.write(`Error: ${(err as Error).message}\n`)
  process.exit(1)
})
