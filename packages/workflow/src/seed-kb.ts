import type { WorkflowDefinition } from './types.js'
import { seedWorkflowDefinition, type SeedOptions } from './seed-common.js'

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
      metadata:     { step_order: 1, is_initial: true,  is_terminal: false, is_open: true,  category: 'draft' },
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
      metadata:     { step_order: 2, is_initial: false, is_terminal: false, is_open: true,  category: 'waiting' },
    },
    {
      id:           'step-published',
      name:         'published',
      label:        'Pubblicato',
      type:         'standard',
      enterActions: [],
      exitActions:  [],
      metadata:     { step_order: 3, is_initial: false, is_terminal: false, is_open: true,  category: 'published' },
    },
    {
      id:           'step-archived',
      name:         'archived',
      label:        'Archiviato',
      type:         'end',
      enterActions: [],
      exitActions:  [],
      metadata:     { step_order: 4, is_initial: false, is_terminal: true,  is_open: false, category: 'closed' },
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
 * Come TUTTI i workflow (B-2): se la definizione esiste già NON viene
 * riallineata al seed. Il salto, con il motivo, lo stampa seedWorkflowDefinition.
 */
export async function seedKBWorkflowForTenant(tenantId: string, opts: SeedOptions = {}): Promise<string> {
  const r = await seedWorkflowDefinition(tenantId, KB_ARTICLE_WORKFLOW_BASE, opts)
  return r.definitionId
}
