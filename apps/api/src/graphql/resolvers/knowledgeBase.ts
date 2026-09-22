import { GraphQLError } from 'graphql'
import { v4 as uuidv4 } from 'uuid'
import { getSession, toNumber } from '@opengraphity/neo4j'
import { workflowEngine } from '@opengraphity/workflow'
import type { GraphQLContext } from '../../context.js'
import { audit } from '../../lib/audit.js'
import { hasPermission } from '../../lib/permissions.js'
import { kbArticlePublishedCypher } from '../../lib/kbPublished.js'
import { logger } from '../../lib/logger.js'
import { enqueueEmbedding } from '../../jobs/embeddingWorker.js'
import { normalizeKbTags } from '../../services/embeddings.js'
import { assertDomainValue } from '../../lib/domainMatrix.js'
import { ValidationError } from '../../lib/errors.js'
import { loadVocabularyEntries } from '../../lib/vocabularyEntries.js'
import { languageFor } from '../../lib/tenantLanguage.js'
import { LINGUE, labelFor, type Lingua } from '../../lib/enumValueLabels.js'

interface KBArticle {
  id:                 string
  title:              string
  slug:               string
  body:               string
  category:           string
  tags:               string[]
  status:             string
  authorId:           string
  authorName:         string
  views:              number
  helpfulCount:       number
  notHelpfulCount:    number
  createdAt:          string
  updatedAt:          string
  publishedAt:        string | null
  workflowInstanceId: string | null
  currentStep:        string | null
  version:            number
  lastEditedByName:   string | null
}

interface KBCategory {
  name:  string
  label: string
  color: string | null
  count: number
}

interface KBArticleVersion {
  version:      number
  title:        string
  body:         string
  category:     string
  tags:         string[]
  editedById:   string | null
  editedByName: string | null
  editedAt:     string
}

export function mapArticle(r: { get: (k: string) => unknown }): KBArticle {
  return {
    id:                 r.get('id')                 as string,
    title:              r.get('title')              as string,
    slug:               r.get('slug')               as string,
    body:               r.get('body')               as string,
    category:           r.get('category')           as string,
    tags:               normalizeKbTags(r.get('tags')),
    status:             r.get('status')             as string,
    authorId:           r.get('authorId')           as string,
    authorName:         r.get('authorName')         as string,
    views:              toNumber(r.get('views')),
    helpfulCount:       toNumber(r.get('helpfulCount')),
    notHelpfulCount:    toNumber(r.get('notHelpfulCount')),
    createdAt:          r.get('createdAt')          as string,
    updatedAt:          r.get('updatedAt')          as string,
    publishedAt:        r.get('publishedAt')        as string | null,
    workflowInstanceId: (r.get('workflowInstanceId') ?? null) as string | null,
    currentStep:        (r.get('currentStep')        ?? null) as string | null,
    version:            toNumber(r.get('version')) || 1,
    lastEditedByName:   (r.get('lastEditedByName')   ?? null) as string | null,
  }
}

// Base RETURN — used in queries that already do the OPTIONAL MATCH for WorkflowInstance
const ARTICLE_RETURN = `
  RETURN a.id               AS id,
         a.title             AS title,
         a.slug              AS slug,
         a.body              AS body,
         a.category          AS category,
         a.tags              AS tags,
         a.status            AS status,
         a.author_id         AS authorId,
         // Il nome della persona, non l'e-mail salvata alla scrittura (giro del 14 set 2026, #44).
         coalesce(COLLECT { MATCH (au:User {id: a.author_id, tenant_id: a.tenant_id}) RETURN au.name }[0], a.author_name) AS authorName,
         a.views             AS views,
         a.helpful_count     AS helpfulCount,
         a.not_helpful_count AS notHelpfulCount,
         a.created_at        AS createdAt,
         a.updated_at        AS updatedAt,
         a.published_at      AS publishedAt,
         wi.id               AS workflowInstanceId,
         wi.current_step     AS currentStep,
         coalesce(a.version, 1)   AS version,
         coalesce(COLLECT { MATCH (ed:User {id: a.last_edited_by, tenant_id: a.tenant_id}) RETURN ed.name }[0], a.last_edited_by_name) AS lastEditedByName
`

