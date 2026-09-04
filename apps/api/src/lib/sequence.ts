import type { Session, ManagedTransaction, QueryResult } from 'neo4j-driver'
import neo4j from 'neo4j-driver'

/**
 * Atomic, per-tenant monotonic counters for human-facing numbers
 * (INC/PRB/REQ/CHG/TASK…).
 *
 * The old `count()+1` / `max()+1` pattern is a race: two concurrent creates read
 * the same value and mint the same number. A `MERGE (c:Counter{...}) SET c.value
 * = c.value + N` takes a write lock on the single Counter node, so concurrent
 * increments serialise and every caller gets a distinct value. The uniqueness
 * constraints on (tenant_id, number)/(tenant_id, code) remain the safety net.
 *
 * Counters are seeded to the current maximum by `packages/neo4j` init, so
 * introducing them on an existing dataset does not restart numbering from 1.
 * A create that fails after reserving a value leaves a gap — acceptable.
 *
 * Accepts a Session (opens its own write tx) or a ManagedTransaction
 * (participates in the caller's open transaction, so the counter lock is held
 * until that transaction commits).
 */
export type SessionOrTx = Session | ManagedTransaction

function toInt(v: unknown): number {
  if (typeof v === 'number') return v
  if (v && typeof (v as neo4j.Integer).toNumber === 'function') return (v as neo4j.Integer).toNumber()
  return Number(v)
}

async function runCounter(sessionOrTx: SessionOrTx, cypher: string, params: Record<string, unknown>): Promise<QueryResult> {
  // A Session exposes executeWrite (managed retries); a ManagedTransaction only run().
  if ('executeWrite' in sessionOrTx && typeof (sessionOrTx as Session).executeWrite === 'function') {
    return (sessionOrTx as Session).executeWrite((tx) => tx.run(cypher, params))
  }
  return (sessionOrTx as ManagedTransaction).run(cypher, params)
}

/** Reserve and return the next value for (tenant_id, kind). */
export async function nextSequenceValue(sessionOrTx: SessionOrTx, tenantId: string, kind: string): Promise<number> {
  const res = await runCounter(
    sessionOrTx,
    `MERGE (c:Counter {tenant_id: $tenantId, kind: $kind})
     ON CREATE SET c.value = 1
     ON MATCH  SET c.value = c.value + 1
     RETURN c.value AS value`,
    { tenantId, kind },
  )
  return toInt(res.records[0]!.get('value'))
}

/**
 * Reserve a contiguous block of `count` values and return the last one.
 * The block is [last-count+1 .. last]. Used for batch task-code generation.
 */
export async function nextSequenceBlock(sessionOrTx: SessionOrTx, tenantId: string, kind: string, count: number): Promise<number> {
  const res = await runCounter(
    sessionOrTx,
    `MERGE (c:Counter {tenant_id: $tenantId, kind: $kind})
     ON CREATE SET c.value = $count
     ON MATCH  SET c.value = c.value + $count
     RETURN c.value AS value`,
    { tenantId, kind, count: neo4j.int(count) },
  )
  return toInt(res.records[0]!.get('value'))
}
