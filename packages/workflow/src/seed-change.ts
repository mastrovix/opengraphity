import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'
import type { WorkflowDefinition } from './types.js'

// ── Standard Change ───────────────────────────────────────────────────────────

export const STANDARD_CHANGE_WORKFLOW: Omit<WorkflowDefinition, 'id' | 'tenantId'> = {
  name:          'Standard Change',
  entityType:    'change',
  changeSubtype: 'standard',
  version:       1,
  active:        true,
  steps: [
    { id: 'step-std-draft',      name: 'draft',      label: 'Bozza',       type: 'start',    enterActions: [], exitActions: [] },
    { id: 'step-std-approved',   name: 'approved',   label: 'Approvato',   type: 'standard', enterActions: [], exitActions: [] },
    { id: 'step-std-scheduled',  name: 'scheduled',  label: 'Schedulato',  type: 'standard', enterActions: [], exitActions: [] },
    { id: 'step-std-validation', name: 'validation', label: 'Validazione', type: 'standard', enterActions: [], exitActions: [] },
    { id: 'step-std-deployment', name: 'deployment', label: 'Deployment',  type: 'standard', enterActions: [], exitActions: [] },
    { id: 'step-std-completed',  name: 'completed',  label: 'Completato',  type: 'end',      enterActions: [], exitActions: [] },
    { id: 'step-std-failed',     name: 'failed',     label: 'Fallito',     type: 'end',      enterActions: [], exitActions: [] },
  ],
  transitions: [
    { id: 'tr-std-draft-approved',        fromStepName: 'draft',      toStepName: 'approved',   trigger: 'automatic', label: 'Auto-approvato',    condition: null, requiresInput: false, inputField: null },
    { id: 'tr-std-approved-scheduled',    fromStepName: 'approved',   toStepName: 'scheduled',  trigger: 'manual',    label: 'Schedula',          condition: null, requiresInput: true,  inputField: 'scheduled_start' },
    { id: 'tr-std-scheduled-validation',  fromStepName: 'scheduled',  toStepName: 'validation', trigger: 'manual',    label: 'Avvia validazione', condition: null, requiresInput: false, inputField: null },
    { id: 'tr-std-validation-deployment', fromStepName: 'validation', toStepName: 'deployment', trigger: 'manual',    label: 'Avvia deployment',  condition: null, requiresInput: true,  inputField: 'validation_notes' },
    { id: 'tr-std-deployment-completed',  fromStepName: 'deployment', toStepName: 'completed',  trigger: 'manual',    label: 'Completa',          condition: null, requiresInput: true,  inputField: 'notes' },
    { id: 'tr-std-deployment-failed',     fromStepName: 'deployment', toStepName: 'failed',     trigger: 'manual',    label: 'Segna fallito',     condition: null, requiresInput: true,  inputField: 'failure_reason' },
  ],
}

// ── Normal Change ─────────────────────────────────────────────────────────────

