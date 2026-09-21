/**
 * Quali campi di un ticket può scrivere un passo di workflow — l'azione
 * `update_field` e i campi impostati da una scadenza — e perché alcuni no.
 *
 * ## Prima (B-9)
 * `status` era scrivibile e la tendina del disegnatore offriva tutti i campi:
 * `update_field(status = closed)` scavalcava il motore, e `entity.status` e il
 * passo del processo divergevano in silenzio. Il rimedio fu un'allow-list di
 * quattro campi (severity, priority, description, category).
 *
 * ## Ora (verifica «Cosa resta cablato», ondata 3)
 * La scelta del proprietario è «ogni campo non riservato»: un campo aggiunto
 * dal cliente nel metamodello si deve poter impostare da un passo. L'elenco si
 * rovescia — qui ci sono i campi RISERVATI, con la ragione — e il resto lo
 * decide il metamodello del cliente (l'API verifica che il campo esista per il
 * tipo di ticket e che il valore stia nel suo vocabolario).
 *
 * Vive in `@opengraphity/types` perché lo leggono il motore a runtime, l'API in
 * scrittura e il disegnatore.
 */

/** Campi che appartengono al motore dei workflow: si cambiano con una transizione. */
export const STEP_FIELDS_ENGINE_OWNED = [
  'status', 'workflow_step', 'workflow_instance_id', 'resolved_at', 'completed_at', 'published_at',
] as const

/** Identità, numerazione e traccia: nessuna automazione li riscrive. */
export const STEP_FIELDS_IDENTITY = [
  'id', 'tenant_id', 'number', 'code', 'created_at', 'created_by', 'updated_at',
  'deleted', 'deleted_at', 'deleted_by',
] as const

/**
 * Campi DERIVATI per tipo di ticket: li calcola il prodotto da altri dati.
 * La priorità di una change viene dal tipo e dal rischio, e il tipo stesso
 * decide il varco delle approvazioni: cambiarlo da un passo lo scavalcherebbe.
 */
export const STEP_FIELDS_DERIVED: Readonly<Record<string, readonly string[]>> = {
  change: ['priority', 'impact', 'urgency', 'type', 'change_type', 'aggregate_risk_score', 'approval_route'],
}

export type StepFieldRejectionReason = 'engine_owned' | 'identity' | 'derived'

export interface StepFieldRejection {
  reason:  StepFieldRejectionReason
  /** La frase per i log e per chi non traduce. */
  message: string
}

/**
 * `null` se un passo può scrivere il campo (quanto alla riserva: l'esistenza nel
 * metamodello la verifica l'API); altrimenti perché no.
 */
export function stepFieldRejection(field: string, entityType: string): StepFieldRejection | null {
  if ((STEP_FIELDS_ENGINE_OWNED as readonly string[]).includes(field)) {
    return {
      reason: 'engine_owned',
      message: `The field "${field}" is written by the workflow engine and cannot be set by a step: use a transition `
        + '(an arc of the workflow), otherwise the ticket status and the process step drift apart.',
    }
  }
  if ((STEP_FIELDS_IDENTITY as readonly string[]).includes(field)) {
    return { reason: 'identity', message: `The field "${field}" identifies or traces the ticket and cannot be set by a step.` }
  }
  if ((STEP_FIELDS_DERIVED[entityType] ?? []).includes(field)) {
    return { reason: 'derived', message: `The field "${field}" of a ${entityType} is derived by the product and cannot be set by a step.` }
  }
  return null
}

/** Vero se un passo può scrivere il campo (quanto alla riserva). */
export function isStepFieldWritable(field: string, entityType: string): boolean {
  return stepFieldRejection(field, entityType) === null
}
