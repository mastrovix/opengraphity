import { fileURLToPath } from 'node:url'
import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'
import type { WorkflowDefinition } from './types.js'

export const INCIDENT_WORKFLOW_BASE: Omit<WorkflowDefinition, 'id' | 'tenantId'> = {
  name:       'Incident Management',
  entityType: 'incident',
  version:    1,
  active:     true,
  steps: [
    {
      id:           'step-new',
      name:         'new',
      label:        'Nuovo',
      type:         'start',
      enterActions: [],
      exitActions:  [],
    },
    {
      id:    'step-assigned',
      name:  'assigned',
      label: 'Assegnato',
      type:  'standard',
      enterActions: [
        { type: 'sla_start', params: { sla_type: 'response' } },
      ],
      exitActions: [],
    },
    {
      id:    'step-in_progress',
      name:  'in_progress',
      label: 'In Lavorazione',
      type:  'standard',
      enterActions: [
        { type: 'sla_stop',  params: { sla_type: 'response' } },
        { type: 'sla_start', params: { sla_type: 'resolve' } },
      ],
      exitActions: [],
    },
    {
      id:    'step-pending',
      name:  'pending',
      label: 'In Attesa',
      type:  'standard',
      enterActions: [
        { type: 'sla_pause', params: { sla_type: 'resolve' } },
      ],
      exitActions: [
        { type: 'sla_resume', params: { sla_type: 'resolve' } },
      ],
    },
    {
      id:    'step-escalated',
      name:  'escalated',
      label: 'Escalato',
      type:  'standard',
      enterActions: [],
      exitActions: [],
    },
    {
      id:    'step-resolved',
      name:  'resolved',
      label: 'Risolto',
      type:  'standard',
      enterActions: [
        { type: 'sla_stop',     params: { sla_type: 'resolve' } },
        { type: 'schedule_job', params: { job: 'auto_close', delay_hours: '72' } },
      ],
      exitActions: [
        { type: 'cancel_job', params: { job: 'auto_close' } },
      ],
    },
    {
      id:    'step-closed',
      name:  'closed',
      label: 'Chiuso',
      type:  'end',
      enterActions: [],
      exitActions: [],
    },
  ],
  transitions: [
    {
      id:            'tr-new-assigned',
      fromStepName:  'new',
      toStepName:    'assigned',
      trigger:       'manual',
      label:         'Assegna',
      condition:     null,
      requiresInput: false,
      inputField:    null,
    },
    {
      id:            'tr-assigned-inprogress',
      fromStepName:  'assigned',
      toStepName:    'in_progress',
      trigger:       'manual',
      label:         'Prendi in carico',
      condition:     null,
      requiresInput: false,
      inputField:    null,
    },
    {
      id:            'tr-inprogress-pending',
      fromStepName:  'in_progress',
      toStepName:    'pending',
      trigger:       'manual',
      label:         'Metti in attesa',
      condition:     null,
      requiresInput: true,
      inputField:    'notes',
    },
    {
      id:            'tr-pending-inprogress',
      fromStepName:  'pending',
      toStepName:    'in_progress',
      trigger:       'manual',
      label:         'Riprendi',
      condition:     null,
      requiresInput: false,
      inputField:    null,
    },
    {
      id:            'tr-inprogress-escalated',
      fromStepName:  'in_progress',
      toStepName:    'escalated',
      trigger:       'manual',
      label:         'Escalate',
      condition:     null,
      requiresInput: false,
      inputField:    null,
    },
    {
      id:            'tr-sla-escalated',
      fromStepName:  'in_progress',
      toStepName:    'escalated',
      trigger:       'sla_breach',
      label:         'Escalate automatico (SLA)',
      condition:     null,
      requiresInput: false,
      inputField:    null,
    },
    {
      id:            'tr-escalated-inprogress',
      fromStepName:  'escalated',
      toStepName:    'in_progress',
      trigger:       'manual',
      label:         'Torna in lavorazione',
      condition:     null,
      requiresInput: false,
      inputField:    null,
    },
    {
      id:            'tr-inprogress-resolved',
      fromStepName:  'in_progress',
      toStepName:    'resolved',
      trigger:       'manual',
      label:         'Risolvi',
      condition:     'rootCause != null',
      requiresInput: true,
      inputField:    'rootCause',
    },
    {
      id:            'tr-escalated-resolved',
      fromStepName:  'escalated',
      toStepName:    'resolved',
      trigger:       'manual',
      label:         'Risolvi',
      condition:     'rootCause != null',
      requiresInput: true,
      inputField:    'rootCause',
    },
    {
      id:            'tr-resolved-closed',
      fromStepName:  'resolved',
      toStepName:    'closed',
      trigger:       'timer',
      label:         'Chiudi automaticamente',
      condition:     null,
      requiresInput: false,
      inputField:    null,
    },
    {
      id:            'tr-resolved-inprogress',
      fromStepName:  'resolved',
      toStepName:    'in_progress',
      trigger:       'manual',
      label:         'Riapri',
      condition:     null,
      requiresInput: true,
      inputField:    'notes',
    },
  ],
}