// Full RETURN including the OPTIONAL MATCH for WorkflowInstance
export const ARTICLE_RETURN_WITH_WI = `
  OPTIONAL MATCH (a)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
  ${ARTICLE_RETURN}
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

/**
 * Bozze, articoli in revisione e archiviati sono di chi lavora la KB (`kb.read`).
 * Prima `kbArticles`, `kbArticle` e `kbArticleBySlug` erano aperti a `portal.read`
 * senza guardare lo stato: un utente del portale leggeva una bozza passando
 * `status: "draft"` o lo slug (revisione totale · H-1, riprodotto su c-test).
 */
function canReadDrafts(ctx: GraphQLContext): boolean {
  return hasPermission(ctx, 'kb.read')
}

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
  // Chi non lavora la KB (il portale) vede solo il pubblicato, qualunque filtro chieda (revisione totale · H-1).
  if (!canReadDrafts(ctx)) conditions.push(kbArticlePublishedCypher('a'))

  if (args.status)   { conditions.push('a.status = $status');       params['status']   = args.status }
  if (args.category) { conditions.push('a.category = $category');   params['category'] = args.category }
  if (args.search)   { conditions.push('(toLower(a.title) CONTAINS toLower($search) OR toLower(a.body) CONTAINS toLower($search))'); params['search'] = args.search }

  const where = conditions.join(' AND ')

  const session = getSession(undefined, 'READ')
  try {
    const dataRes = await session.executeRead((tx) => tx.run(`
      // tenant-ok(where-scopato): il WHERE interpolato parte da a.tenant_id = $tenantId (conditions, riga 128)
      MATCH (a:KBArticle)
      WHERE ${where}
      ${ARTICLE_RETURN_WITH_WI}
      ORDER BY a.updated_at DESC
      SKIP toInteger($skip) LIMIT toInteger($limit)
    `, params))

    const countRes = await session.executeRead((tx) => tx.run(`
      // tenant-ok(where-scopato): stesso $where della query di pagina, tenant per primo (conditions, riga 128)
      MATCH (a:KBArticle)
      WHERE ${where}
      RETURN count(a) AS total
    `, params))

    const total = toNumber(countRes.records[0]?.get('total'))
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
      ${canReadDrafts(ctx) ? '' : `WHERE ${kbArticlePublishedCypher('a')}`}
      SET a.views = coalesce(a.views, 0) + 1
      WITH a
      ${ARTICLE_RETURN_WITH_WI}
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
      ${canReadDrafts(ctx) ? '' : `WHERE ${kbArticlePublishedCypher('a')}`}
      SET a.views = coalesce(a.views, 0) + 1
      WITH a
      ${ARTICLE_RETURN_WITH_WI}
    `, { slug: args.slug, tenantId: ctx.tenantId }))

    if (!res.records.length) {
      throw new GraphQLError('Article not found', { extensions: { code: 'NOT_FOUND' } })
    }
    return mapArticle(res.records[0])
  } finally {
    await session.close()
  }
}

/**
 * Le categorie della Knowledge Base: il vocabolario `kb_category` del cliente,
 * nell'ordine dei suoi valori, con l'etichetta nella lingua chiesta, il colore
 * del Dizionario e quanti articoli pubblicati ha ciascuna (anche zero).
 * Revisione del 14 set 2026 · F5: prima erano le sole categorie già usate.
 */
