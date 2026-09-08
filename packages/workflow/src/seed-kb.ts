import type { WorkflowDefinition } from './types.js'
import { seedWorkflowDefinition } from './seed-common.js'

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

/**
 * Il workflow KB è personalizzabile dal designer: se esiste già NON viene
 * riallineato al seed (skipIfExists), a differenza di incident/problem.
 */
export async function seedKBWorkflowForTenant(tenantId: string): Promise<string> {
  const r = await seedWorkflowDefinition(tenantId, KB_ARTICLE_WORKFLOW_BASE, { skipIfExists: true })
  if (!r.created) console.log(`[workflow] KB workflow already exists for tenant "${tenantId}" — skipping`)
  return r.definitionId
}
