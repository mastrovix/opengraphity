/**
 * Seed idempotente del workflow "Change RFC Process".
 *
 * Usa `seedWorkflowDefinition` (MERGE per chiave naturale, step esistenti
 * conservati, niente DETACH DELETE): la versione precedente cancellava gli
 * step a ogni esecuzione orfanando le CURRENT_STEP delle change aperte.
 *
 * Invocazione: pnpm --filter @opengraphity/api seed:change-workflow -- --tenant=c-one
 */
import { seedWorkflowDefinition, type SeedableWorkflow } from '@opengraphity/workflow'
import { resolveTenantArg } from './lib/scriptArgs.js'

// 'assessment' è lo step iniziale: engine.createInstance cerca lo step con
// type='start'. La UI lo mostra come step normale.
export const CHANGE_RFC_WORKFLOW: SeedableWorkflow = {
  name:       'Change RFC Process',
  entityType: 'change',
  version:    1,
  active:     true,
  steps: [
    step('assessment', 'Assessment', 'start',    1, { is_initial: true,  is_terminal: false, is_open: true,  category: 'active',  on_enter_create: null }),
    step('approval',   'Approval',   'standard', 2, { is_initial: false, is_terminal: false, is_open: true,  category: 'waiting', on_enter_create: null }),
    step('scheduled',  'Scheduled',  'standard', 3, { is_initial: false, is_terminal: false, is_open: true,  category: 'waiting', on_enter_create: null }),
    step('deployment', 'Deployment', 'standard', 4, { is_initial: false, is_terminal: false, is_open: true,  category: 'active',  on_enter_create: 'validation_and_deployment' }),
    step('review',     'Review',     'standard', 5, { is_initial: false, is_terminal: false, is_open: true,  category: 'active',  on_enter_create: 'review' }),
    step('closed',     'Closed',     'end',      6, { is_initial: false, is_terminal: true,  is_open: false, category: 'closed',  on_enter_create: null }),
  ],
  transitions: [
    tr('assessment', 'approval',   'automatic', 'Assessment completato', 'all_assessments_complete'),
    tr('approval',   'scheduled',  'manual',    'Approva'),
    tr('approval',   'assessment', 'manual',    'Rigetta', null, 'rejection_reason'),
    tr('scheduled',  'deployment', 'manual',    'Avanza a Deployment'),
    tr('deployment', 'review',     'automatic', 'Deployment completato', 'all_deployments_complete'),
    tr('review',     'closed',     'automatic', 'Review completate',     'all_reviews_confirmed'),
  ],
}

type Step = SeedableWorkflow['steps'][number]
type Transition = SeedableWorkflow['transitions'][number]

function step(name: string, label: string, type: Step['type'], order: number, meta: Omit<NonNullable<Step['metadata']>, 'step_order'>): Step {
  return { id: `change-rfc-${name}`, name, label, type, enterActions: [], exitActions: [], metadata: { ...meta, step_order: order } }
}

function tr(from: string, to: string, trigger: Transition['trigger'], label: string, condition: string | null = null, inputField: string | null = null): Transition {
  return { id: `change-rfc-${from}-${to}`, fromStepName: from, toStepName: to, trigger, label, condition, requiresInput: inputField !== null, inputField }
}

async function main() {
  const tenantId = resolveTenantArg()
  const res = await seedWorkflowDefinition(tenantId, CHANGE_RFC_WORKFLOW)
  console.log(`[seed-change-workflow] "${CHANGE_RFC_WORKFLOW.name}" tenant=${tenantId} defId=${res.definitionId} ${res.created ? 'creata' : 'aggiornata'}`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1) })
