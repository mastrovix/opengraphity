import { withSession, ciTypeFromLabels, runQuery } from './ci-utils.js'
import type { GraphQLContext } from '../../context.js'
import type { Props } from './ci-utils.js'

// Same whitelist as ci.ts — searchable CI labels
const CI_LABELS = [
  'Application', 'Database', 'DatabaseInstance', 'Server', 'Certificate',
  'SslCertificate', 'VirtualMachine', 'NetworkDevice', 'Storage',
  'CloudService', 'ApiEndpoint', 'Microservice',
]

export interface SearchHit {
  entityType: string
  id:         string
  number:     string | null
  title:      string
  status:     string | null
  ciType:     string | null
  slug:       string | null
}

/**
 * Tenant-scoped search across the main ITSM entities (title/number/name,
 * case-insensitive CONTAINS). Powers the command palette — a handful of
 * per-label indexed lookups with small limits, not a fulltext engine.
 */
async function globalSearch(
  _: unknown,
  args: { query: string; limitPerType?: number },
  ctx: GraphQLContext,
): Promise<SearchHit[]> {
  const q = args.query.trim()
  if (q.length < 2) return []
  const limit = Math.min(Math.max(args.limitPerType ?? 5, 1), 20)

  return withSession(async (session) => {
    const params = { tenantId: ctx.tenantId, q: q.toLowerCase(), limit }

    // ITSM entities: matched on title or number
    const TICKET_TYPES: Array<{ label: string; entityType: string }> = [
      { label: 'Incident',       entityType: 'incident' },
      { label: 'Change',         entityType: 'change' },
      { label: 'Problem',        entityType: 'problem' },
      { label: 'ServiceRequest', entityType: 'service_request' },
    ]

    const hits: SearchHit[] = []

    for (const { label, entityType } of TICKET_TYPES) {
      const rows = await runQuery<{ props: Props }>(session, `
        MATCH (n:${label} {tenant_id: $tenantId})
        WHERE toLower(n.title) CONTAINS $q OR toLower(coalesce(n.number, n.code, '')) CONTAINS $q
        RETURN properties(n) AS props
        ORDER BY n.created_at DESC LIMIT toInteger($limit)
      `, params)
      for (const r of rows) {
        hits.push({
          entityType,
          id:     r.props['id'] as string,
          number: (r.props['number'] ?? r.props['code'] ?? null) as string | null,
          title:  r.props['title'] as string,
          status: (r.props['status'] ?? null) as string | null,
          ciType: null,
          slug:   null,
        })
      }
    }

    // Configuration items: matched on name
    const ciLabelFilter = CI_LABELS.map((l) => `n:${l}`).join(' OR ')
    const ciRows = await runQuery<{ props: Props; labels: string[] }>(session, `
      MATCH (n) WHERE (${ciLabelFilter}) AND n.tenant_id = $tenantId
        AND toLower(n.name) CONTAINS $q
      RETURN properties(n) AS props, labels(n) AS labels
      ORDER BY n.name ASC LIMIT toInteger($limit)
    `, params)
    for (const r of ciRows) {
      hits.push({
        entityType: 'ci',
        id:     r.props['id'] as string,
        number: null,
        title:  r.props['name'] as string,
        status: (r.props['status'] ?? null) as string | null,
        ciType: ciTypeFromLabels(r.labels),
        slug:   null,
      })
    }

    // KB articles: matched on title, navigated by slug
    const kbRows = await runQuery<{ props: Props }>(session, `
      MATCH (n:KBArticle {tenant_id: $tenantId})
      WHERE toLower(n.title) CONTAINS $q
      RETURN properties(n) AS props
      ORDER BY n.updated_at DESC LIMIT toInteger($limit)
    `, params)
    for (const r of kbRows) {
      hits.push({
        entityType: 'kb_article',
        id:     r.props['id'] as string,
        number: null,
        title:  r.props['title'] as string,
        status: (r.props['status'] ?? null) as string | null,
        ciType: null,
        slug:   (r.props['slug'] ?? null) as string | null,
      })
    }

    return hits
  })
}

export const globalSearchResolvers = {
  Query: { globalSearch },
}
