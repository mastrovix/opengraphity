/**
 * I RUOLI DEI PASSI che il prodotto pretende da un workflow, per tipo di ticket
 * (revisione del 14 set 2026 · F17).
 *
 * Il codice non riconosce più un passo dal nome: lo cerca per CATEGORIA (lo
 * stato visibile da fuori: risolto, chiuso, escalato) o per SCOPO (il ruolo nel
 * processo: valutazione, calendario, rilascio). Il rovescio è che un cliente che
 * rinomina un passo e non dichiara la categoria o lo scopo lo scopre solo quando
 * un'operazione si ferma — o, per gli usi facoltativi, non lo scopre affatto.
 * Questa tabella è l'elenco di quello che il codice cerca, e la diagnostica lo
 * confronta con ogni workflow attivo del cliente.
 *
 * - `required`: senza, un'operazione si ferma con un errore (una transizione
 *   automatica, l'escalation, la lista dei known error);
 * - `optional`: senza, un comportamento si spegne in silenzio (la soppressione
 *   degli allarmi durante il rilascio, l'avanzamento del problem con la change).
 *
 * `workflowStepRoles.test.ts` legge il codice e fallisce se un uso nuovo non è
 * qui: la tabella non può restare indietro.
 */
import type { Session } from 'neo4j-driver'
import { runQuery } from '@opengraphity/neo4j'
import type { WorkflowStepCategory, WorkflowStepPurpose } from '@opengraphity/types'

export interface StepRoleSet {
  categories: readonly WorkflowStepCategory[]
  purposes:   readonly WorkflowStepPurpose[]
}

export const STEP_ROLES = {
  incident: {
    // resolved: chiusura della change che lo risolve, allarmi rientrati;
    // escalated: escalateIncident; closed: chiusura automatica.
    required: { categories: ['resolved', 'escalated', 'closed'], purposes: [] },
    optional: { categories: ['active'], purposes: [] },
  },
  problem: {
    required: { categories: ['resolved', 'closed'], purposes: ['investigation', 'change_in_progress', 'known_error'] },
    optional: { categories: [], purposes: ['change_requested'] },
  },
  change: {
    required: { categories: ['closed'], purposes: ['assessment', 'scheduled'] },
    // implementation: soppressione degli allarmi e stato REST del rilascio;
    // approval: il varco della finestra dice «nessun passo di approvazione».
    optional: { categories: [], purposes: ['approval', 'implementation', 'review'] },
  },
  service_request: {
    required: { categories: ['closed'], purposes: [] },
    optional: { categories: [], purposes: [] },
  },
} as const satisfies Record<string, { required: StepRoleSet; optional: StepRoleSet }>

export type StepRoleEntityType = keyof typeof STEP_ROLES

export interface MissingStepRoles {
  workflow:   string
  entityType: StepRoleEntityType
  required:   { categories: string[]; purposes: string[] }
  optional:   { categories: string[]; purposes: string[] }
}

const missing = (want: readonly string[], have: readonly string[]): string[] => want.filter((v) => !have.includes(v))

/** Le definizioni ATTIVE del cliente a cui manca almeno un ruolo, nell'ordine in cui arrivano. */
export async function workflowsMissingStepRoles(session: Session, tenantId: string): Promise<MissingStepRoles[]> {
  const rows = await runQuery<{ id: string; name: string; entityType: string; categories: string[]; purposes: string[] }>(session, `
    MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, active: true})
    WHERE wd.entity_type IN $entityTypes
    OPTIONAL MATCH (wd)-[:HAS_STEP]->(s:WorkflowStep)
    RETURN wd.id AS id, wd.name AS name, wd.entity_type AS entityType,
           [c IN collect(DISTINCT s.category) WHERE c IS NOT NULL] AS categories,
           [p IN collect(DISTINCT s.purpose)  WHERE p IS NOT NULL] AS purposes
    ORDER BY entityType, name
  `, { tenantId, entityTypes: Object.keys(STEP_ROLES) })

  const out: MissingStepRoles[] = []
  for (const r of rows) {
    const spec = STEP_ROLES[r.entityType as StepRoleEntityType]
    if (!spec) continue
    const item: MissingStepRoles = {
      workflow: r.name, entityType: r.entityType as StepRoleEntityType,
      required: { categories: missing(spec.required.categories, r.categories), purposes: missing(spec.required.purposes, r.purposes) },
      optional: { categories: missing(spec.optional.categories, r.categories), purposes: missing(spec.optional.purposes, r.purposes) },
    }
    const count = item.required.categories.length + item.required.purposes.length + item.optional.categories.length + item.optional.purposes.length
    if (count > 0) out.push(item)
  }
  return out
}
