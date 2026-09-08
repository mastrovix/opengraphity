/**
 * Seedable workflow definitions owned by the API (the incident/problem/KB ones
 * live in @opengraphity/workflow). Pure data, no side effects: importable by
 * the per-workflow seed scripts AND by tenant onboarding, so a new tenant gets
 * exactly the same Change RFC / Service Request workflows as `seed:change-workflow`
 * and `seed:sr-workflow` would create.
 */
import type { SeedableWorkflow } from '@opengraphity/workflow'

type Step = SeedableWorkflow['steps'][number]
type Transition = SeedableWorkflow['transitions'][number]

// ── Change RFC Process ────────────────────────────────────────────────────────

// 'assessment' è lo step iniziale: engine.createInstance cerca lo step con
// type='start'. La UI lo mostra come step normale.
function changeStep(name: string, label: string, type: Step['type'], order: number, meta: Omit<NonNullable<Step['metadata']>, 'step_order'>): Step {
  return { id: `change-rfc-${name}`, name, label, type, enterActions: [], exitActions: [], metadata: { ...meta, step_order: order } }
}

function changeTr(from: string, to: string, trigger: Transition['trigger'], label: string, condition: string | null = null, inputField: string | null = null): Transition {
  return { id: `change-rfc-${from}-${to}`, fromStepName: from, toStepName: to, trigger, label, condition, requiresInput: inputField !== null, inputField }
}

export const CHANGE_RFC_WORKFLOW: SeedableWorkflow = {
  name:       'Change RFC Process',
  entityType: 'change',
  version:    1,
  active:     true,
  steps: [
    changeStep('assessment', 'Assessment', 'start',    1, { is_initial: true,  is_terminal: false, is_open: true,  category: 'active',  on_enter_create: null }),
    changeStep('approval',   'Approval',   'standard', 2, { is_initial: false, is_terminal: false, is_open: true,  category: 'waiting', on_enter_create: null }),
    changeStep('scheduled',  'Scheduled',  'standard', 3, { is_initial: false, is_terminal: false, is_open: true,  category: 'waiting', on_enter_create: null }),
    changeStep('deployment', 'Deployment', 'standard', 4, { is_initial: false, is_terminal: false, is_open: true,  category: 'active',  on_enter_create: 'validation_and_deployment' }),
    changeStep('review',     'Review',     'standard', 5, { is_initial: false, is_terminal: false, is_open: true,  category: 'active',  on_enter_create: 'review' }),
    changeStep('closed',     'Closed',     'end',      6, { is_initial: false, is_terminal: true,  is_open: false, category: 'closed',  on_enter_create: null }),
  ],
  transitions: [
    changeTr('assessment', 'approval',   'automatic', 'Assessment completato', 'all_assessments_complete'),
    changeTr('approval',   'scheduled',  'manual',    'Approva'),
    changeTr('approval',   'assessment', 'manual',    'Rigetta', null, 'rejection_reason'),
    changeTr('scheduled',  'deployment', 'manual',    'Avanza a Deployment'),
    changeTr('deployment', 'review',     'automatic', 'Deployment completato', 'all_deployments_complete'),
    changeTr('review',     'closed',     'automatic', 'Review completate',     'all_reviews_confirmed'),
  ],
}

// ── Service Request Fulfillment ───────────────────────────────────────────────

function srStep(name: string, label: string, type: Step['type'], order: number, meta: Omit<NonNullable<Step['metadata']>, 'step_order' | 'on_enter_create'>): Step {
  return { id: `sr-${name}`, name, label, type, enterActions: [], exitActions: [], metadata: { ...meta, on_enter_create: null, step_order: order } }
}

function srTr(from: string, to: string, label: string, inputField: string | null = null): Transition {
  return { id: `sr-${from}-${to}`, fromStepName: from, toStepName: to, trigger: 'manual', label, condition: null, requiresInput: inputField !== null, inputField }
}

export const SERVICE_REQUEST_WORKFLOW: SeedableWorkflow = {
  name:       'Service Request Fulfillment',
  entityType: 'service_request',
  version:    1,
  active:     true,
  steps: [
    srStep('submitted',   'Inviata',        'start',    1, { is_initial: true,  is_terminal: false, is_open: true,  category: 'active' }),
    srStep('approval',    'Approvazione',   'standard', 2, { is_initial: false, is_terminal: false, is_open: true,  category: 'waiting' }),
    srStep('in_progress', 'In lavorazione', 'standard', 3, { is_initial: false, is_terminal: false, is_open: true,  category: 'active' }),
    srStep('fulfilled',   'Evasa',          'standard', 4, { is_initial: false, is_terminal: false, is_open: true,  category: 'active' }),
    srStep('closed',      'Chiusa',         'end',      5, { is_initial: false, is_terminal: true,  is_open: false, category: 'closed' }),
    srStep('rejected',    'Rifiutata',      'end',      6, { is_initial: false, is_terminal: true,  is_open: false, category: 'closed' }),
  ],
  transitions: [
    srTr('submitted',   'approval',    'Invia ad approvazione'),
    srTr('submitted',   'in_progress', 'Prendi in carico'),
    srTr('approval',    'in_progress', 'Approva'),
    srTr('approval',    'rejected',    'Rifiuta', 'rejection_reason'),
    srTr('in_progress', 'fulfilled',   'Evadi'),
    srTr('fulfilled',   'closed',      'Chiudi'),
  ],
}
