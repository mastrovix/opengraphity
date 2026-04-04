import { GraphQLError } from 'graphql'
import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { audit } from '../../lib/audit.js'
import { logger } from '../../lib/logger.js'

interface KBArticle {
  id:              string
  title:           string
  slug:            string
  body:            string
  category:        string
  tags:            string[]
  status:          string
  authorId:        string
  authorName:      string
  views:           number
  helpfulCount:    number
  notHelpfulCount: number
  createdAt:       string
  updatedAt:       string
  publishedAt:     string | null
}

interface KBCategory {
  name:  string
  count: number
}

function toInt(v: unknown): number {
  if (v == null) return 0
  if (typeof (v as { toNumber(): number }).toNumber === 'function') {
    return (v as { toNumber(): number }).toNumber()
  }
  return Number(v)
}

function mapArticle(r: { get: (k: string) => unknown }): KBArticle {
  return {
    id:              r.get('id')              as string,
    title:           r.get('title')           as string,
    slug:            r.get('slug')            as string,
    body:            r.get('body')            as string,
    category:        r.get('category')        as string,
    tags:            JSON.parse((r.get('tags') as string | null) ?? '[]') as string[],
    status:          r.get('status')          as string,
    authorId:        r.get('authorId')        as string,
    authorName:      r.get('authorName')      as string,
    views:           toInt(r.get('views')),
    helpfulCount:    toInt(r.get('helpfulCount')),
    notHelpfulCount: toInt(r.get('notHelpfulCount')),
    createdAt:       r.get('createdAt')       as string,
    updatedAt:       r.get('updatedAt')       as string,
    publishedAt:     r.get('publishedAt')     as string | null,
  }
}

const ARTICLE_RETURN = `
  RETURN a.id               AS id,
         a.title             AS title,
         a.slug              AS slug,
         a.body              AS body,
         a.category          AS category,
         a.tags              AS tags,
         a.status            AS status,
         a.author_id         AS authorId,
         a.author_name       AS authorName,
         a.views             AS views,
         a.helpful_count     AS helpfulCount,
         a.not_helpful_count AS notHelpfulCount,
         a.created_at        AS createdAt,
         a.updated_at        AS updatedAt,
         a.published_at      AS publishedAt
`

function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[àáâãäå]/g, 'a')
    .replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i')
    .replace(/[òóôõö]/g, 'o')
    .replace(/[ùúûü]/g, 'u')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)
}

// ── Queries ───────────────────────────────────────────────────────────────────

export async function kbArticles(
  _: unknown,
  args: { search?: string; category?: string; status?: string; page?: number; pageSize?: number },
  ctx: GraphQLContext,
): Promise<{ items: KBArticle[]; total: number }> {
  const page     = Math.max(1, args.page     ?? 1)
  const pageSize = Math.min(100, Math.max(1, args.pageSize ?? 20))
  const skip     = (page - 1) * pageSize

  const conditions: string[] = ['a.tenant_id = $tenantId']
  const params: Record<string, unknown> = { tenantId: ctx.tenantId, skip, limit: pageSize }

  if (args.status)   { conditions.push('a.status = $status');       params['status']   = args.status }
  if (args.category) { conditions.push('a.category = $category');   params['category'] = args.category }
  if (args.search)   { conditions.push('(toLower(a.title) CONTAINS toLower($search) OR toLower(a.body) CONTAINS toLower($search))'); params['search'] = args.search }

  const where = conditions.join(' AND ')

  const session = getSession(undefined, 'READ')
  try {
    const dataRes = await session.executeRead((tx) => tx.run(`
      MATCH (a:KBArticle)
      WHERE ${where}
      ${ARTICLE_RETURN}
      ORDER BY a.updated_at DESC
      SKIP toInteger($skip) LIMIT toInteger($limit)
    `, params))

    const countRes = await session.executeRead((tx) => tx.run(`
      MATCH (a:KBArticle)
      WHERE ${where}
      RETURN count(a) AS total
    `, params))

    const total = toInt(countRes.records[0]?.get('total'))
    return { items: dataRes.records.map(mapArticle), total }
  } finally {
    await session.close()
  }
}