export const NORMAL_CHANGE_WORKFLOW: Omit<WorkflowDefinition, 'id' | 'tenantId'> = {
  name:          'Normal Change',
  entityType:    'change',
  changeSubtype: 'normal',
  version:       1,
  active:        true,
  steps: [
    { id: 'step-nrm-draft',        name: 'draft',        label: 'Bozza',            type: 'start',    enterActions: [], exitActions: [] },
    { id: 'step-nrm-assessment',   name: 'assessment',   label: 'Assessment',       type: 'standard', enterActions: [], exitActions: [] },
    { id: 'step-nrm-cab_approval', name: 'cab_approval', label: 'Approvazione CAB', type: 'standard', enterActions: [], exitActions: [] },
    { id: 'step-nrm-scheduled',    name: 'scheduled',    label: 'Schedulato',       type: 'standard', enterActions: [], exitActions: [] },
    { id: 'step-nrm-validation',   name: 'validation',   label: 'Validazione',      type: 'standard', enterActions: [], exitActions: [] },
    { id: 'step-nrm-deployment',   name: 'deployment',   label: 'Deployment',       type: 'standard', enterActions: [], exitActions: [] },
    { id: 'step-nrm-completed',    name: 'completed',    label: 'Completato',       type: 'end',      enterActions: [], exitActions: [] },
    { id: 'step-nrm-failed',       name: 'failed',       label: 'Fallito',          type: 'end',      enterActions: [], exitActions: [] },
    { id: 'step-nrm-rejected',     name: 'rejected',     label: 'Rigettato',        type: 'end',      enterActions: [], exitActions: [] },
  ],
  transitions: [
    { id: 'tr-nrm-draft-assessment',      fromStepName: 'draft',        toStepName: 'assessment',   trigger: 'manual', label: 'Invia per assessment', condition: null,                             requiresInput: false, inputField: null },
    { id: 'tr-nrm-assessment-cab',        fromStepName: 'assessment',   toStepName: 'cab_approval', trigger: 'manual', label: 'Invia al CAB',         condition: 'all_assessment_tasks_completed', requiresInput: true,  inputField: 'assessment_notes' },
    { id: 'tr-nrm-assessment-rejected',   fromStepName: 'assessment',   toStepName: 'rejected',     trigger: 'manual', label: 'Rigetta',              condition: null,                             requiresInput: true,  inputField: 'rejection_reason' },
    { id: 'tr-nrm-cab-scheduled',         fromStepName: 'cab_approval', toStepName: 'scheduled',    trigger: 'manual', label: 'Approva (CAB)',        condition: null,                             requiresInput: true,  inputField: 'cab_notes' },
    { id: 'tr-nrm-cab-rejected',          fromStepName: 'cab_approval', toStepName: 'rejected',     trigger: 'manual', label: 'Rigetta (CAB)',        condition: null,                             requiresInput: true,  inputField: 'rejection_reason' },
    { id: 'tr-nrm-scheduled-validation',  fromStepName: 'scheduled',    toStepName: 'validation',   trigger: 'manual', label: 'Avvia validazione',    condition: null,                             requiresInput: false, inputField: null },
    { id: 'tr-nrm-validation-deployment', fromStepName: 'validation',   toStepName: 'deployment',   trigger: 'manual', label: 'Avvia deployment',     condition: null,                             requiresInput: true,  inputField: 'validation_notes' },
    { id: 'tr-nrm-deployment-completed',  fromStepName: 'deployment',   toStepName: 'completed',    trigger: 'manual', label: 'Completa',             condition: 'all_deploy_steps_completed',     requiresInput: true,  inputField: 'notes' },
    { id: 'tr-nrm-deployment-failed',     fromStepName: 'deployment',   toStepName: 'failed',       trigger: 'manual', label: 'Segna fallito',        condition: null,                             requiresInput: true,  inputField: 'failure_reason' },
    { id: 'tr-nrm-rejected-draft',        fromStepName: 'rejected',     toStepName: 'draft',        trigger: 'manual', label: 'Riapri in bozza',      condition: null,                             requiresInput: false, inputField: null },
  ],
}

// ── Emergency Change ──────────────────────────────────────────────────────────

export const EMERGENCY_CHANGE_WORKFLOW: Omit<WorkflowDefinition, 'id' | 'tenantId'> = {
  name:          'Emergency Change',
  entityType:    'change',
  changeSubtype: 'emergency',
  version:       1,
  active:        true,
  steps: [
    { id: 'step-emg-draft',              name: 'draft',              label: 'Bozza',                    type: 'start',    enterActions: [], exitActions: [] },
    { id: 'step-emg-emergency_approval', name: 'emergency_approval', label: 'Approvazione Emergency',   type: 'standard', enterActions: [], exitActions: [] },
    { id: 'step-emg-validation',         name: 'validation',         label: 'Validazione',              type: 'standard', enterActions: [], exitActions: [] },
    { id: 'step-emg-deployment',         name: 'deployment',         label: 'Deployment',               type: 'standard', enterActions: [], exitActions: [] },
    { id: 'step-emg-completed',          name: 'completed',          label: 'Completato',               type: 'end',      enterActions: [], exitActions: [] },
    { id: 'step-emg-failed',             name: 'failed',             label: 'Fallito',                  type: 'end',      enterActions: [], exitActions: [] },
    { id: 'step-emg-post_review',        name: 'post_review',        label: 'Post Review',              type: 'end',      enterActions: [], exitActions: [] },
    { id: 'step-emg-rejected',           name: 'rejected',           label: 'Rigettato',                type: 'end',      enterActions: [], exitActions: [] },
  ],
  transitions: [
    { id: 'tr-emg-draft-approval',        fromStepName: 'draft',              toStepName: 'emergency_approval', trigger: 'manual', label: 'Richiedi approvazione emergency', condition: null, requiresInput: false, inputField: null },
    { id: 'tr-emg-approval-validation',   fromStepName: 'emergency_approval', toStepName: 'validation',         trigger: 'manual', label: 'Approva (Emergency)',             condition: null, requiresInput: true,  inputField: 'approval_notes' },
    { id: 'tr-emg-approval-rejected',     fromStepName: 'emergency_approval', toStepName: 'rejected',           trigger: 'manual', label: 'Rigetta',                         condition: null, requiresInput: true,  inputField: 'rejection_reason' },
    { id: 'tr-emg-validation-deployment', fromStepName: 'validation',         toStepName: 'deployment',         trigger: 'manual', label: 'Avvia deployment',                condition: null, requiresInput: true,  inputField: 'validation_notes' },
    { id: 'tr-emg-deployment-completed',  fromStepName: 'deployment',         toStepName: 'completed',          trigger: 'manual', label: 'Completa',                        condition: null, requiresInput: true,  inputField: 'notes' },
    { id: 'tr-emg-deployment-failed',     fromStepName: 'deployment',         toStepName: 'failed',             trigger: 'manual', label: 'Segna fallito',                   condition: null, requiresInput: true,  inputField: 'failure_reason' },
    { id: 'tr-emg-failed-postreview',     fromStepName: 'failed',             toStepName: 'post_review',        trigger: 'manual', label: 'Avvia post review',               condition: null, requiresInput: false, inputField: null },
    { id: 'tr-emg-rejected-draft',        fromStepName: 'rejected',           toStepName: 'draft',              trigger: 'manual', label: 'Riapri in bozza',                 condition: null, requiresInput: false, inputField: null },
  ],
}