export async function kbCategories(
  _: unknown,
  args: { language?: string | null },
  ctx: GraphQLContext,
): Promise<KBCategory[]> {
  const [vocabulary, fallback] = await Promise.all([
    loadVocabularyEntries(ctx.tenantId, 'kb_category'),
    languageFor(ctx.tenantId),
  ])
  const language: Lingua = (LINGUE as readonly string[]).includes(args.language ?? '') ? args.language as Lingua : fallback
  const session = getSession(undefined, 'READ')
  try {
    const res = await session.executeRead((tx) => tx.run(`
      MATCH (a:KBArticle {tenant_id: $tenantId})-[:HAS_WORKFLOW]->(:WorkflowInstance)-[:CURRENT_STEP]->(s:WorkflowStep)
      WHERE s.category = 'published'
      RETURN a.category AS name, count(a) AS count
    `, { tenantId: ctx.tenantId }))
    const counts = new Map(res.records.map((r) => [r.get('name') as string, toNumber(r.get('count'))]))
    return vocabulary.values.map((name) => ({
      name,
      label: labelFor(name, vocabulary.labels, language, fallback),
      color: vocabulary.colors[name] ?? null,
      count: counts.get(name) ?? 0,
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
  // F5: la categoria è un valore del vocabolario `kb_category` del cliente.
  await assertDomainValue(ctx.tenantId, 'kb_category', args.category)
  if (args.body.length > 50_000) {
    throw new GraphQLError('Article body exceeds 50000 characters', { extensions: { code: 'BAD_REQUEST' } })
  }

  const id     = uuidv4()
  const now    = new Date().toISOString()
  // Publishing goes through approval — new articles always start at the
  // workflow's initial step. Explicit published status is rejected here.
  const { getInitialStepName } = await import('../../lib/workflowHelpers.js')
  const initialStep = await (async () => {
    const s = getSession(undefined, 'READ')
    try { return await getInitialStepName(s, ctx.tenantId, 'kb_article') }
    finally { await s.close() }
  })()
  const status = initialStep
  const slug   = generateSlug(args.title) + '-' + id.slice(0, 8)

  // Article node AND its workflow instance are created in the SAME transaction:
  // an article without workflow is invisible to kbCategories and can never be
  // published (C-12), so a createInstance failure must roll the article back.
  const createSession = getSession(undefined, 'WRITE')
  let created: KBArticle
  try {
    const { record, workflowInstanceId } = await createSession.executeWrite(async (tx) => {
      const res = await tx.run(`
      CREATE (a:KBArticle {
        id:                $id,
        tenant_id:         $tenantId,
        title:             $title,
        slug:              $slug,
        body:              $body,
        category:          $category,
        tags:              $tags,
        status:            $status,
        author_id:         $authorId,
        author_name:       $authorName,
        views:             0,
        helpful_count:     0,
        not_helpful_count: 0,
        version:           1,
        last_edited_by:      $authorId,
        last_edited_by_name: $authorName,
        last_edited_at:      $now,
        created_at:        $now,
        updated_at:        $now,
        published_at:      $publishedAt
      })
      RETURN a.id               AS id,
             a.title             AS title,
             a.slug              AS slug,
             a.body              AS body,
             a.category          AS category,
             a.tags              AS tags,
             a.status            AS status,
             a.author_id         AS authorId,
             coalesce(COLLECT { MATCH (au:User {id: a.author_id, tenant_id: a.tenant_id}) RETURN au.name }[0], a.author_name) AS authorName,
             a.views             AS views,
             a.helpful_count     AS helpfulCount,
             a.not_helpful_count AS notHelpfulCount,
             a.created_at        AS createdAt,
             a.updated_at        AS updatedAt,
             a.published_at      AS publishedAt,
             null                AS workflowInstanceId,
             null                AS currentStep,
             a.version           AS version,
             coalesce(COLLECT { MATCH (ed:User {id: a.last_edited_by, tenant_id: a.tenant_id}) RETURN ed.name }[0], a.last_edited_by_name) AS lastEditedByName
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
      publishedAt: null,
    })
      if (!res.records.length) throw new Error(`KBArticle ${id} was not created`)
      // Joins this transaction: a failure here throws and rolls the CREATE back.
      const wi = await workflowEngine.createInstance(tx, ctx.tenantId, id, 'kb_article')
      return { record: res.records[0]!, workflowInstanceId: wi.id }
    })

    created = mapArticle(record)
    created.workflowInstanceId = workflowInstanceId
    created.currentStep        = initialStep
    void audit(ctx, 'kb_article.created', 'KBArticle', id)
  } finally {
    await createSession.close()
  }

  enqueueEmbedding({ entityType: 'kb_article', entityId: id, tenantId: ctx.tenantId }).catch((err: unknown) => {
    logger.error({ err }, '[embeddings] KB enqueue failed — similarity will lag until backfill')
  })

  return created
}

/**
 * LA MODIFICA CONCORRENTE SI DICE, NON SI SUBISCE (22 set 2026).
 *
 * L'articolo PORTA una `version` e una storia di versioni immutabili, ma
 * questa mutation non guardava nessuna delle due: due redattori sulla stessa
 * pagina, e il secondo salvataggio sovrascriveva il primo senza che nessuno
 * lo sapesse. Il testo non andava perduto — resta nella storia — ma spariva
 * da quello che i lettori vedono, e chi l'aveva scritto lo scopriva per caso.
 *
 * Il prodotto questo problema lo risolve già in tre posti — la policy degli
 * eventi, le mappe dei servizi, le definizioni di workflow — tutti con lo
 * stesso gesto: il client manda la versione che ha LETTO, e se non è più
 * quella attuale il salvataggio è rifiutato. Qui mancava, ed era l'unica
 * entità con una `version` a non averlo.
 *
 * `expectedVersion` resta OPZIONALE, come negli altri tre: un client che non
 * la manda si comporta come prima. Chi la manda è protetto.
 */
export async function updateKBArticle(
  _: unknown,
  args: { id: string; title?: string; body?: string; category?: string; tags?: string[]; expectedVersion?: number | null },
  ctx: GraphQLContext,
): Promise<KBArticle> {
  if (args.category !== undefined) await assertDomainValue(ctx.tenantId, 'kb_category', args.category)
  if (args.body && args.body.length > 50_000) {
    throw new GraphQLError('Article body exceeds 50000 characters', { extensions: { code: 'BAD_REQUEST' } })
  }

  const session = getSession(undefined, 'WRITE')
  try {
    const loadRes = await session.executeRead((tx) => tx.run(`
      MATCH (a:KBArticle {id: $id, tenant_id: $tenantId})
      RETURN a.id AS id, coalesce(a.version, 1) AS version, a.last_edited_at AS lastEditedAt,
             coalesce(a.last_edited_by_name, a.author_name) AS lastEditedBy
    `, { id: args.id, tenantId: ctx.tenantId }))

    if (!loadRes.records.length) {
      throw new GraphQLError('Article not found', { extensions: { code: 'NOT_FOUND' } })
    }

    /*
     * Il confronto si fa PRIMA di scrivere, e la lettura e la scrittura non
     * sono nella stessa transazione: fra le due resta una finestra piccola in
     * cui un terzo salvataggio può infilarsi. È lo stesso compromesso degli
     * altri tre punti del prodotto, e la differenza che conta è fra «non se ne
     * accorge nessuno» e «quasi sempre se ne accorge».
     */
    if (args.expectedVersion != null) {
      const attuale = toNumber(loadRes.records[0]!.get('version'))
      if (attuale !== args.expectedVersion) {
        /*
         * Nomi in inglese DENTRO il messaggio, e non per distrazione: il
         * guardiano della lingua legge il testo degli errori, e in un
         * template literal ci finiscono dentro anche i nomi interpolati. Un
         * `${quando}` in mezzo a una frase la fa sembrare — giustamente —
         * italiano rivolto a una persona.
         */
        const at = loadRes.records[0]!.get('lastEditedAt') as string | null
        const by = loadRes.records[0]!.get('lastEditedBy') as string | null
        const current = attuale
        throw new ValidationError(
          `KBArticle ${args.id} was modified by someone else (expected version ${args.expectedVersion}, current is ${current}${by ? `, by ${by}` : ''}${at ? ` at ${at}` : ''}): reload it and apply your changes again`,
          { key: 'errors.kb.concurrentEdit', params: { version: String(current), by: by ?? '', at: at ?? '' } },
        )
      }
    }

    const now     = new Date().toISOString()
    const setters: string[] = []
    const params: Record<string, unknown> = { id: args.id, tenantId: ctx.tenantId, now, editorId: ctx.userId, editorName: ctx.userEmail }

    if (args.title)    { setters.push('a.title = $title');       params['title']    = args.title }
    if (args.body)     { setters.push('a.body = $body');         params['body']     = args.body }
    if (args.category) { setters.push('a.category = $category'); params['category'] = args.category }
    if (args.tags)     { setters.push('a.tags = $tags');         params['tags']     = JSON.stringify(args.tags) }

    // No content field provided → nothing to version. Return the article as-is
    // rather than minting an empty version and bumping the counter.
    if (setters.length === 0) {
      const res = await session.executeRead((tx) => tx.run(`
        MATCH (a:KBArticle {id: $id, tenant_id: $tenantId})
        ${ARTICLE_RETURN_WITH_WI}
      `, { id: args.id, tenantId: ctx.tenantId }))
      return mapArticle(res.records[0])
    }

    // Snapshot the CURRENT content as an immutable version node BEFORE
    // overwriting, then bump the article's version counter and record the
    // editor. History holds versions 1..N-1; the live article is version N.
    const res = await session.executeWrite((tx) => tx.run(`
      MATCH (a:KBArticle {id: $id, tenant_id: $tenantId})
      CREATE (v:KBArticleVersion {
        id:             randomUUID(),
        tenant_id:      $tenantId,
        article_id:     $id,
        version:        coalesce(a.version, 1),
        title:          a.title,
        body:           a.body,
        category:       a.category,
        tags:           a.tags,
        edited_by:      a.last_edited_by,
        edited_by_name: coalesce(a.last_edited_by_name, a.author_name),
        edited_at:      coalesce(a.last_edited_at, a.updated_at, a.created_at)
      })
      CREATE (a)-[:HAS_VERSION]->(v)
      SET ${setters.join(', ')},
          a.version           = coalesce(a.version, 1) + 1,
          a.last_edited_by    = $editorId,
          a.last_edited_by_name = $editorName,
          a.last_edited_at    = $now,
          a.updated_at        = $now
      WITH a
      ${ARTICLE_RETURN_WITH_WI}
    `, params))

    const updated = mapArticle(res.records[0])
    void audit(ctx, 'kb_article.updated', 'KBArticle', args.id)
  enqueueEmbedding({ entityType: 'kb_article', entityId: args.id, tenantId: ctx.tenantId }).catch((err: unknown) => {
    logger.error({ err }, '[embeddings] KB enqueue failed — similarity will lag until backfill')
  })
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

    /**
     * Via anche ciò che vive SOLO per questo articolo (revisione totale ·
     * B-21): prima era un `DETACH DELETE a` e basta, e restavano nel grafo
     * l'istanza di workflow con la sua storia, le versioni, i commenti e —
     * peggio — le richieste di approvazione pendenti, che continuavano a
     * comparire in «Le mie approvazioni» e si potevano approvare, per un
     * articolo che non esiste più.
     */
    await session.executeWrite((tx) => tx.run(`
      MATCH (a:KBArticle {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (a)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      OPTIONAL MATCH (wi)-[:STEP_HISTORY]->(e:WorkflowStepExecution)
      OPTIONAL MATCH (a)-[:HAS_VERSION]->(v:KBArticleVersion)
      OPTIONAL MATCH (a)-[:HAS_COMMENT]->(c:Comment)
      WITH a, collect(DISTINCT wi) AS wis, collect(DISTINCT e) AS execs,
           collect(DISTINCT v) AS versions, collect(DISTINCT c) AS comments
      // Legati per proprietà, non per relazione: l'approvazione della pubblicazione.
      CALL {
        WITH a
        MATCH (r:ApprovalRequest {tenant_id: a.tenant_id, entity_type: 'kb_article', entity_id: a.id})
        RETURN collect(r) AS approvals
      }
      FOREACH (x IN execs     | DETACH DELETE x)
      FOREACH (x IN wis       | DETACH DELETE x)
      FOREACH (x IN versions  | DETACH DELETE x)
      FOREACH (x IN comments  | DETACH DELETE x)
      FOREACH (x IN approvals | DETACH DELETE x)
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
      WITH a
      ${ARTICLE_RETURN_WITH_WI}
    `, { id: args.id, tenantId: ctx.tenantId }))

    if (!res.records.length) {
      throw new GraphQLError('Article not found', { extensions: { code: 'NOT_FOUND' } })
    }
    return mapArticle(res.records[0])
  } finally {
    await session.close()
  }
}

export async function kbArticleVersions(
  _: unknown,
  args: { articleId: string },
  ctx: GraphQLContext,
): Promise<KBArticleVersion[]> {
  const session = getSession(undefined, 'READ')
  try {
    const res = await session.executeRead((tx) => tx.run(`
      MATCH (a:KBArticle {id: $articleId, tenant_id: $tenantId})-[:HAS_VERSION]->(v:KBArticleVersion)
      RETURN v.version        AS version,
             v.title          AS title,
             v.body           AS body,
             v.category       AS category,
             v.tags           AS tags,
             v.edited_by      AS editedById,
             coalesce(COLLECT { MATCH (ed:User {id: v.edited_by, tenant_id: v.tenant_id}) RETURN ed.name }[0], v.edited_by_name) AS editedByName,
             v.edited_at      AS editedAt
      ORDER BY v.version DESC
    `, { articleId: args.articleId, tenantId: ctx.tenantId }))
    return res.records.map((r) => ({
      version:      toNumber(r.get('version')),
      title:        r.get('title')    as string,
      body:         r.get('body')     as string,
      category:     r.get('category') as string,
      tags:         normalizeKbTags(r.get('tags')),
      editedById:   (r.get('editedById')   ?? null) as string | null,
      editedByName: (r.get('editedByName') ?? null) as string | null,
      editedAt:     r.get('editedAt') as string,
    }))
  } finally {
    await session.close()
  }
}

export async function restoreKBArticleVersion(
  _: unknown,
  args: { articleId: string; version: number },
  ctx: GraphQLContext,
): Promise<KBArticle> {
  const session = getSession(undefined, 'WRITE')
  try {
    // Load the target snapshot's content, then route it through updateKBArticle
    // so the CURRENT content is itself snapshotted and the version counter bumps.
    const snapRes = await session.executeRead((tx) => tx.run(`
      MATCH (a:KBArticle {id: $articleId, tenant_id: $tenantId})-[:HAS_VERSION]->(v:KBArticleVersion {version: $version})
      RETURN v.title AS title, v.body AS body, v.category AS category, v.tags AS tags
    `, { articleId: args.articleId, tenantId: ctx.tenantId, version: args.version }))

    if (!snapRes.records.length) {
      throw new GraphQLError(`Version ${args.version} not found for article`, { extensions: { code: 'NOT_FOUND' } })
    }
    const snap = snapRes.records[0]
    const tags = normalizeKbTags(snap.get('tags'))

    const restored = await updateKBArticle(_, {
      id:       args.articleId,
      title:    snap.get('title')    as string,
      body:     snap.get('body')     as string,
      category: snap.get('category') as string,
      tags,
    }, ctx)
    void audit(ctx, 'kb_article.version_restored', 'KBArticle', args.articleId)
    return restored
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
    kbArticleVersions,
  },
  Mutation: {
    createKBArticle,
    updateKBArticle,
    restoreKBArticleVersion,
    deleteKBArticle,
    rateKBArticle,
  },
}

logger.debug('[knowledgeBase] resolver module loaded')