export async function kbArticle(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
): Promise<KBArticle> {
  const session = getSession(undefined, 'WRITE')
  try {
    const res = await session.executeWrite((tx) => tx.run(`
      MATCH (a:KBArticle {id: $id, tenant_id: $tenantId})
      SET a.views = a.views + 1
      ${ARTICLE_RETURN}
    `, { id: args.id, tenantId: ctx.tenantId }))

    if (!res.records.length) {
      throw new GraphQLError('Article not found', { extensions: { code: 'NOT_FOUND' } })
    }
    return mapArticle(res.records[0])
  } finally {
    await session.close()
  }
}

export async function kbArticleBySlug(
  _: unknown,
  args: { slug: string },
  ctx: GraphQLContext,
): Promise<KBArticle> {
  const session = getSession(undefined, 'WRITE')
  try {
    const res = await session.executeWrite((tx) => tx.run(`
      MATCH (a:KBArticle {slug: $slug, tenant_id: $tenantId})
      SET a.views = a.views + 1
      ${ARTICLE_RETURN}
    `, { slug: args.slug, tenantId: ctx.tenantId }))

    if (!res.records.length) {
      throw new GraphQLError('Article not found', { extensions: { code: 'NOT_FOUND' } })
    }
    return mapArticle(res.records[0])
  } finally {
    await session.close()
  }
}

