import type { WorkflowDefinition } from './types.js'
import { seedWorkflowDefinition, type SeedOptions } from './seed-common.js'

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
      metadata:     { step_order: 1, is_initial: true, is_terminal: false, is_open: true, category: 'active' },
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
      metadata:     { step_order: 2, is_initial: false, is_terminal: false, is_open: true, category: 'active' },
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
      metadata:     { step_order: 4, is_initial: false, is_terminal: false, is_open: true, category: 'active' },
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
      metadata:     { step_order: 5, is_initial: false, is_terminal: false, is_open: true, category: 'waiting' },
    },
    {
      id:    'step-escalated',
      name:  'escalated',
      label: 'Escalato',
      type:  'standard',
      enterActions: [],
      exitActions: [],
      metadata:     { step_order: 6, is_initial: false, is_terminal: false, is_open: true, category: 'escalated' },
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
      metadata:     { step_order: 7, is_initial: false, is_terminal: true, is_open: false, category: 'resolved' },
    },
    {
      id:    'step-closed',
      name:  'closed',
      label: 'Chiuso',
      type:  'end',
      enterActions: [],
      exitActions: [],
      metadata:     { step_order: 8, is_initial: false, is_terminal: true, is_open: false, category: 'closed' },
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
    { id: 'step-new',             name: 'new',             label: 'Nuovo',           type: 'start',    enterActions: [], exitActions: [], metadata: { step_order: 1, is_initial: true,  is_terminal: false, is_open: true,  category: 'active' } },
    { id: 'step-assigned',        name: 'assigned',        label: 'Assegnato',       type: 'standard', enterActions: [{ type: 'sla_start', params: { sla_type: 'response' } }], exitActions: [], metadata: { step_order: 2, is_initial: false, is_terminal: false, is_open: true,  category: 'active' } },
    { id: 'step-security_review', name: 'security_review', label: 'Security Review', type: 'standard', enterActions: [{ type: 'publish_event', params: { event: 'incident.security_review' } }], exitActions: [], metadata: { step_order: 3, is_initial: false, is_terminal: false, is_open: true,  category: 'active', purpose: 'review' } },
    { id: 'step-in_progress',     name: 'in_progress',     label: 'In Lavorazione',  type: 'standard', enterActions: [{ type: 'sla_stop', params: { sla_type: 'response' } }, { type: 'sla_start', params: { sla_type: 'resolve' } }], exitActions: [], metadata: { step_order: 4, is_initial: false, is_terminal: false, is_open: true,  category: 'active' } },
    { id: 'step-pending',         name: 'pending',         label: 'In Attesa',       type: 'standard', enterActions: [{ type: 'sla_pause', params: { sla_type: 'resolve' } }], exitActions: [{ type: 'sla_resume', params: { sla_type: 'resolve' } }], metadata: { step_order: 5, is_initial: false, is_terminal: false, is_open: true,  category: 'waiting' } },
    { id: 'step-escalated',       name: 'escalated',       label: 'Escalato',        type: 'standard', enterActions: [], exitActions: [], metadata: { step_order: 6, is_initial: false, is_terminal: false, is_open: true,  category: 'escalated' } },
    { id: 'step-resolved',        name: 'resolved',        label: 'Risolto',         type: 'standard', enterActions: [{ type: 'sla_stop', params: { sla_type: 'resolve' } }, { type: 'schedule_job', params: { job: 'auto_close', delay_hours: '72' } }], exitActions: [{ type: 'cancel_job', params: { job: 'auto_close' } }], metadata: { step_order: 7, is_initial: false, is_terminal: true,  is_open: false, category: 'resolved' } },
    { id: 'step-closed',          name: 'closed',          label: 'Chiuso',          type: 'end',      enterActions: [], exitActions: [], metadata: { step_order: 8, is_initial: false, is_terminal: true,  is_open: false, category: 'closed' } },
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
// Idempotenti (vedi seed-common.ts): una definizione che esiste già viene
// SALTATA, non riallineata — le personalizzazioni del cliente sopravvivono.
// Per riallinearla al seed serve `overwrite` (e `overwriteCustomized` se il
// disegnatore l'ha marchiata).

export async function seedWorkflowForTenant(tenantId: string, opts: SeedOptions = {}): Promise<string> {
  const base = await seedWorkflowDefinition(tenantId, INCIDENT_WORKFLOW_BASE, opts)
  // Also seed the security variant
  await seedWorkflowDefinition(tenantId, INCIDENT_SECURITY_WORKFLOW, opts)
  return base.definitionId
}

// Runner operativo: apps/api/src/scripts/seed-incident-workflow.ts
// (`pnpm --filter @opengraphity/api seed:incident-workflow -- --tenant=<slug>`).
// Questo package esporta solo definizioni e funzioni seed*ForTenant (D-31).
