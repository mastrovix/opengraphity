import type { WorkflowDefinition } from './types.js'
import { seedWorkflowDefinition, type SeedOptions } from './seed-common.js'

export const PROBLEM_WORKFLOW: Omit<WorkflowDefinition, 'id' | 'tenantId'> = {
  name:       'Problem Management',
  entityType: 'problem',
  version:    1,
  active:     true,
  steps: [
    { id: 'step-prb-new',                name: 'new',                label: 'Nuovo',                  type: 'start',    enterActions: [], exitActions: [], metadata: { step_order: 1, is_initial: true,  is_terminal: false, is_open: true,  category: 'active' } },
    { id: 'step-prb-under_investigation', name: 'under_investigation', label: 'In Analisi',            type: 'standard', enterActions: [], exitActions: [], metadata: { step_order: 2, is_initial: false, is_terminal: false, is_open: true,  category: 'active', purpose: 'investigation' } },
    { id: 'step-prb-known_error',        name: 'known_error',        label: 'Errore Noto (KEDB)',     type: 'standard', enterActions: [], exitActions: [], metadata: { step_order: 3, is_initial: false, is_terminal: false, is_open: true,  category: 'active' } },
    { id: 'step-prb-change_requested',   name: 'change_requested',   label: 'Change Richiesta',       type: 'standard', enterActions: [], exitActions: [], metadata: { step_order: 4, is_initial: false, is_terminal: false, is_open: true,  category: 'active', purpose: 'change_requested' } },
    { id: 'step-prb-change_in_progress', name: 'change_in_progress', label: 'Change in Esecuzione',   type: 'standard', enterActions: [], exitActions: [], metadata: { step_order: 5, is_initial: false, is_terminal: false, is_open: true,  category: 'active', purpose: 'change_in_progress' } },
    { id: 'step-prb-resolved',           name: 'resolved',           label: 'Risolto',                type: 'standard', enterActions: [], exitActions: [], metadata: { step_order: 6, is_initial: false, is_terminal: true,  is_open: false, category: 'resolved' } },
    { id: 'step-prb-closed',             name: 'closed',             label: 'Chiuso',                 type: 'end',      enterActions: [], exitActions: [], metadata: { step_order: 9, is_initial: false, is_terminal: true,  is_open: false, category: 'closed' } },
    { id: 'step-prb-rejected',           name: 'rejected',           label: 'Rigettato',              type: 'end',      enterActions: [], exitActions: [], metadata: { step_order: 8, is_initial: false, is_terminal: true,  is_open: false, category: 'failed' } },
    { id: 'step-prb-deferred',           name: 'deferred',           label: 'Posticipato',            type: 'standard', enterActions: [], exitActions: [], metadata: { step_order: 7, is_initial: false, is_terminal: false, is_open: true,  category: 'active' } },
  ],
  transitions: [
    { id: 'tr-prb-new-investigation',          fromStepName: 'new',                toStepName: 'under_investigation', trigger: 'manual',    label: 'Inizia analisi',               condition: null,               requiresInput: false, inputField: null },
    { id: 'tr-prb-investigation-change',       fromStepName: 'under_investigation', toStepName: 'change_requested',   trigger: 'manual',    label: 'Richiedi Change',              condition: 'has_linked_change', requiresInput: false, inputField: null },
    { id: 'tr-prb-investigation-rejected',     fromStepName: 'under_investigation', toStepName: 'rejected',           trigger: 'manual',    label: 'Rigetta',                      condition: null,               requiresInput: true,  inputField: 'rejection_reason' },
    { id: 'tr-prb-investigation-deferred',     fromStepName: 'under_investigation', toStepName: 'deferred',           trigger: 'manual',    label: 'Posponi',                      condition: null,               requiresInput: true,  inputField: 'defer_reason' },
    { id: 'tr-prb-deferred-investigation',     fromStepName: 'deferred',           toStepName: 'under_investigation', trigger: 'manual',    label: 'Riprendi analisi',             condition: null,               requiresInput: false, inputField: null },
    { id: 'tr-prb-investigation-known_error',  fromStepName: 'under_investigation', toStepName: 'known_error',        trigger: 'manual',    label: 'Documenta come Errore Noto',   condition: null,               requiresInput: false, inputField: null },
    { id: 'tr-prb-known_error-change',         fromStepName: 'known_error',        toStepName: 'change_requested',   trigger: 'manual',    label: 'Richiedi Change risolutiva',   condition: 'has_linked_change', requiresInput: false, inputField: null },
    { id: 'tr-prb-known_error-resolved',       fromStepName: 'known_error',        toStepName: 'resolved',           trigger: 'manual',    label: 'Segna come risolto',           condition: null,               requiresInput: false, inputField: null },
    { id: 'tr-prb-change-in_progress',         fromStepName: 'change_requested',   toStepName: 'change_in_progress', trigger: 'automatic', label: 'Change in esecuzione',         condition: null,               requiresInput: false, inputField: null },
    { id: 'tr-prb-change_requested-investigation', fromStepName: 'change_requested', toStepName: 'under_investigation', trigger: 'automatic', label: 'Change scollegata - rianalisi', condition: null,              requiresInput: false, inputField: null },
    { id: 'tr-prb-in_progress-resolved',       fromStepName: 'change_in_progress', toStepName: 'resolved',           trigger: 'automatic', label: 'Change completata',            condition: null,               requiresInput: false, inputField: null },
    { id: 'tr-prb-in_progress-investigation',  fromStepName: 'change_in_progress', toStepName: 'under_investigation', trigger: 'automatic', label: 'Change fallita - rianalisi',  condition: null,               requiresInput: false, inputField: null },
    { id: 'tr-prb-resolved-closed',            fromStepName: 'resolved',           toStepName: 'closed',             trigger: 'manual',    label: 'Verifica soluzione e chiudi',  condition: null,               requiresInput: false, inputField: null },
    { id: 'tr-prb-resolved-investigation',     fromStepName: 'resolved',           toStepName: 'under_investigation', trigger: 'manual',    label: 'Soluzione non efficace - riapri', condition: null,            requiresInput: true,  inputField: 'reopen_reason' },
  ],
}

export async function seedProblemWorkflowForTenant(tenantId: string, opts: SeedOptions = {}): Promise<string> {
  const r = await seedWorkflowDefinition(tenantId, PROBLEM_WORKFLOW, opts)
  return r.definitionId
}

// Runner operativo: apps/api/src/scripts/seed-problem-workflow.ts (D-31).
