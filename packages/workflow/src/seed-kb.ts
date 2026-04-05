import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'
import type { WorkflowDefinition } from './types.js'

export const KB_ARTICLE_WORKFLOW_BASE: Omit<WorkflowDefinition, 'id' | 'tenantId'> = {
  name:       'KB Article Lifecycle',
  entityType: 'kb_article',
  version:    1,
  active:     true,
  steps: [
    {
      id:           'step-draft',
      name:         'draft',
      label:        'Bozza',
      type:         'start',
      enterActions: [],
      exitActions:  [],
    },
    {
      id:    'step-pending_review',
      name:  'pending_review',
      label: 'In Revisione',
      type:  'standard',
      enterActions: [
        {
          type:   'create_approval_request',
          params: {
            title_template: 'Pubblicazione: {title}',
            approver_role:  'admin',
            approval_type:  'any',
          },
        },
      ],
      exitActions: [],
    },
    {
      id:           'step-published',
      name:         'published',
      label:        'Pubblicato',
      type:         'standard',
      enterActions: [],
      exitActions:  [],
    },
    {
      id:           'step-archived',
      name:         'archived',
      label:        'Archiviato',
      type:         'end',
      enterActions: [],
      exitActions:  [],
    },
  ],
  transitions: [
    {
      id:            'tr-submit',
      fromStepName:  'draft',
      toStepName:    'pending_review',
      trigger:       'manual',
      label:         'Richiedi Pubblicazione',
      condition:     null,
      requiresInput: false,
      inputField:    null,
    },
    {
      id:            'tr-approve',
      fromStepName:  'pending_review',
      toStepName:    'published',
      trigger:       'manual',
      label:         'Approva',
      condition:     null,
      requiresInput: false,
      inputField:    null,
    },
    {
      id:            'tr-reject',
      fromStepName:  'pending_review',
      toStepName:    'draft',
      trigger:       'manual',
      label:         'Rifiuta',
      condition:     null,
      requiresInput: true,
      inputField:    'rejection_reason',
    },
    {
      id:            'tr-archive',
      fromStepName:  'published',
      toStepName:    'archived',
      trigger:       'manual',
      label:         'Archivia',
      condition:     null,
      requiresInput: false,
      inputField:    null,
    },
    {
      id:            'tr-archive-draft',
      fromStepName:  'draft',
      toStepName:    'archived',
      trigger:       'manual',
      label:         'Archivia',
      condition:     null,
      requiresInput: false,
      inputField:    null,
    },
    {
      id:            'tr-unpublish',
      fromStepName:  'published',
      toStepName:    'draft',
      trigger:       'manual',
      label:         'Ritira',
      condition:     null,
      requiresInput: false,
      inputField:    null,
    },
    {
      id:            'tr-restore',
      fromStepName:  'archived',
      toStepName:    'draft',
      trigger:       'manual',
      label:         'Ripristina',
      condition:     null,
      requiresInput: false,
      inputField:    null,
    },
  ],
}

export async function seedKBWorkflowForTenant(tenantId: string): Promise<string> {
  const session = await getSession()
  const defId   = uuidv4()
  const now     = new Date().toISOString()

  try {
    await session.executeWrite(async (tx) => {
      // Check if already seeded
      const existing = await tx.run(
        `MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: 'kb_article', active: true}) RETURN wd.id AS id LIMIT 1`,
        { tenantId },
      )
      if (existing.records.length > 0) {
        console.log(`[workflow] KB workflow already exists for tenant "${tenantId}" — skipping`)
        return
      }

      await tx.run(`
        CREATE (wd:WorkflowDefinition {
          id:          $id,
          tenant_id:   $tenantId,
          name:        $name,
          entity_type: $entityType,
          version:     $version,
          active:      $active,
          created_at:  $now,
          updated_at:  $now
        })
      `, {
        id:         defId,
        tenantId,
        name:       KB_ARTICLE_WORKFLOW_BASE.name,
        entityType: KB_ARTICLE_WORKFLOW_BASE.entityType,
        version:    KB_ARTICLE_WORKFLOW_BASE.version,
        active:     KB_ARTICLE_WORKFLOW_BASE.active,
        now,
      })

      for (const step of KB_ARTICLE_WORKFLOW_BASE.steps) {
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
          defId,
          tenantId,
          id:           `${tenantId}-${step.id}`,
          name:         step.name,
          label:        step.label,
          type:         step.type,
          enterActions: JSON.stringify(step.enterActions),
          exitActions:  JSON.stringify(step.exitActions),
        })
      }

      for (const tr of KB_ARTICLE_WORKFLOW_BASE.transitions) {
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
          defId,
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
    })

    console.log(`[workflow] Seeded KB workflow for tenant "${tenantId}": definitionId=${defId}`)
    return defId
  } finally {
    await session.close()
  }
}
