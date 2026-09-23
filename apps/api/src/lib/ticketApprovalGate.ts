/**
 * THE APPROVER DECIDES (review of 23 Sep 2026, owner's decision).
 *
 * The workflow action `create_approval_request` names who approves a ticket
 * (a role, people, teams: «the approval of a spend belongs to the budget
 * owner»). Their decision did nothing on incidents, problems and requests:
 * approved, the ticket sat in the step until someone moved it; rejected, an
 * operator could still move it on. The owner chose that the approver decides,
 * as the change approvals already do:
 *
 *  - while the request of the step the ticket is in is PENDING or REJECTED,
 *    the ticket does not move forward — only towards a terminal step
 *    (closing or cancelling it skips nothing) — unless the person holds
 *    `approval.override`;
 *  - APPROVED, the ticket leaves the step by itself when there is one way
 *    forward; with several, a person chooses, and the gate is open;
 *  - REJECTED, it goes to the step of category `failed` when there is one.
 *
 * A request belongs to the step whose entry created it (`step_name`). Those
 * written before this field have none and gate nothing: the rule of 23 Sep
 * 2026 («a person moving the ticket out of the approval step is the
 * decision») still holds where no approver was named.
 *
 * Changes are not here: their approvals are `ChangeApproval`, with their own
 * gate (resolvers/change/approvalGate.ts).
 */
import type { Session } from 'neo4j-driver'
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import { logger } from './logger.js'

const log = logger.child({ module: 'ticket-approval-gate' })

export const APPROVAL_GATED_TICKETS: readonly string[] = ['incident', 'problem', 'service_request']

export type OpenApprovalStatus = 'pending' | 'rejected'

/**
 * Why moving the ticket to `toStep` is refused, or null if it is not: the
 * status of the request that holds it. The caller decides the override.
 */
export async function ticketApprovalRefusal(
  session: Session, tenantId: string, instanceId: string, toStep: string,
): Promise<{ status: OpenApprovalStatus; approvalId: string; stepName: string } | null> {
  const row = await runQueryOne<{ approvalId: string | null; status: string | null; stepName: string; entityType: string; targetTerminal: unknown }>(session, `
    MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId})-[:CURRENT_STEP]->(cur:WorkflowStep)
    OPTIONAL MATCH (cur)-[:TRANSITIONS_TO]->(target:WorkflowStep {name: $toStep})
    OPTIONAL MATCH (a:ApprovalRequest {tenant_id: $tenantId, entity_id: wi.entity_id, step_name: cur.name})
    WITH wi, cur, target, a ORDER BY a.requested_at DESC
    WITH wi, cur, target, collect(a)[0] AS latest
    RETURN latest.id AS approvalId, latest.status AS status, cur.name AS stepName, wi.entity_type AS entityType,
           coalesce(target.is_terminal, target.type = 'end', false) AS targetTerminal
  `, { instanceId, tenantId, toStep })
  if (!row || !row.approvalId || !APPROVAL_GATED_TICKETS.includes(row.entityType)) return null
  if (row.status !== 'pending' && row.status !== 'rejected') return null
  if (row.targetTerminal === true) return null
  return { status: row.status, approvalId: row.approvalId, stepName: row.stepName }
}

/**
 * The ticket left the step: a request still pending there is withdrawn, so
 * it no longer waits on the Approvals page for a decision that decides
 * nothing. Called by the step hook, which sees every path.
 */
export async function withdrawApprovalsOfStep(
  session: Session, tenantId: string, entityId: string, stepName: string, at: string,
): Promise<number> {
  const rows = await runQuery<{ id: string }>(session, `
    MATCH (a:ApprovalRequest {tenant_id: $tenantId, entity_id: $entityId, step_name: $stepName, status: 'pending'})
    SET a.status = 'cancelled', a.resolved_at = $at, a.resolution_note = 'The ticket left the step before a decision'
    RETURN a.id AS id
  `, { tenantId, entityId, stepName, at })
  if (rows.length > 0) log.info({ tenantId, entityId, stepName, withdrawn: rows.length }, 'Approval requests withdrawn: the ticket left their step')
  return rows.length
}

interface StepInfo { name: string; isTerminal: boolean; category: string | null; purpose: string | null }

/**
 * Where a decided request sends the ticket: the one way forward (approved),
 * or the one step of category `failed` (rejected). null when there is none,
 * or more than one: then a person chooses.
 */
export function decidedTarget(
  decision: 'approved' | 'rejected', available: readonly string[], steps: readonly StepInfo[],
): string | null {
  const byName = new Map(steps.map((s) => [s.name, s]))
  const candidates = available.filter((name) => {
    const s = byName.get(name)
    if (!s) return false
    return decision === 'approved'
      ? !s.isTerminal && s.purpose !== 'approval'
      : s.isTerminal && s.category === 'failed'
  })
  return candidates.length === 1 ? candidates[0]! : null
}

/**
 * The transitions a person may be offered: those the approval does not hold
 * (all of them with `approval.override`). The buttons the ticket page shows
 * must be the ones the mutation accepts.
 */
export async function transitionsOpenToApproval<T extends { toStep: string }>(
  session: Session, tenantId: string, instanceId: string, transitions: readonly T[], override: boolean,
): Promise<T[]> {
  if (override) return [...transitions]
  const out: T[] = []
  for (const tr of transitions) {
    if (!(await ticketApprovalRefusal(session, tenantId, instanceId, tr.toStep))) out.push(tr)
  }
  return out
}
