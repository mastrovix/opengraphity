/**
 * Seedable workflow definitions owned by the API (the incident/problem/KB ones
 * live in @opengraphity/workflow). Pure data, no side effects: importable by
 * the per-workflow seed scripts AND by tenant onboarding, so a new tenant gets
 * exactly the same Change RFC / Service Request workflows as `seed:change-workflow`
 * and `seed:sr-workflow` would create.
 */
import type { SeedableWorkflow } from '@opengraphity/workflow'
import { FACTORY_STEP_PURPOSES } from '@opengraphity/types'

type Step = SeedableWorkflow['steps'][number]
type Transition = SeedableWorkflow['transitions'][number]

// ── Change RFC Process ────────────────────────────────────────────────────────

// 'assessment' è lo step iniziale: engine.createInstance cerca lo step con
// type='start'. La UI lo mostra come step normale.
function changeStep(name: string, label: string, type: Step['type'], order: number, meta: Omit<NonNullable<Step['metadata']>, 'step_order'>, labels?: Step['labels']): Step {
  // Lo SCOPO viene dalla tabella dei nomi di fabbrica (@opengraphity/types): un
  // passo seminato nasce già riconoscibile per ruolo, senza che il codice di
  // produzione guardi mai il nome (B-4).
  return { id: `change-rfc-${name}`, name, label, ...(labels ? { labels } : {}), type, enterActions: [], exitActions: [], metadata: { ...meta, step_order: order, purpose: FACTORY_STEP_PURPOSES[name] ?? null } }
}

function changeTr(from: string, to: string, trigger: Transition['trigger'], [label, it]: readonly [string, string], condition: string | null = null, inputField: string | null = null): Transition {
  return { id: `change-rfc-${from}-${to}`, fromStepName: from, toStepName: to, trigger, label, labels: { it }, condition, requiresInput: inputField !== null, inputField }
}

export const CHANGE_RFC_WORKFLOW: SeedableWorkflow = {
  name:       'Change RFC Process',
  entityType: 'change',
  version:    1,
  active:     true,
  steps: [
    changeStep('assessment', 'Assessment', 'start',    1, { is_initial: true,  is_terminal: false, is_open: true,  category: 'active',  on_enter_create: null }),
    changeStep('approval',   'Approval',   'standard', 2, { is_initial: false, is_terminal: false, is_open: true,  category: 'waiting', on_enter_create: null }, { it: 'Approvazione' }),
    changeStep('scheduled',  'Scheduled',  'standard', 3, { is_initial: false, is_terminal: false, is_open: true,  category: 'waiting', on_enter_create: null }, { it: 'Pianificata' }),
    changeStep('deployment', 'Deployment', 'standard', 4, { is_initial: false, is_terminal: false, is_open: true,  category: 'active',  on_enter_create: 'validation_and_deployment' }),
    changeStep('review',     'Review',     'standard', 5, { is_initial: false, is_terminal: false, is_open: true,  category: 'active',  on_enter_create: 'review' }),
    changeStep('closed',     'Closed',     'end',      6, { is_initial: false, is_terminal: true,  is_open: false, category: 'closed',  on_enter_create: null }, { it: 'Chiusa' }),
  ],
  transitions: [
    // L'etichetta nomina TUTTO quello che la condizione verifica: per ogni CI
    // i due assessment E il piano di rilascio. Diceva solo «Assessment
    // completed», e chi vedeva l'arco non scattare andava a guardare i due
    // assessment, li trovava completati, e non sapeva che mancava il piano
    // (17 set 2026 — vedi `workflow/conditions.ts`).
    changeTr('assessment', 'approval',   'automatic', ['Assessments and plan completed', 'Valutazioni e piano completati'], 'all_assessments_complete'),
    changeTr('approval',   'scheduled',  'manual',    ['Approve', 'Approva']),
    changeTr('approval',   'assessment', 'manual',    ['Reject', 'Rigetta'], null, 'rejection_reason'),
    changeTr('scheduled',  'deployment', 'manual',    ['Move to Deployment', 'Avanza a Deployment']),
    // Stessa regola: `all_deployments_complete` verifica la validazione E il
    // deployment, e l'etichetta della condizione lo diceva già («e le
    // verifiche») mentre quella dell'arco no.
    changeTr('deployment', 'review',     'automatic', ['Deployment and validations completed', 'Deployment e verifiche completati'], 'all_deployments_complete'),
    changeTr('review',     'closed',     'automatic', ['Reviews completed', 'Review completate'],     'all_reviews_confirmed'),
  ],
}

