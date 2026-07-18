/**
 * Semantic similarity resolvers — "incident simili" and "KB suggerita".
 *
 * Reads the source incident's stored embedding and queries the Neo4j vector
 * index. Truth-telling contract: `ready: false` when the embedding has not
 * been computed yet (async pipeline) — never conflated with "no results".
 */
import { GraphQLError } from 'graphql'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { vectorIndexName } from '../../services/embeddings.js'

interface Neo4jInt { toNumber(): number }
function num(v: unknown): number {
  return typeof v === 'object' && v !== null && 'toNumber' in v ? (v as Neo4jInt).toNumber() : Number(v)
}

async function loadEmbedding(
  incidentId: string,
  tenantId: string,
): Promise<number[] | null> {
  const session = getSession(undefined, 'READ')
  try {
    const row = await runQueryOne<{ embedding: number[] | null }>(session, `
      MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
      RETURN i.embedding AS embedding
    `, { incidentId, tenantId })
    if (!row) throw new GraphQLError('Incident non trovato', { extensions: { code: 'NOT_FOUND' } })
    return row.embedding
  } finally {
    await session.close()
  }
}

async function similarIncidents(
  _: unknown,
  args: { incidentId: string; limit?: number | null },
  ctx: GraphQLContext,
) {
  const limit = Math.min(Math.max(args.limit ?? 5, 1), 20)
  const embedding = await loadEmbedding(args.incidentId, ctx.tenantId)
  if (!embedding) return { ready: false, items: [] }

  const session = getSession(undefined, 'READ')
  try {
    // Over-fetch: the index is cross-tenant and includes the source incident,
    // both filtered out below.
    const rows = await runQuery<{
      id: string; number: string | null; title: string; status: string
      severity: string; createdAt: string | null; resolvedAt: string | null; score: number
    }>(session, `
      CALL db.index.vector.queryNodes($index, ${limit * 4 + 10}, $embedding)
      YIELD node, score
      WHERE node.tenant_id = $tenantId AND node.id <> $incidentId
      RETURN node.id AS id, node.number AS number, node.title AS title,
             node.status AS status, node.severity AS severity,
             node.created_at AS createdAt, node.resolved_at AS resolvedAt,
             score
      ORDER BY score DESC
      LIMIT ${limit}
    `, {
      index: vectorIndexName('Incident'),
      embedding,
      tenantId: ctx.tenantId,
      incidentId: args.incidentId,
    })
    return { ready: true, items: rows.map(r => ({ ...r, score: num(r.score) })) }
  } finally {
    await session.close()
  }
}

async function suggestedArticles(
  _: unknown,
  args: { incidentId: string; limit?: number | null },
  ctx: GraphQLContext,
) {
  const limit = Math.min(Math.max(args.limit ?? 3, 1), 10)
  const embedding = await loadEmbedding(args.incidentId, ctx.tenantId)
  if (!embedding) return { ready: false, items: [] }

  const session = getSession(undefined, 'READ')
  try {
    const rows = await runQuery<{
      id: string; title: string; slug: string | null; category: string | null; score: number
    }>(session, `
      CALL db.index.vector.queryNodes($index, ${limit * 4 + 10}, $embedding)
      YIELD node, score
      WHERE node.tenant_id = $tenantId AND node.status = 'published'
      RETURN node.id AS id, node.title AS title, node.slug AS slug,
             node.category AS category, score
      ORDER BY score DESC
      LIMIT ${limit}
    `, {
      index: vectorIndexName('KBArticle'),
      embedding,
      tenantId: ctx.tenantId,
    })
    return { ready: true, items: rows.map(r => ({ ...r, score: num(r.score) })) }
  } finally {
    await session.close()
  }
}

export const similarityResolvers = {
  Query: { similarIncidents, suggestedArticles },
}