// ── Security Incident Workflow ────────────────────────────────────────────────

export const INCIDENT_SECURITY_WORKFLOW: Omit<WorkflowDefinition, 'id' | 'tenantId'> & { category: string } = {
  name:       'Incident — Security',
  entityType: 'incident',
  category:   'security',
  version:    1,
  active:     true,
  steps: [
    { id: 'step-new',             name: 'new',             label: 'Nuovo',           type: 'start',    enterActions: [], exitActions: [] },
    { id: 'step-assigned',        name: 'assigned',        label: 'Assegnato',       type: 'standard', enterActions: [{ type: 'sla_start', params: { sla_type: 'response' } }], exitActions: [] },
    { id: 'step-security_review', name: 'security_review', label: 'Security Review', type: 'standard', enterActions: [{ type: 'publish_event', params: { event: 'incident.security_review' } }], exitActions: [] },
    { id: 'step-in_progress',     name: 'in_progress',     label: 'In Lavorazione',  type: 'standard', enterActions: [{ type: 'sla_stop', params: { sla_type: 'response' } }, { type: 'sla_start', params: { sla_type: 'resolve' } }], exitActions: [] },
    { id: 'step-pending',         name: 'pending',         label: 'In Attesa',       type: 'standard', enterActions: [{ type: 'sla_pause', params: { sla_type: 'resolve' } }], exitActions: [{ type: 'sla_resume', params: { sla_type: 'resolve' } }] },
    { id: 'step-escalated',       name: 'escalated',       label: 'Escalato',        type: 'standard', enterActions: [], exitActions: [] },
    { id: 'step-resolved',        name: 'resolved',        label: 'Risolto',         type: 'standard', enterActions: [{ type: 'sla_stop', params: { sla_type: 'resolve' } }, { type: 'schedule_job', params: { job: 'auto_close', delay_hours: '72' } }], exitActions: [{ type: 'cancel_job', params: { job: 'auto_close' } }] },
    { id: 'step-closed',          name: 'closed',          label: 'Chiuso',          type: 'end',      enterActions: [], exitActions: [] },
  ],
  transitions: [
    { id: 'tr-new-assigned',           fromStepName: 'new',             toStepName: 'assigned',        trigger: 'manual',     label: 'Assegna',                    condition: null, requiresInput: false, inputField: null },
    { id: 'tr-assigned-security',      fromStepName: 'assigned',        toStepName: 'security_review', trigger: 'manual',     label: 'Avvia security review',      condition: null, requiresInput: false, inputField: null },
    { id: 'tr-security-inprogress',    fromStepName: 'security_review', toStepName: 'in_progress',     trigger: 'manual',     label: 'Approva review',             condition: null, requiresInput: false, inputField: null },
    { id: 'tr-security-assigned',      fromStepName: 'security_review', toStepName: 'assigned',        trigger: 'manual',     label: 'Rigetta (riassegna)',         condition: null, requiresInput: true,  inputField: 'notes' },
    { id: 'tr-inprogress-pending',     fromStepName: 'in_progress',     toStepName: 'pending',         trigger: 'manual',     label: 'Metti in attesa',            condition: null, requiresInput: true,  inputField: 'notes' },
    { id: 'tr-pending-inprogress',     fromStepName: 'pending',         toStepName: 'in_progress',     trigger: 'manual',     label: 'Riprendi',                   condition: null, requiresInput: false, inputField: null },
    { id: 'tr-inprogress-escalated',   fromStepName: 'in_progress',     toStepName: 'escalated',       trigger: 'manual',     label: 'Escalate',                   condition: null, requiresInput: false, inputField: null },
    { id: 'tr-sla-escalated',          fromStepName: 'in_progress',     toStepName: 'escalated',       trigger: 'sla_breach', label: 'Escalate automatico (SLA)',   condition: null, requiresInput: false, inputField: null },
    { id: 'tr-escalated-inprogress',   fromStepName: 'escalated',       toStepName: 'in_progress',     trigger: 'manual',     label: 'Torna in lavorazione',       condition: null, requiresInput: false, inputField: null },
    { id: 'tr-inprogress-resolved',    fromStepName: 'in_progress',     toStepName: 'resolved',        trigger: 'manual',     label: 'Risolvi',                    condition: 'rootCause != null', requiresInput: true, inputField: 'rootCause' },
    { id: 'tr-escalated-resolved',     fromStepName: 'escalated',       toStepName: 'resolved',        trigger: 'manual',     label: 'Risolvi',                    condition: 'rootCause != null', requiresInput: true, inputField: 'rootCause' },
    { id: 'tr-resolved-closed',        fromStepName: 'resolved',        toStepName: 'closed',          trigger: 'timer',      label: 'Chiudi automaticamente',     condition: null, requiresInput: false, inputField: null },
    { id: 'tr-resolved-inprogress',    fromStepName: 'resolved',        toStepName: 'in_progress',     trigger: 'manual',     label: 'Riapri',                     condition: null, requiresInput: true,  inputField: 'notes' },
  ],
}

