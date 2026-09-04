import { v4 as uuidv4 } from 'uuid'
import neo4j from 'neo4j-driver'
import { getSession } from '@opengraphity/neo4j'

const TENANT_ID = 'c-one'
const DEFINITION_NAME = 'Service Request Fulfillment'

const STEPS = [
  { order: 1, name: 'submitted',   label: 'Inviata',       type: 'start',    isInitial: true,  isTerminal: false, isOpen: true,  category: 'active' },
  { order: 2, name: 'approval',    label: 'Approvazione',  type: 'standard', isInitial: false, isTerminal: false, isOpen: true,  category: 'waiting' },
  { order: 3, name: 'in_progress', label: 'In lavorazione',type: 'standard', isInitial: false, isTerminal: false, isOpen: true,  category: 'active' },
  { order: 4, name: 'fulfilled',   label: 'Evasa',         type: 'standard', isInitial: false, isTerminal: false, isOpen: true,  category: 'active' },
  { order: 5, name: 'closed',      label: 'Chiusa',        type: 'end',      isInitial: false, isTerminal: true,  isOpen: false, category: 'closed' },
  { order: 6, name: 'rejected',    label: 'Rifiutata',     type: 'end',      isInitial: false, isTerminal: true,  isOpen: false, category: 'closed' },
] as const

const TRANSITIONS = [
  { from: 'submitted',   to: 'approval',    trigger: 'manual', label: 'Invia ad approvazione', condition: null, requiresInput: false, inputField: null },
  { from: 'submitted',   to: 'in_progress', trigger: 'manual', label: 'Prendi in carico',      condition: null, requiresInput: false, inputField: null },
  { from: 'approval',    to: 'in_progress', trigger: 'manual', label: 'Approva',               condition: null, requiresInput: false, inputField: null },
  { from: 'approval',    to: 'rejected',    trigger: 'manual', label: 'Rifiuta',               condition: null, requiresInput: true,  inputField: 'rejection_reason' },
  { from: 'in_progress', to: 'fulfilled',   trigger: 'manual', label: 'Evadi',                 condition: null, requiresInput: false, inputField: null },
  { from: 'fulfilled',   to: 'closed',      trigger: 'manual', label: 'Chiudi',                condition: null, requiresInput: false, inputField: null },
] as const

async function seed() {
  const session = getSession(undefined, neo4j.session.WRITE)
  const now = new Date().toISOString()
  try {
    await session.executeWrite(async (tx) => {
      const defId = uuidv4()
      await tx.run(`
        MERGE (wd:WorkflowDefinition {tenant_id: $tenantId, name: $name})
        ON CREATE SET wd.id = $id, wd.entity_type = 'service_request', wd.version = 1, wd.active = true, wd.created_at = $now
        SET wd.updated_at = $now
        WITH wd
        OPTIONAL MATCH (wd)-[:HAS_STEP]->(s:WorkflowStep) DETACH DELETE s
      `, { id: defId, tenantId: TENANT_ID, name: DEFINITION_NAME, now })

      const defRes = await tx.run(`MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, name: $name}) RETURN wd.id AS id`, { tenantId: TENANT_ID, name: DEFINITION_NAME })
      const actualDefId = defRes.records[0]?.get('id') as string
      if (!actualDefId) throw new Error('WorkflowDefinition not created')

      for (const step of STEPS) {
        await tx.run(`
          MATCH (wd:WorkflowDefinition {id: $defId})
          CREATE (s:WorkflowStep {
            id: $id, tenant_id: $tenantId, definition_id: $defId, name: $name, label: $label, type: $type,
            enter_actions: '[]', exit_actions: '[]', is_initial: $isInitial, is_terminal: $isTerminal,
            is_open: $isOpen, category: $category, on_enter_create: null, step_order: $stepOrder
          })
          CREATE (wd)-[:HAS_STEP]->(s)
        `, {
          defId: actualDefId, tenantId: TENANT_ID, id: `${TENANT_ID}-sr-${step.name}`,
          name: step.name, label: step.label, type: step.type, isInitial: step.isInitial,
          isTerminal: step.isTerminal, isOpen: step.isOpen, category: step.category, stepOrder: step.order,
        })
      }

      for (const tr of TRANSITIONS) {
        const res = await tx.run(`
          MATCH (from:WorkflowStep {name: $fromName, definition_id: $defId})
          MATCH (to:WorkflowStep   {name: $toName,   definition_id: $defId})
          CREATE (from)-[:TRANSITIONS_TO { id: $id, trigger: $trigger, label: $label, condition: $condition, requires_input: $requiresInput, input_field: $inputField }]->(to)
          RETURN count(*) AS c
        `, {
          defId: actualDefId, fromName: tr.from, toName: tr.to, id: `${TENANT_ID}-sr-${tr.from}-${tr.to}`,
          trigger: tr.trigger, label: tr.label, condition: tr.condition, requiresInput: tr.requiresInput, inputField: tr.inputField,
        })
        if ((res.records[0]?.get('c') as neo4j.Integer)?.toNumber?.() === 0) {
          throw new Error(`Transition ${tr.from}→${tr.to}: step name mismatch`)
        }
      }
      console.log(`[seed-service-request-workflow] Seeded "${DEFINITION_NAME}" defId=${actualDefId}`)
    })
  } finally {
    await session.close()
  }
}

seed().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
