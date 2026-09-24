/**
 * Wave 7 · A1 (review of 23 Sep 2026): the SLA sweep finds its candidates
 * through two composite indexes, not by reading every SLA of the tenant.
 *
 *  - (tenant_id, breached, resolve_met): an open SLA not yet breached is
 *    exactly `breached = false AND resolve_met = false`.
 *  - (tenant_id, response_met): a response still owed.
 *
 * The indexes are declared in packages/neo4j/src/init.ts (the single source
 * of the schema); here they are created with the same form, for a database
 * that already exists.
 *
 * And the warnings already due: an open SLA whose warning time has passed is
 * marked as warned for its current deadline (`warning_sent_for`). Its job
 * either fired — and the sweep must not send it again — or was lost, and a
 * warning that late adds nothing to the breach the sweep will fire. Checked
 * before writing (24 Sep 2026): 21 such SLAs, all in demo-opengrafo.
 *
 * Idempotent: `IF NOT EXISTS`, and the marking skips SLAs already marked.
 */
import type { Migration } from '@opengraphity/neo4j'

export const slaSweepIndexes: Migration = {
  id:          '20261009_1010_sla_sweep_indexes',
  description: 'Wave 7 · A1: indexes for the SLA sweep, and the warnings already due marked as sent',

  async up(session) {
    await session.run('CREATE INDEX sla_status_tenant_open IF NOT EXISTS FOR (n:SLAStatus) ON (n.tenant_id, n.breached, n.resolve_met)')
    await session.run('CREATE INDEX sla_status_tenant_response IF NOT EXISTS FOR (n:SLAStatus) ON (n.tenant_id, n.response_met)')
    await session.run('CALL db.awaitIndexes(300)')
    const res = await session.run(`
      MATCH (s:SLAStatus {breached: false, resolve_met: false})
      WHERE s.resolved_at IS NULL AND s.warning_sent_for IS NULL
        AND s.resolve_deadline IS NOT NULL AND s.tier_warning_minutes IS NOT NULL
        AND datetime(s.resolve_deadline) - duration({minutes: toInteger(s.tier_warning_minutes)}) <= datetime()
      SET s.warning_sent_for = s.resolve_deadline
      RETURN count(s) AS n`)
    console.log(`  2 indexes checked, ${String(res.records[0]?.get('n') ?? 0)} warning(s) already due marked as sent`)
  },
  // Schema commands do not run in the marker's transaction: Neo4j refuses them.
  autocommit: true,
}
