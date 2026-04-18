import { v4 as uuidv4 } from 'uuid'
import neo4j from 'neo4j-driver'
import { getSession } from '@opengraphity/neo4j'

const TENANT_ID = 'c-one'
const DEFINITION_NAME = 'Change RFC Process'

// NOTE: 'assessment' is the starting step — engine.createInstance looks up
// (wd)-[:HAS_STEP]->(startStep:WorkflowStep {type: 'start'}), so the first
// step must carry type='start'. The UI still shows it as a regular step.
const STEPS = [
  { order: 1, name: 'assessment', label: 'Assessment', type: 'start',    isInitial: true,  isTerminal: false, isOpen: true,  category: 'active',  onEnterCreate: null },
  { order: 2, name: 'approval',   label: 'Approval',   type: 'standard', isInitial: false, isTerminal: false, isOpen: true,  category: 'waiting', onEnterCreate: null },
  { order: 3, name: 'scheduled',  label: 'Scheduled',  type: 'standard', isInitial: false, isTerminal: false, isOpen: true,  category: 'waiting', onEnterCreate: null },
  { order: 4, name: 'deployment', label: 'Deployment', type: 'standard', isInitial: false, isTerminal: false, isOpen: true,  category: 'active',  onEnterCreate: 'validation_and_deployment' },
  { order: 5, name: 'review',     label: 'Review',     type: 'standard', isInitial: false, isTerminal: false, isOpen: true,  category: 'active',  onEnterCreate: 'review' },
  { order: 6, name: 'closed',     label: 'Closed',     type: 'end',      isInitial: false, isTerminal: true,  isOpen: false, category: 'closed',  onEnterCreate: null },
] as const

const TRANSITIONS = [
  { from: 'assessment', to: 'approval',   trigger: 'automatic', label: 'Assessment completato',  condition: 'all_assessments_complete', requiresInput: false, inputField: null },
  { from: 'approval',   to: 'scheduled',  trigger: 'manual',    label: 'Approva',                condition: null,                       requiresInput: false, inputField: null },
  { from: 'approval',   to: 'assessment', trigger: 'manual',    label: 'Rigetta',                condition: null,                       requiresInput: true,  inputField: 'rejection_reason' },
  { from: 'scheduled',  to: 'deployment', trigger: 'manual',    label: 'Avanza a Deployment',    condition: null,                       requiresInput: false, inputField: null },
  { from: 'deployment', to: 'review',     trigger: 'automatic', label: 'Deployment completato',  condition: 'all_deployments_complete', requiresInput: false, inputField: null },
  { from: 'review',     to: 'closed',     trigger: 'automatic', label: 'Review completate',      condition: 'all_reviews_confirmed',    requiresInput: false, inputField: null },
] as const

async function seed() {
  const session = getSession(undefined, neo4j.session.WRITE)
  const now = new Date().toISOString()

  try {
    await session.executeWrite(async (tx) => {
      // 1. MERGE WorkflowDefinition (idempotente) + rimuovi step/transizioni esistenti
      const defId = uuidv4()
      await tx.run(`
        MERGE (wd:WorkflowDefinition {tenant_id: $tenantId, name: $name})
        ON CREATE SET
          wd.id          = $id,
          wd.entity_type = 'change',
          wd.version     = 1,
          wd.active      = true,
          wd.created_at  = $now
        SET wd.updated_at = $now
        WITH wd
        OPTIONAL MATCH (wd)-[:HAS_STEP]->(s:WorkflowStep)
        DETACH DELETE s
      `, { id: defId, tenantId: TENANT_ID, name: DEFINITION_NAME, now })

      const defRes = await tx.run(
        `MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, name: $name}) RETURN wd.id AS id`,
        { tenantId: TENANT_ID, name: DEFINITION_NAME },
      )
      const actualDefId = defRes.records[0]?.get('id') as string

      // 2. WorkflowStep
      for (const step of STEPS) {
        await tx.run(`
          MATCH (wd:WorkflowDefinition {id: $defId})
          CREATE (s:WorkflowStep {
            id:              $id,
            tenant_id:       $tenantId,
            definition_id:   $defId,
            name:            $name,
            label:           $label,
            type:            $type,
            enter_actions:   '[]',
            exit_actions:    '[]',
            is_initial:      $isInitial,
            is_terminal:     $isTerminal,
            is_open:         $isOpen,
            category:        $category,
            on_enter_create: $onEnterCreate,
            step_order:      $stepOrder
          })
          CREATE (wd)-[:HAS_STEP]->(s)
        `, {
          defId: actualDefId,
          tenantId: TENANT_ID,
          id: `${TENANT_ID}-change-rfc-${step.name}`,
          name: step.name,
          label: step.label,
          type: step.type,
          isInitial: step.isInitial,
          isTerminal: step.isTerminal,
          isOpen: step.isOpen,
          category: step.category,
          onEnterCreate: step.onEnterCreate,
          stepOrder: step.order,
        })
      }

      // 3. TRANSITIONS_TO
      for (const tr of TRANSITIONS) {
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
          defId: actualDefId,
          fromName: tr.from,
          toName: tr.to,
          id: `${TENANT_ID}-change-rfc-${tr.from}-${tr.to}`,
          trigger: tr.trigger,
          label: tr.label,
          condition: tr.condition,
          requiresInput: tr.requiresInput,
          inputField: tr.inputField,
        })
      }

      console.log(`[seed-change-workflow] Seeded "${DEFINITION_NAME}" defId=${actualDefId}`)
    })
  } finally {
    await session.close()
  }
}

seed()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1) })
