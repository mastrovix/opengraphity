/**
 * UNA RICHIESTA CHE RICHIEDE APPROVAZIONE NON LA SALTA.
 *
 * Una voce di catalogo con «approvazione richiesta» crea la richiesta con
 * `requires_approval = true`. Il workflow di fabbrica offre però dal passo
 * iniziale sia «Invia ad approvazione» sia «Prendi in carico»: la seconda
 * portava la richiesta in lavorazione senza nessuna approvazione (giro del
 * 14 set 2026). Qui la regola: finché la richiesta non è passata da un passo
 * di scopo `approval`, può andare solo verso un passo di approvazione o verso
 * una chiusura (rifiuto, annullamento).
 */
import type { Session } from 'neo4j-driver'
import { runQueryOne } from '@opengraphity/neo4j'
import { toNumber } from '@opengraphity/neo4j'

/**
 * True if moving to `toStep` would skip the approval the request needs.
 *
 * `byPerson` (23 Sep 2026): a request waiting IN the approval step can only
 * leave it by an approval decision, and a person moving it on is that
 * decision. The check counted only the closed passages through the approval
 * step (C-12, rightly: a deadline must not move a request past its approval),
 * but the passage being decided is still open — so "Approve" was filtered out
 * of the available transitions and refused, and a request that needed an
 * approval could only be rejected. A person's move out of the approval step
 * is allowed; an automatic one (the step deadline) is still refused.
 */
export async function requestApprovalWouldBeSkipped(
  session: Session, tenantId: string, instanceId: string, toStep: string,
  opts: { byPerson: boolean },
): Promise<boolean> {
  const row = await runQueryOne<{ requires: unknown; approvedPassages: unknown; currentPurpose: string | null; targetPurpose: string | null; targetTerminal: unknown }>(session, `
    MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId})
    MATCH (r:ServiceRequest {id: wi.entity_id, tenant_id: $tenantId})
    MATCH (wi)-[:CURRENT_STEP]->(cur:WorkflowStep)-[:TRANSITIONS_TO]->(target:WorkflowStep {name: $toStep})
    OPTIONAL MATCH (wd:WorkflowDefinition)-[:HAS_STEP]->(ap:WorkflowStep {purpose: 'approval'})
      WHERE (wd)-[:HAS_STEP]->(cur)
    OPTIONAL MATCH (wi)-[:STEP_HISTORY]->(ex:WorkflowStepExecution)
      // Solo le esecuzioni CONCLUSE: contare quella in corso faceva risultare
      // «passata dall'approvazione» una richiesta che è ferma proprio lì, e
      // una scadenza sul passo di approvazione la mandava in lavorazione senza
      // che nessuno l'avesse approvata (revisione totale · C-12).
      WHERE ex.step_name = ap.name AND ex.exited_at IS NOT NULL
    RETURN coalesce(r.requires_approval, false) AS requires,
           count(DISTINCT ex) AS approvedPassages,
           cur.purpose AS currentPurpose,
           target.purpose AS targetPurpose,
           coalesce(target.is_terminal, target.type = 'end') AS targetTerminal
  `, { instanceId, tenantId, toStep })
  if (!row || row.requires !== true) return false
  if (toNumber(row.approvedPassages) > 0) return false
  if (opts.byPerson && row.currentPurpose === 'approval') return false
  if (row.targetPurpose === 'approval') return false
  if (row.targetTerminal === true) return false
  return true
}