// ── Seed helper ───────────────────────────────────────────────────────────────

async function seedOne(
  tenantId: string,
  def: Omit<WorkflowDefinition, 'id' | 'tenantId'>,
): Promise<string> {
  const session = getSession(undefined, 'WRITE')
  const defId   = uuidv4()
  const now     = new Date().toISOString()

  try {
    await session.executeWrite(async (tx) => {
      // 1. MERGE WorkflowDefinition (idempotente per tenant+name)
      await tx.run(`
        MERGE (wd:WorkflowDefinition {tenant_id: $tenantId, name: $name})
        ON CREATE SET
          wd.id             = $id,
          wd.entity_type    = $entityType,
          wd.change_subtype = $changeSubtype,
          wd.version        = $version,
          wd.active         = $active,
          wd.created_at     = $now,
          wd.updated_at     = $now
        ON MATCH SET
          wd.change_subtype = $changeSubtype,
          wd.updated_at     = $now
        WITH wd
        // Rimuovi step e transizioni esistenti per ricrearli freschi
        OPTIONAL MATCH (wd)-[:HAS_STEP]->(s:WorkflowStep)
        DETACH DELETE s
      `, { id: defId, tenantId, name: def.name, entityType: def.entityType, changeSubtype: def.changeSubtype ?? null, version: def.version, active: def.active, now })

      // Recupera l'id effettivo (potrebbe essere già esistente)
      const res = await tx.run(
        `MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, name: $name}) RETURN wd.id AS id`,
        { tenantId, name: def.name },
      )
      const actualDefId = res.records[0]?.get('id') as string ?? defId

      // 2. Crea WorkflowStep
      for (const step of def.steps) {
        await tx.run(`
          MATCH (wd:WorkflowDefinition {id: $defId})
          CREATE (s:WorkflowStep {
            id:            $id,
            tenant_id:     $tenantId,
            definition_id: $defId,
            name:          $name,
            label:         $label,
            type:          $type,
            enter_actions: $enterActions,
            exit_actions:  $exitActions
          })
          CREATE (wd)-[:HAS_STEP]->(s)
        `, {
          defId:        actualDefId,
          tenantId,
          id:           `${tenantId}-${step.id}`,
          name:         step.name,
          label:        step.label,
          type:         step.type,
          enterActions: JSON.stringify(step.enterActions),
          exitActions:  JSON.stringify(step.exitActions),
        })
      }

      // 3. Crea TRANSITIONS_TO
      for (const tr of def.transitions) {
        await tx.run(`
          MATCH (from:WorkflowStep {name: $fromName, definition_id: $defId})
          MATCH (to:WorkflowStep   {name: $toName,   definition_id: $defId})
          CREATE (from)-[:TRANSITIONS_TO {
            id:             $id,
            trigger:        $trigger,
            label:          $label,
            condition:      $condition,
            requires_input: $requiresInput,
            input_field:    $inputField
          }]->(to)
        `, {
          defId:         actualDefId,
          fromName:      tr.fromStepName,
          toName:        tr.toStepName,
          id:            `${tenantId}-${tr.id}`,
          trigger:       tr.trigger,
          label:         tr.label,
          condition:     tr.condition,
          requiresInput: tr.requiresInput,
          inputField:    tr.inputField,
        })
      }

      console.log(`[workflow] Seeded "${def.name}" for tenant "${tenantId}": defId=${actualDefId}`)
    })
  } finally {
    await session.close()
  }

  return defId
}

export async function seedChangeWorkflows(tenantId: string): Promise<void> {
  await seedOne(tenantId, STANDARD_CHANGE_WORKFLOW)
  await seedOne(tenantId, NORMAL_CHANGE_WORKFLOW)
  await seedOne(tenantId, EMERGENCY_CHANGE_WORKFLOW)
}
