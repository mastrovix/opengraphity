/**
 * THE NODES OF ONE TENANT, LABEL BY LABEL (review of 23 Sep 2026).
 *
 * `MATCH (n {tenant_id: $id})` has no label: it scans every node of the
 * database, every customer's. The demo cleaner learned it the hard way — the
 * same query with `CALL … IN TRANSACTIONS` made the server fall at 5 million
 * nodes and left the tenant half deleted (lib/testData/demoTenant/clean.ts).
 * The tenant purge and its confirmation screen ran exactly that query. Here
 * the labels come from the database and each is read on its own: Neo4j starts
 * from that label (and its `tenant_id` index where there is one), and the
 * deletion runs in real transactions of a thousand rows.
 */
import type { Session } from 'neo4j-driver'
import { runQuery, toNumber } from '@opengraphity/neo4j'

/** A label read from the database, as a Cypher identifier. */
const quoted = (label: string): string => '`' + label.replace(/`/g, '``') + '`'

async function allLabels(session: Session): Promise<string[]> {
  const rows = await runQuery<{ label: string }>(session, 'CALL db.labels() YIELD label RETURN label ORDER BY label', {})
  return rows.map((r) => r.label)
}

/**
 * How many nodes of the tenant each label has (the labels with none are left
 * out). A node with several labels counts under each: the numbers say where
 * the tenant's data is, not a total.
 */
export async function countTenantNodesByLabel(session: Session, tenantId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const label of await allLabels(session)) {
    // In a variable, in the label's position: the Cypher check verifies the query around it.
    const lbl = quoted(label)
    const rows = await runQuery<{ n: unknown }>(session, `MATCH (n:${lbl} {tenant_id: $tenantId}) RETURN count(n) AS n`, { tenantId })
    const n = toNumber(rows[0]?.n)
    if (n > 0) out[label] = n
  }
  return out
}

/**
 * Deletes every node of the tenant, label by label, a thousand rows per
 * transaction. Re-runnable: a purge interrupted halfway is finished by
 * running it again. Returns how many nodes were deleted.
 */
export async function deleteTenantNodes(session: Session, tenantId: string): Promise<number> {
  let deleted = 0
  for (const label of await allLabels(session)) {
    const lbl = quoted(label)
    const rows = await runQuery<{ n: unknown }>(session, `
      MATCH (n:${lbl} {tenant_id: $tenantId})
      CALL (n) { DETACH DELETE n } IN TRANSACTIONS OF 1000 ROWS
      RETURN count(*) AS n
    `, { tenantId })
    deleted += toNumber(rows[0]?.n)
  }
  return deleted
}
