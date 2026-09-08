/**
 * Seed idempotente del workflow "Service Request Fulfillment".
 *
 * Usa `seedWorkflowDefinition` (MERGE per chiave naturale, step esistenti
 * conservati, niente DETACH DELETE): la versione precedente cancellava gli
 * step a ogni esecuzione orfanando le CURRENT_STEP delle richieste aperte.
 *
 * Invocazione: pnpm --filter @opengraphity/api seed:sr-workflow -- --tenant=c-one
 */
import { seedWorkflowDefinition, type SeedableWorkflow } from '@opengraphity/workflow'
import { resolveTenantArg } from './lib/scriptArgs.js'

export const SERVICE_REQUEST_WORKFLOW: SeedableWorkflow = {
  name:       'Service Request Fulfillment',
  entityType: 'service_request',
  version:    1,
  active:     true,
  steps: [
    step('submitted',   'Inviata',        'start',    1, { is_initial: true,  is_terminal: false, is_open: true,  category: 'active' }),
    step('approval',    'Approvazione',   'standard', 2, { is_initial: false, is_terminal: false, is_open: true,  category: 'waiting' }),
    step('in_progress', 'In lavorazione', 'standard', 3, { is_initial: false, is_terminal: false, is_open: true,  category: 'active' }),
    step('fulfilled',   'Evasa',          'standard', 4, { is_initial: false, is_terminal: false, is_open: true,  category: 'active' }),
    step('closed',      'Chiusa',         'end',      5, { is_initial: false, is_terminal: true,  is_open: false, category: 'closed' }),
    step('rejected',    'Rifiutata',      'end',      6, { is_initial: false, is_terminal: true,  is_open: false, category: 'closed' }),
  ],
  transitions: [
    tr('submitted',   'approval',    'Invia ad approvazione'),
    tr('submitted',   'in_progress', 'Prendi in carico'),
    tr('approval',    'in_progress', 'Approva'),
    tr('approval',    'rejected',    'Rifiuta', 'rejection_reason'),
    tr('in_progress', 'fulfilled',   'Evadi'),
    tr('fulfilled',   'closed',      'Chiudi'),
  ],
}

type Step = SeedableWorkflow['steps'][number]
type Transition = SeedableWorkflow['transitions'][number]

function step(name: string, label: string, type: Step['type'], order: number, meta: Omit<NonNullable<Step['metadata']>, 'step_order' | 'on_enter_create'>): Step {
  return { id: `sr-${name}`, name, label, type, enterActions: [], exitActions: [], metadata: { ...meta, on_enter_create: null, step_order: order } }
}

function tr(from: string, to: string, label: string, inputField: string | null = null): Transition {
  return { id: `sr-${from}-${to}`, fromStepName: from, toStepName: to, trigger: 'manual', label, condition: null, requiresInput: inputField !== null, inputField }
}

async function main() {
  const tenantId = resolveTenantArg()
  const res = await seedWorkflowDefinition(tenantId, SERVICE_REQUEST_WORKFLOW)
  console.log(`[seed-service-request-workflow] "${SERVICE_REQUEST_WORKFLOW.name}" tenant=${tenantId} defId=${res.definitionId} ${res.created ? 'creata' : 'aggiornata'}`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1) })
