import { fileURLToPath } from 'node:url'
import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'
import type { WorkflowDefinition } from './types.js'

export const PROBLEM_WORKFLOW: Omit<WorkflowDefinition, 'id' | 'tenantId'> = {
  name:       'Problem Management',
  entityType: 'problem',
  version:    1,
  active:     true,
  steps: [
    { id: 'step-prb-new',                name: 'new',                label: 'Nuovo',                  type: 'start',    enterActions: [], exitActions: [] },
    { id: 'step-prb-under_investigation', name: 'under_investigation', label: 'In Analisi',            type: 'standard', enterActions: [], exitActions: [] },
    { id: 'step-prb-change_requested',   name: 'change_requested',   label: 'Change Richiesta',       type: 'standard', enterActions: [], exitActions: [] },
    { id: 'step-prb-change_in_progress', name: 'change_in_progress', label: 'Change in Esecuzione',   type: 'standard', enterActions: [], exitActions: [] },
    { id: 'step-prb-resolved',           name: 'resolved',           label: 'Risolto',                type: 'standard', enterActions: [], exitActions: [] },
    { id: 'step-prb-closed',             name: 'closed',             label: 'Chiuso',                 type: 'end',      enterActions: [], exitActions: [] },
    { id: 'step-prb-rejected',           name: 'rejected',           label: 'Rigettato',              type: 'end',      enterActions: [], exitActions: [] },
    { id: 'step-prb-deferred',           name: 'deferred',           label: 'Posticipato',            type: 'standard', enterActions: [], exitActions: [] },
  ],
  transitions: [
    { id: 'tr-prb-new-investigation',          fromStepName: 'new',                toStepName: 'under_investigation', trigger: 'manual',    label: 'Inizia analisi',               condition: null,               requiresInput: false, inputField: null },
    { id: 'tr-prb-investigation-change',       fromStepName: 'under_investigation', toStepName: 'change_requested',   trigger: 'manual',    label: 'Richiedi Change',              condition: 'has_linked_change', requiresInput: false, inputField: null },
    { id: 'tr-prb-investigation-rejected',     fromStepName: 'under_investigation', toStepName: 'rejected',           trigger: 'manual',    label: 'Rigetta',                      condition: null,               requiresInput: true,  inputField: 'rejection_reason' },
    { id: 'tr-prb-investigation-deferred',     fromStepName: 'under_investigation', toStepName: 'deferred',           trigger: 'manual',    label: 'Posponi',                      condition: null,               requiresInput: true,  inputField: 'defer_reason' },
    { id: 'tr-prb-deferred-investigation',     fromStepName: 'deferred',           toStepName: 'under_investigation', trigger: 'manual',    label: 'Riprendi analisi',             condition: null,               requiresInput: false, inputField: null },
    { id: 'tr-prb-change-in_progress',         fromStepName: 'change_requested',   toStepName: 'change_in_progress', trigger: 'automatic', label: 'Change in esecuzione',         condition: null,               requiresInput: false, inputField: null },
    { id: 'tr-prb-in_progress-resolved',       fromStepName: 'change_in_progress', toStepName: 'resolved',           trigger: 'automatic', label: 'Change completata',            condition: null,               requiresInput: false, inputField: null },
    { id: 'tr-prb-in_progress-investigation',  fromStepName: 'change_in_progress', toStepName: 'under_investigation', trigger: 'automatic', label: 'Change fallita - rianalisi',  condition: null,               requiresInput: false, inputField: null },
    { id: 'tr-prb-resolved-closed',            fromStepName: 'resolved',           toStepName: 'closed',             trigger: 'timer',     label: 'Chiudi',                       condition: null,               requiresInput: false, inputField: null },
  ],
}

async function seedProblemWorkflow(tenantId: string): Promise<void> {
  const session = getSession(undefined, 'WRITE')
  const defId   = uuidv4()
  const now     = new Date().toISOString()

  try {
    await session.executeWrite(async (tx) => {
      await tx.run(`
        MERGE (wd:WorkflowDefinition {tenant_id: $tenantId, name: $name})
        ON CREATE SET
          wd.id          = $id,
          wd.entity_type = $entityType,
          wd.version     = $version,
          wd.active      = $active,
          wd.created_at  = $now,
          wd.updated_at  = $now
        ON MATCH SET
          wd.updated_at  = $now
        WITH wd
        OPTIONAL MATCH (wd)-[:HAS_STEP]->(s:WorkflowStep)
        DETACH DELETE s
      `, { id: defId, tenantId, name: PROBLEM_WORKFLOW.name, entityType: PROBLEM_WORKFLOW.entityType, version: PROBLEM_WORKFLOW.version, active: PROBLEM_WORKFLOW.active, now })

      const res = await tx.run(
        `MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, name: $name}) RETURN wd.id AS id`,
        { tenantId, name: PROBLEM_WORKFLOW.name },
      )
      const actualDefId = res.records[0]?.get('id') as string ?? defId

      for (const step of PROBLEM_WORKFLOW.steps) {
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

      for (const tr of PROBLEM_WORKFLOW.transitions) {
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

      console.log(`[workflow] Seeded "${PROBLEM_WORKFLOW.name}" for tenant "${tenantId}": defId=${actualDefId}`)
    })
  } finally {
    await session.close()
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  seedProblemWorkflow('tenant-demo')
    .then(() => process.exit(0))
    .catch((e: unknown) => { console.error(e); process.exit(1) })
}
