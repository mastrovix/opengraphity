import { withSession, ciTypeFromLabels, runQuery } from './ci-utils.js'
import type { GraphQLContext } from '../../context.js'
import type { Props } from './ci-utils.js'

const TICKET_LABELS: Record<string, string> = {
  Incident:       'incident',
  Change:         'change',
  Problem:        'problem',
  ServiceRequest: 'service_request',
  KBArticle:      'kb_article',
}

export interface SearchHit {
  entityType: string
  id:         string
  number:     string | null
  title:      string
  status:     string | null
  ciType:     string | null
  slug:       string | null
}

/** Escape Lucene syntax and turn each term into a prefix match. */
function toLucene(raw: string): string {
  const terms = raw
    .split(/\s+/)
    .map((t) => t.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, (c) => `\\${c}`))
    .filter(Boolean)
  if (!terms.length) return ''
  return terms.map((t) => `${t}*`).join(' AND ')
}

/**
 * Tenant-scoped search across the main ITSM entities, backed by the
 * `global_search` fulltext index (see infra/neo4j/init/constraints.cypher) —
 * indexed prefix search instead of unindexed CONTAINS scans.
 */
async function globalSearch(
  _: unknown,
  args: { query: string; limitPerType?: number },
  ctx: GraphQLContext,
): Promise<SearchHit[]> {
  const q = args.query.trim()
  if (q.length < 2) return []
  const limitPerType = Math.min(Math.max(args.limitPerType ?? 5, 1), 20)
  const lucene = toLucene(q)
  if (!lucene) return []

  return withSession(async (session) => {
    // Over-fetch, then cap per type in JS: the index returns global relevance
    // order, and one very common type must not crowd out the others.
    const rows = await runQuery<{ props: Props; labels: string[] }>(session, `
      CALL db.index.fulltext.queryNodes('global_search', $lucene) YIELD node, score
      WHERE node.tenant_id = $tenantId
      RETURN properties(node) AS props, labels(node) AS labels
      ORDER BY score DESC
      LIMIT toInteger($fetchLimit)
    `, { lucene, tenantId: ctx.tenantId, fetchLimit: limitPerType * 12 })

    const perType = new Map<string, number>()
    const hits: SearchHit[] = []

    for (const r of rows) {
      const ticketLabel = r.labels.find((l) => TICKET_LABELS[l])
      const entityType  = ticketLabel ? TICKET_LABELS[ticketLabel]! : 'ci'
      const count = perType.get(entityType) ?? 0
      if (count >= limitPerType) continue
      perType.set(entityType, count + 1)

      hits.push({
        entityType,
        id:     r.props['id'] as string,
        number: (r.props['number'] ?? r.props['code'] ?? null) as string | null,
        title:  (r.props['title'] ?? r.props['name'] ?? '') as string,
        status: (r.props['status'] ?? null) as string | null,
        ciType: entityType === 'ci' ? ciTypeFromLabels(r.labels) : null,
        slug:   entityType === 'kb_article' ? ((r.props['slug'] ?? null) as string | null) : null,
      })
    }

    return hits
  })
}

export const globalSearchResolvers = {
  Query: { globalSearch },
}
