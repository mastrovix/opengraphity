/**
 * HOW SEVERE AN ALARM IS OUTSIDE PRODUCTION (browser tour of 23 Sep 2026).
 *
 * The owner's choice: a critical alarm opens a High incident in production and
 * a Medium one elsewhere. The policy now has a second map from alarm severity
 * to impact and urgency, used for the CIs whose environment is not among the
 * production ones. This migration adds the two keys to the policies that lack
 * them, switched OFF (`non_production_severity_map = null`: the same map
 * everywhere, as before) with `production` as the production environment —
 * the day it runs, no incident changes priority.
 *
 * As in the 1050 and the 1810, the values are FROZEN here, not read from
 * `DEFAULT_EVENT_POLICY`, which evolves.
 */
import type { Migration } from '@opengraphity/neo4j'
import { DEFAULT_EVENT_POLICY, EVENT_POLICY_V8_KEYS, completeEventPolicy, type EventPolicy } from '../../lib/eventPolicy.js'

const POLICY_7_OCT: EventPolicy = {
  ...DEFAULT_EVENT_POLICY,
  production_environments:     ['production'],
  non_production_severity_map: null,
}

function parseObject(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== 'string') throw new Error(`${what} is not a JSON string (got ${typeof raw}); fix it before migrating`)
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch (e) { throw new Error(`${what} is corrupt JSON (${e instanceof Error ? e.message : String(e)}); fix it before migrating`, { cause: e }) }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${what} is not a JSON object; fix it before migrating`)
  return parsed as Record<string, unknown>
}

export const eventPolicyNonProduction: Migration = {
  id: '20261007_1040_event_policy_non_production',
  description: `Tour of 23 Sep 2026: add ${EVENT_POLICY_V8_KEYS.join(', ')} to every Tenant.event_policy that lacks them (switched off: the same severity map everywhere)`,
  async up(session) {
    const now = new Date().toISOString()
    const tenants = await session.run(`
      MATCH (t:Tenant)
      WHERE t.id IS NOT NULL AND t.event_policy IS NOT NULL AND t.event_policy <> ''
      RETURN t.id AS id, t.event_policy AS policy
      ORDER BY t.id
    `)
    let completed = 0
    let unchanged = 0
    for (const record of tenants.records) {
      const tenantId = String(record.get('id'))
      const full = completeEventPolicy(parseObject(record.get('policy'), `Tenant ${tenantId} event_policy`), POLICY_7_OCT)
      if (!full) { unchanged++; continue }
      await session.run(
        'MATCH (t:Tenant {id: $tenantId}) SET t.event_policy = $policy, t.updated_at = $now',
        { tenantId, policy: JSON.stringify(full), now },
      )
      completed++
    }
    console.log(`[${eventPolicyNonProduction.id}] event_policy: ${String(completed)} completed, ${String(unchanged)} already had ${EVENT_POLICY_V8_KEYS.join(', ')}`)
  },
}
