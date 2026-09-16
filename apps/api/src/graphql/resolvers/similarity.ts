/**
 * Semantic similarity resolvers — "incident simili" and "KB suggerita".
 *
 * Reads the source incident's stored embedding and queries the Neo4j vector
 * index. Truth-telling contract: `ready: false` when the embedding has not
 * been computed yet (async pipeline) — never conflated with "no results".
 */
import { kbArticlePublishedCypher } from '../../lib/kbPublished.js'
import { NotFoundError } from '../../lib/errors.js'
import { getSession, runQueryOne, toNumber } from '@opengraphity/neo4j'
import { vectorSearchForTenant } from '../../lib/vectorSearch.js'
import type { GraphQLContext } from '../../context.js'
import { vectorIndexName } from '../../services/embeddings.js'
import { aiFeatureEnabled } from '../../lib/aiSettings.js'
import { suggestTriage } from '../../services/triageService.js'
import { draftResolutionNotes, problemCandidates as findProblemCandidates, draftKbContent } from '../../services/postIncidentService.js'
import { createKBArticle } from './knowledgeBase.js'

const num = toNumber

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
    if (!row) throw new NotFoundError('Incident')
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
  // Embedding spenti dall'organizzazione (ondata 6): lo si dice, non «non ancora pronto».
  if (!(await aiFeatureEnabled(ctx.tenantId, 'embeddings'))) return { ready: false, disabled: true, items: [] }
  const embedding = await loadEmbedding(args.incidentId, ctx.tenantId)
  if (!embedding) return { ready: false, disabled: false, items: [] }

  const session = getSession(undefined, 'READ')
  try {
    // L'indice è cross-tenant e contiene l'incident di partenza: K cresce
    // finché i vicini DEL TENANT bastano (revisione totale · B-12).
    const rows = await vectorSearchForTenant<{
      id: string; number: string | null; title: string; status: string
      severity: string; createdAt: string | null; resolvedAt: string | null; score: number
    }>(session, {
      index: vectorIndexName('Incident'),
      embedding,
      tenantId: ctx.tenantId,
      limit,
      where: 'node.id <> $incidentId',
      returns: `node.id AS id, node.number AS number, node.title AS title,
             node.status AS status, node.severity AS severity,
             node.created_at AS createdAt, node.resolved_at AS resolvedAt,
             score`,
      params: { incidentId: args.incidentId },
      what: 'similarIncidents',
    })
    return { ready: true, disabled: false, items: rows.map(r => ({ ...r, score: num(r.score) })) }
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
  if (!(await aiFeatureEnabled(ctx.tenantId, 'embeddings'))) return { ready: false, disabled: true, items: [] }
  const embedding = await loadEmbedding(args.incidentId, ctx.tenantId)
  if (!embedding) return { ready: false, disabled: false, items: [] }

  const session = getSession(undefined, 'READ')
  try {
    const rows = await vectorSearchForTenant<{
      id: string; title: string; slug: string | null; category: string | null; score: number
    }>(session, {
      index: vectorIndexName('KBArticle'),
      embedding,
      tenantId: ctx.tenantId,
      limit,
      where: kbArticlePublishedCypher('node'),
      returns: `node.id AS id, node.title AS title, node.slug AS slug,
             node.category AS category, score`,
      what: 'suggestedArticles',
    })
    return { ready: true, disabled: false, items: rows.map(r => ({ ...r, score: num(r.score) })) }
  } finally {
    await session.close()
  }
}

async function triageSuggestion(
  _: unknown,
  args: { title: string; description?: string | null; ciIds?: string[] | null },
  ctx: GraphQLContext,
) {
  return suggestTriage({
    tenantId:    ctx.tenantId,
    title:       args.title,
    description: args.description ?? null,
    ciIds:       args.ciIds ?? [],
  })
}

async function resolutionDraft(
  _: unknown,
  args: { incidentId: string },
  ctx: GraphQLContext,
) {
  return { draft: await draftResolutionNotes(ctx.tenantId, args.incidentId) }
}

async function problemCandidates(_: unknown, __: unknown, ctx: GraphQLContext) {
  return findProblemCandidates(ctx.tenantId)
}

async function createKbDraftFromIncident(
  _: unknown,
  args: { incidentId: string },
  ctx: GraphQLContext,
): Promise<unknown> {
  const content = await draftKbContent(ctx.tenantId, args.incidentId)
  // Reuses the standard KB creation path: slug, initial (draft) workflow step, audit.
  return createKBArticle(null, { title: content.title, body: content.body, category: content.category, tags: content.tags }, ctx)
}

export const similarityResolvers = {
  Query:    { similarIncidents, suggestedArticles, triageSuggestion, resolutionDraft, problemCandidates },
  Mutation: { createKbDraftFromIncident },
}