// ── Seed functions ───────────────────────────────────────────────────────────

async function seedWorkflowDefinition(
  tenantId: string,
  wfDef: Omit<WorkflowDefinition, 'id' | 'tenantId'> & { category?: string },
): Promise<string> {
  const session = getSession(undefined, 'WRITE')
  const defId   = uuidv4()
  const now     = new Date().toISOString()

  try {
    await session.executeWrite(async (tx) => {
      await tx.run(`
        CREATE (wd:WorkflowDefinition {
          id:          $id,
          tenant_id:   $tenantId,
          name:        $name,
          entity_type: $entityType,
          category:    $category,
          version:     $version,
          active:      $active,
          created_at:  $now,
          updated_at:  $now
        })
      `, {
        id: defId, tenantId,
        name: wfDef.name, entityType: wfDef.entityType,
        category: wfDef.category ?? null,
        version: wfDef.version, active: wfDef.active, now,
      })

      for (const step of wfDef.steps) {
        await tx.run(`
          MATCH (wd:WorkflowDefinition {id: $defId})
          CREATE (s:WorkflowStep {
            id: $id, tenant_id: $tenantId, definition_id: $defId,
            name: $name, label: $label, type: $type,
            enter_actions: $enterActions, exit_actions: $exitActions
          })
          CREATE (wd)-[:HAS_STEP]->(s)
        `, {
          defId, tenantId,
          id: `${tenantId}-${step.id}`, name: step.name, label: step.label, type: step.type,
          enterActions: JSON.stringify(step.enterActions), exitActions: JSON.stringify(step.exitActions),
        })
      }

      for (const tr of wfDef.transitions) {
        await tx.run(`
          MATCH (from:WorkflowStep {name: $fromName, definition_id: $defId})
          MATCH (to:WorkflowStep   {name: $toName,   definition_id: $defId})
          CREATE (from)-[:TRANSITIONS_TO {
            id: $id, trigger: $trigger, label: $label, condition: $condition,
            requires_input: $requiresInput, input_field: $inputField
          }]->(to)
        `, {
          defId, fromName: tr.fromStepName, toName: tr.toStepName,
          id: `${tenantId}-${tr.id}`, trigger: tr.trigger, label: tr.label,
          condition: tr.condition, requiresInput: tr.requiresInput, inputField: tr.inputField,
        })
      }
    })

    console.log(`[workflow] Seeded "${wfDef.name}" for tenant "${tenantId}": definitionId=${defId}`)
    return defId
  } finally {
    await session.close()
  }
}

export async function seedWorkflowForTenant(tenantId: string): Promise<string> {
  const defId = await seedWorkflowDefinition(tenantId, INCIDENT_WORKFLOW_BASE)
  // Also seed the security variant
  await seedWorkflowDefinition(tenantId, INCIDENT_SECURITY_WORKFLOW)
  return defId
}

// Eseguibile standalone: pnpm --filter @opengraphity/workflow run seed
const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  seedWorkflowForTenant('c-one')
    .then(() => process.exit(0))
    .catch((e: unknown) => { console.error(e); process.exit(1) })
}
