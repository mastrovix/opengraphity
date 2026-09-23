/**
 * THE ORGANIZATION'S AUTOMATIONS (tour of 23 Sep 2026, D68).
 *
 * Three years of operation and not one Auto Trigger or Business Rule. A
 * service desk writes a few over time, and these are two that a company in
 * the EU writes early: a security incident is checked for personal data
 * within 72 hours (GDPR art. 33), and a request for privileged access is
 * something the administrators want to know about the moment it is asked.
 *
 * They are created with the app's own mutations (every validation runs, the
 * roles they notify must exist), on a day of the tenant's life, and they have
 * FIRED since: an automation that fires writes its Audit Log entry
 * (`trigger.executed` / `business_rule.executed`, by `automation`) and a
 * trigger counts its runs. The firings are read from the tickets this run
 * wrote — the security incidents and the privileged-access requests opened
 * after the day the automation was written — so the counter, the last run
 * and the entries are the same story. Their only action is an in-app
 * notification: nothing on the tickets changes, and the history of the
 * tickets stays the one the simulation wrote.
 */
import type { Session } from 'neo4j-driver'
import { runQuery } from '@opengraphity/neo4j'
import { AUTOMATION_ACTOR } from '@opengraphity/types'
import type { GraphQLContext } from '../../../auth/resolveAuth.js'
import { automationResolvers } from '../../../graphql/resolvers/automation.js'
import type { Rng } from './random.js'
import { DAY, type DemoClock } from './clock.js'
import { auditRow, type AuditRow } from './writeReference.js'

export interface DemoAutomation {
  kind: 'trigger' | 'rule'
  /** The mutation's input, as the page sends it. */
  input: Record<string, unknown>
  /** How long ago it was written. */
  writtenDaysAgo: number
  /** The tickets it fired on: id and instant of the event, oldest first (`$since` is the day it was written). */
  firings: string
  firingParams?: Record<string, unknown>
}

/** The automations of the demo. `privilegedItemId` is the catalog item «Privileged Access» (null: that trigger is left out). */
export function demoAutomations(privilegedItemId: string | null): DemoAutomation[] {
  const notify = (message: string, target: string): string => JSON.stringify([{ type: 'create_notification', params: { message, channel: 'in_app', target } }])
  const out: DemoAutomation[] = [{
    kind: 'rule',
    input: {
      name: 'Security incident: personal data check',
      description: 'Every security incident is checked within 72 hours for personal data (GDPR art. 33).',
      entityType: 'incident', eventType: 'on_create', conditionLogic: 'and',
      conditions: JSON.stringify([{ field: 'category', operator: 'equals', value: 'security' }]),
      actions: notify('Security incident opened: check within 72 hours whether personal data are involved (GDPR art. 33).', 'role:admin'),
      priority: 10, stopOnMatch: false, enabled: true,
    },
    writtenDaysAgo: 420,
    firings: `
      MATCH (i:Incident {tenant_id: $tenantId})
      WHERE i.demo_run_id = $runId AND i.category = 'security' AND i.created_at >= $since
      RETURN i.id AS id, i.created_at AS at ORDER BY at`,
  }]
  if (privilegedItemId) {
    out.push({
      kind: 'trigger',
      input: {
        name: 'Privileged access requested: tell the administrators',
        entityType: 'service_request', eventType: 'on_create',
        conditions: JSON.stringify([{ field: 'catalog_item_id', operator: 'equals', value: privilegedItemId }]),
        actions: notify('Privileged access has been requested: it needs an administrator\'s approval.', 'role:admin'),
        enabled: true,
      },
      writtenDaysAgo: 240,
      firings: `
        MATCH (r:ServiceRequest {tenant_id: $tenantId})
        WHERE r.demo_run_id = $runId AND r.catalog_item_id = $itemId AND r.created_at >= $since
        RETURN r.id AS id, r.created_at AS at ORDER BY at`,
      firingParams: { itemId: privilegedItemId },
    })
  }
  return out
}

/** Creates one automation with the app's mutation and returns its id. */
export async function createAutomation(ctx: GraphQLContext, a: DemoAutomation): Promise<string> {
  const m = automationResolvers.Mutation as unknown as Record<string, (p: unknown, args: unknown, c: GraphQLContext) => Promise<{ id: string }>>
  const created = await m[a.kind === 'trigger' ? 'createAutoTrigger' : 'createBusinessRule']!(null, { input: a.input }, ctx)
  return created.id
}

/**
 * What the engine left behind for each firing: the Audit Log entry
 * (`automationEngine.ts`: by `automation`, e-mail `system`), and for a trigger
 * the counter and the last run (`triggerEngine.ts`).
 */
export async function automationFirings(
  session: Session, rng: Rng, tenantId: string, runId: string, a: DemoAutomation, id: string, writtenAtMs: number,
): Promise<{ audits: AuditRow[]; last: string | null }> {
  const rows = await runQuery<{ id: string; at: string }>(session, a.firings, { ...a.firingParams, tenantId, runId, since: new Date(writtenAtMs).toISOString() })
  const actor = { id: AUTOMATION_ACTOR, email: 'system' }
  const name = String(a.input['name'])
  const audits = rows.map((r) => auditRow(rng, actor, a.kind === 'trigger' ? 'trigger.executed' : 'business_rule.executed',
    a.kind === 'trigger' ? 'AutoTrigger' : 'BusinessRule', id, Date.parse(r.at) + rng.int(1, 4) * 1000,
    { [a.kind === 'trigger' ? 'triggerName' : 'ruleName']: name, entityId: r.id, actionsRun: 1, actionsAttempted: 1 }))
  return { audits, last: audits.length ? audits[audits.length - 1]!.created_at : null }
}

/** The day it was written: a working moment `writtenDaysAgo` back, inside the tenant's life. */
export function writtenAt(rng: Rng, clock: DemoClock, a: DemoAutomation): number {
  const day = Math.max(clock.startMs + 30 * DAY, clock.nowMs - a.writtenDaysAgo * DAY)
  return clock.workInstant(rng, day, day + DAY)
}
