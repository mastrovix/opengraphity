/**
 * The CMDB chains of a tenant, in Neo4j: one `CMDBChain` node each, its tree
 * of types kept whole as JSON (`nodes_json`) — a chain is read and saved as
 * one thing, never a link at a time. The name is unique in the tenant,
 * case aside (`name_key`, constraint `cmdb_chain_name_unique`).
 */
import type { Session } from 'neo4j-driver'
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { CHAIN_KINDS, type ChainKind, type ChainNode, type CmdbChain } from './model.js'

interface ChainRow {
  id: string; name: string; kind: string; nodes: string; createdAt: string | null; updatedAt: string | null
}

function toChain(row: ChainRow): CmdbChain {
  if (!(CHAIN_KINDS as readonly string[]).includes(row.kind)) throw new Error(`CMDBChain ${row.id} has kind "${row.kind}", not one of ${CHAIN_KINDS.join(', ')}`)
  let nodes: ChainNode[]
  try { nodes = JSON.parse(row.nodes) as ChainNode[] } catch (e) {
    throw new Error(`CMDBChain ${row.id}: nodes_json is not JSON (${e instanceof Error ? e.message : String(e)})`, { cause: e })
  }
  if (!Array.isArray(nodes)) throw new Error(`CMDBChain ${row.id}: nodes_json is not a list`)
  return { id: row.id, name: row.name, kind: row.kind as ChainKind, nodes, createdAt: row.createdAt, updatedAt: row.updatedAt }
}

export async function listChains(session: Session, tenantId: string): Promise<CmdbChain[]> {
  const rows = await runQuery<ChainRow>(session, `
    MATCH (c:CMDBChain {tenant_id: $tenantId})
    RETURN c.id AS id, c.name AS name, c.kind AS kind, c.nodes_json AS nodes, c.created_at AS createdAt, c.updated_at AS updatedAt
    ORDER BY c.name_key`, { tenantId })
  return rows.map(toChain)
}

async function assertNameFree(session: Session, tenantId: string, name: string, exceptId: string | null): Promise<void> {
  const row = await runQueryOne<{ id: string }>(session, `
    MATCH (c:CMDBChain {tenant_id: $tenantId, name_key: $nameKey})
    WHERE $exceptId IS NULL OR c.id <> $exceptId
    RETURN c.id AS id LIMIT 1`, { tenantId, nameKey: name.toLowerCase(), exceptId })
  if (row) throw new ValidationError(`A chain named "${name}" already exists`, { key: 'errors.cmdbChain.nameTaken', params: { name } })
}

export interface ChainWrite { name: string; kind: ChainKind; nodes: ChainNode[] }

export async function createChain(session: Session, tenantId: string, id: string, chain: ChainWrite, by: string): Promise<CmdbChain> {
  await assertNameFree(session, tenantId, chain.name, null)
  const now = new Date().toISOString()
  const rows = await session.executeWrite((tx) => tx.run(`
    CREATE (c:CMDBChain {id: $id, tenant_id: $tenantId, name: $name, name_key: $nameKey, kind: $kind, nodes_json: $nodes,
      created_at: $now, updated_at: $now, created_by: $by, updated_by: $by})
    RETURN c.id AS id, c.name AS name, c.kind AS kind, c.nodes_json AS nodes, c.created_at AS createdAt, c.updated_at AS updatedAt`, { id, tenantId, name: chain.name, nameKey: chain.name.toLowerCase(), kind: chain.kind, nodes: JSON.stringify(chain.nodes), now, by }))
  return toChain(rows.records[0]!.toObject() as ChainRow)
}

export async function updateChain(session: Session, tenantId: string, id: string, chain: ChainWrite, by: string): Promise<CmdbChain> {
  await assertNameFree(session, tenantId, chain.name, id)
  const rows = await session.executeWrite((tx) => tx.run(`
    MATCH (c:CMDBChain {id: $id, tenant_id: $tenantId})
    SET c.name = $name, c.name_key = $nameKey, c.kind = $kind, c.nodes_json = $nodes, c.updated_at = $now, c.updated_by = $by
    RETURN c.id AS id, c.name AS name, c.kind AS kind, c.nodes_json AS nodes, c.created_at AS createdAt, c.updated_at AS updatedAt`, { id, tenantId, name: chain.name, nameKey: chain.name.toLowerCase(), kind: chain.kind, nodes: JSON.stringify(chain.nodes), now: new Date().toISOString(), by }))
  const record = rows.records[0]
  if (!record) throw new NotFoundError('CMDBChain', id)
  return toChain(record.toObject() as ChainRow)
}

/** The chain removed, with its name for the audit; a chain that is not there is an error. */
export async function deleteChain(session: Session, tenantId: string, id: string): Promise<string> {
  const rows = await session.executeWrite((tx) => tx.run(`
    MATCH (c:CMDBChain {id: $id, tenant_id: $tenantId})
    WITH c, c.name AS name
    DETACH DELETE c
    RETURN name`, { id, tenantId }))
  const record = rows.records[0]
  if (!record) throw new NotFoundError('CMDBChain', id)
  return String(record.get('name'))
}