// ── Service Request Fulfillment ───────────────────────────────────────────────

function srStep(name: string, [label, it]: readonly [string, string], type: Step['type'], order: number, meta: Omit<NonNullable<Step['metadata']>, 'step_order' | 'on_enter_create'>): Step {
  return { id: `sr-${name}`, name, label, labels: { it }, type, enterActions: [], exitActions: [], metadata: { ...meta, on_enter_create: null, step_order: order, purpose: FACTORY_STEP_PURPOSES[name] ?? null } }
}

function srTr(from: string, to: string, [label, it]: readonly [string, string], inputField: string | null = null): Transition {
  return { id: `sr-${from}-${to}`, fromStepName: from, toStepName: to, trigger: 'manual', label, labels: { it }, condition: null, requiresInput: inputField !== null, inputField }
}

export const SERVICE_REQUEST_WORKFLOW: SeedableWorkflow = {
  name:       'Service Request Fulfillment',
  entityType: 'service_request',
  version:    1,
  active:     true,
  steps: [
    srStep('submitted',   ['Submitted', 'Inviata'],        'start',    1, { is_initial: true,  is_terminal: false, is_open: true,  category: 'active' }),
    srStep('approval',    ['Approval', 'Approvazione'],   'standard', 2, { is_initial: false, is_terminal: false, is_open: true,  category: 'waiting' }),
    srStep('in_progress', ['In Progress', 'In lavorazione'], 'standard', 3, { is_initial: false, is_terminal: false, is_open: true,  category: 'active' }),
    /**
     * «Evasa» e RISOLTA, non aperta (revisione totale · H-41).
     *
     * Era `category: 'active'` con `is_open: true`, quindi una richiesta
     * evasa — il lavoro e fatto, resta solo la chiusura — contava come aperta
     * per lo SLA, per i contatori e per la classe `open` del portale: la
     * scheda «Aperti» la mostrava e il tempo di risoluzione continuava a
     * correre. La categoria `resolved` e quella che ferma lo SLA
     * (`stepStatusClasses`, `lib/workflowHelpers.ts`), come il passo
     * «resolved» degli incident.
     */
    srStep('fulfilled',   ['Fulfilled', 'Evasa'],          'standard', 4, { is_initial: false, is_terminal: false, is_open: false, category: 'resolved' }),
    srStep('closed',      ['Closed', 'Chiusa'],         'end',      5, { is_initial: false, is_terminal: true,  is_open: false, category: 'closed' }),
    // `failed`, like the rejection of a problem: a rejected request did not end well (tour of 23 Sep 2026, D27).
    srStep('rejected',    ['Rejected', 'Rifiutata'],      'end',      6, { is_initial: false, is_terminal: true,  is_open: false, category: 'failed' }),
  ],
  transitions: [
    srTr('submitted',   'approval',    ['Send for approval', 'Invia ad approvazione']),
    srTr('submitted',   'in_progress', ['Take charge', 'Prendi in carico']),
    srTr('approval',    'in_progress', ['Approve', 'Approva']),
    srTr('approval',    'rejected',    ['Reject', 'Rifiuta'], 'rejection_reason'),
    srTr('in_progress', 'fulfilled',   ['Fulfil', 'Evadi']),
    srTr('fulfilled',   'closed',      ['Close', 'Chiudi']),
  ],
}