export async function kbCategories(
  _: unknown,
  __: unknown,
  ctx: GraphQLContext,
): Promise<KBCategory[]> {
  const session = getSession(undefined, 'READ')
  try {
    const res = await session.executeRead((tx) => tx.run(`
      MATCH (a:KBArticle {tenant_id: $tenantId, status: 'published'})
      RETURN a.category AS name, count(a) AS count
      ORDER BY count DESC
    `, { tenantId: ctx.tenantId }))
    return res.records.map((r) => ({
      name:  r.get('name')  as string,
      count: toInt(r.get('count')),
    }))
  } finally {
    await session.close()
  }
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export async function createKBArticle(
  _: unknown,
  args: { title: string; body: string; category: string; tags?: string[]; status?: string },
  ctx: GraphQLContext,
): Promise<KBArticle> {
  if (args.body.length > 50_000) {
    throw new GraphQLError('Article body exceeds 50000 characters', { extensions: { code: 'BAD_REQUEST' } })
  }

  const id     = uuidv4()
  const now    = new Date().toISOString()
  const status = args.status ?? 'draft'
  const slug   = generateSlug(args.title) + '-' + id.slice(0, 8)

  const session = getSession(undefined, 'WRITE')
  try {
    const res = await session.executeWrite((tx) => tx.run(`
      CREATE (a:KBArticle {
        id:               $id,
        tenant_id:        $tenantId,
        title:            $title,
        slug:             $slug,
        body:             $body,
        category:         $category,
        tags:             $tags,
        status:           $status,
        author_id:        $authorId,
        author_name:      $authorName,
        views:            0,
        helpful_count:    0,
        not_helpful_count: 0,
        created_at:       $now,
        updated_at:       $now,
        published_at:     $publishedAt
      })
      ${ARTICLE_RETURN}
    `, {
      id,
      tenantId:    ctx.tenantId,
      title:       args.title,
      slug,
      body:        args.body,
      category:    args.category,
      tags:        JSON.stringify(args.tags ?? []),
      status,
      authorId:    ctx.userId,
      authorName:  ctx.userEmail,
      now,
      publishedAt: status === 'published' ? now : null,
    }))

    const created = mapArticle(res.records[0])
    void audit(ctx, 'kb_article.created', 'KBArticle', id)
    return created
  } finally {
    await session.close()
  }
}

export async function updateKBArticle(
  _: unknown,
  args: { id: string; title?: string; body?: string; category?: string; tags?: string[]; status?: string },
  ctx: GraphQLContext,
): Promise<KBArticle> {
  if (args.body && args.body.length > 50_000) {
    throw new GraphQLError('Article body exceeds 50000 characters', { extensions: { code: 'BAD_REQUEST' } })
  }

  const session = getSession(undefined, 'WRITE')
  try {
    const loadRes = await session.executeRead((tx) => tx.run(`
      MATCH (a:KBArticle {id: $id, tenant_id: $tenantId})
      RETURN a.status AS status, a.published_at AS publishedAt
    `, { id: args.id, tenantId: ctx.tenantId }))

    if (!loadRes.records.length) {
      throw new GraphQLError('Article not found', { extensions: { code: 'NOT_FOUND' } })
    }

    const currentStatus    = loadRes.records[0].get('status')      as string
    const currentPublishedAt = loadRes.records[0].get('publishedAt') as string | null
    const now              = new Date().toISOString()

    const setters: string[] = ['a.updated_at = $now']
    const params: Record<string, unknown> = { id: args.id, tenantId: ctx.tenantId, now }

    if (args.title)    { setters.push('a.title = $title');       params['title']       = args.title }
    if (args.body)     { setters.push('a.body = $body');         params['body']        = args.body }
    if (args.category) { setters.push('a.category = $category'); params['category']    = args.category }
    if (args.tags)     { setters.push('a.tags = $tags');         params['tags']        = JSON.stringify(args.tags) }
    if (args.status) {
      setters.push('a.status = $status')
      params['status'] = args.status
      if (args.status === 'published' && currentStatus !== 'published') {
        setters.push('a.published_at = $publishedAt')
        params['publishedAt'] = now
      } else {
        params['publishedAt'] = currentPublishedAt
      }
    }

    const res = await session.executeWrite((tx) => tx.run(`
      MATCH (a:KBArticle {id: $id, tenant_id: $tenantId})
      SET ${setters.join(', ')}
      ${ARTICLE_RETURN}
    `, params))

    const updated = mapArticle(res.records[0])
    void audit(ctx, 'kb_article.updated', 'KBArticle', args.id)
    return updated
  } finally {
    await session.close()
  }
}

export async function deleteKBArticle(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
): Promise<boolean> {
  const session = getSession(undefined, 'WRITE')
  try {
    const loadRes = await session.executeRead((tx) => tx.run(`
      MATCH (a:KBArticle {id: $id, tenant_id: $tenantId})
      RETURN a.id AS id
    `, { id: args.id, tenantId: ctx.tenantId }))

    if (!loadRes.records.length) {
      throw new GraphQLError('Article not found', { extensions: { code: 'NOT_FOUND' } })
    }

    await session.executeWrite((tx) => tx.run(`
      MATCH (a:KBArticle {id: $id, tenant_id: $tenantId})
      DETACH DELETE a
    `, { id: args.id, tenantId: ctx.tenantId }))

    void audit(ctx, 'kb_article.deleted', 'KBArticle', args.id)
    return true
  } finally {
    await session.close()
  }
}

export async function rateKBArticle(
  _: unknown,
  args: { id: string; helpful: boolean },
  ctx: GraphQLContext,
): Promise<KBArticle> {
  const field = args.helpful ? 'a.helpful_count' : 'a.not_helpful_count'

  const session = getSession(undefined, 'WRITE')
  try {
    const res = await session.executeWrite((tx) => tx.run(`
      MATCH (a:KBArticle {id: $id, tenant_id: $tenantId})
      SET ${field} = ${field} + 1
      ${ARTICLE_RETURN}
    `, { id: args.id, tenantId: ctx.tenantId }))

    if (!res.records.length) {
      throw new GraphQLError('Article not found', { extensions: { code: 'NOT_FOUND' } })
    }
    return mapArticle(res.records[0])
  } finally {
    await session.close()
  }
}

export const knowledgeBaseResolvers = {
  Query: {
    kbArticles,
    kbArticle,
    kbArticleBySlug,
    kbCategories,
  },
  Mutation: {
    createKBArticle,
    updateKBArticle,
    deleteKBArticle,
    rateKBArticle,
  },
}

logger.debug('[knowledgeBase] resolver module loaded')
