import { withSession, ciTypeFromLabels, runQuery, mapCI } from './ci-utils.js'
import { mapIncident } from '../../lib/mappers.js'
import { mapChange } from './change/mappers.js'
import { mapProblem } from './problem.js'
import { mapArticle, ARTICLE_RETURN_WITH_WI } from './knowledgeBase.js'
import { mapRequest } from '../../services/requestService.js'
import type { GraphQLContext } from '../../context.js'
import type { Props } from './ci-utils.js'
import { ciLabelPredicateForTenant } from '../../lib/ciLabelsForTenant.js'
import type { Permission } from '@opengraphity/types'

/**
 * OGNI GRUPPO DELLA RICERCA VUOLE IL SUO PERMESSO DI LETTURA.
 *
 * Il difetto (revisione del 17 set 2026): `globalSearch` chiede
 * `workspace.use` — il permesso di «stare nell'area di lavoro» — e restituiva
 * TUTTI i gruppi. E i tipi restituiti sono quelli veri (`ServiceRequest`,
 * `Incident`…), i cui resolver di campo NON passano dalla policy: quindi un
 * ruolo con `workspace.use` e senza `request.read` poteva chiedere
 * `globalSearch{ serviceRequests{ formAnswers{ name displayValue } } }` e
 * leggere le risposte ai moduli di chiunque — costi, riferimenti, dati
 * anagrafici. È esattamente il caso per cui i ruoli personalizzati esistono.
 *
 * Il rimedio è qui e non nella tabella dei permessi: la ricerca DEVE restare
 * aperta a chi ha l'area di lavoro (è la barra in cima a ogni pagina), ma
 * consegna solo i gruppi che chi cerca può leggere. Il portale non passa da
 * qui: la sua ricerca è un'altra.
 */
const PERMESSO_DEL_GRUPPO: Readonly<Record<keyof GlobalSearchResults, Permission>> = {
  incidents:       'incident.read',
  problems:        'problem.read',
  changes:         'change.read',
  serviceRequests: 'request.read',
  kbArticles:      'kb.read',
  cis:             'cmdb.read',
  // Le attività di una change si leggono con la change: sono sue.
  tasks:           'change.read',
}

// ── result shape ──────────────────────────────────────────────────────────────

export interface SearchTaskResult {
  id:         string
  code:       string
  taskType:   string
  status:     string
  changeCode: string
  changeId:   string
  ciName:     string
}

export interface GlobalSearchResults {
  cis:        ReturnType<typeof mapCI>[]
  changes:    ReturnType<typeof mapChange>[]
  incidents:  ReturnType<typeof mapIncident>[]
  problems:   ReturnType<typeof mapProblem>[]
  serviceRequests: ReturnType<typeof mapRequest>[]
  tasks:      SearchTaskResult[]
  kbArticles: ReturnType<typeof mapArticle>[]
}

function emptyResults(): GlobalSearchResults {
  return { cis: [], changes: [], incidents: [], problems: [], serviceRequests: [], tasks: [], kbArticles: [] }
}

// ── constants ─────────────────────────────────────────────────────────────────

// Task label → frontend `kind` convention (see apps/web/src/pages/tasks/).
const TASK_KIND: Record<string, string> = {
  AssessmentTask: 'assessment',
  DeployPlanTask: 'deploy-plan',
  ValidationTest: 'validation',
  DeploymentTask: 'deployment',
  ReviewTask:     'review',
}

/**
 * Build a Lucene prefix query. The standard analyzer tokenizes indexed text
 * on non-alphanumeric boundaries ("E2E-smoke-123" → e2e, smoke, 123), so the
 * user's input must be tokenized the same way — escaping punctuation into a
 * single term would match nothing.
 */
function toLucene(raw: string): string {
  const terms = raw.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  if (!terms.length) return ''
  return terms.map((t) => `${t}*`).join(' AND ')
}

/**
 * Tenant-scoped grouped search across the main ITSM entities.
 *
 * - Textual entities (Incident/Change/Problem/KBArticle/CI names) go through
 *   the `global_search` fulltext index (see packages/neo4j/src/init.ts):
 *   indexed prefix search instead of unindexed CONTAINS scans. Dall'ondata 6
 *   l'indice copre i CI per `:ConfigurationItem` invece che per venti
 *   etichette fisse: gli indici fulltext non si estendono a runtime, quindi
 *   un tipo creato dal cliente non era cercabile (A6-2). Il filtro per tenant
 *   resta sui risultati (`node.tenant_id = $tenantId`).
 * - CIs additionally match on `id STARTS WITH $query` for direct UUID lookup
 *   (union with the fulltext hits, no duplicates).
 * - Change tasks (5 labels) match on `code` and are resolved back to their
 *   Change (HAS_ASSESSMENT/HAS_DEPLOY_PLAN/HAS_VALIDATION/HAS_DEPLOYMENT/
 *   HAS_REVIEW) and CI (`t.ci_id`).
 *
 * Each group returns the full entity mapped with the same mappers the list
 * queries use, so GraphQL field resolvers (assignee, slaStatus, …) keep working.
 */
async function globalSearch(
  _: unknown,
  args: { query: string; limit?: number },
  ctx: GraphQLContext,
): Promise<GlobalSearchResults> {
  const q = args.query.trim()
  if (q.length < 2) return emptyResults()
  const limit = Math.min(Math.max(args.limit ?? 5, 1), 20)
  const lucene = toLucene(q)
  if (!lucene) return emptyResults()

  /** Chi cerca può leggere questo gruppo? */
  const puo = (gruppo: keyof GlobalSearchResults): boolean => ctx.permissions.has(PERMESSO_DEL_GRUPPO[gruppo])

  return withSession(async (session) => {
    const res = emptyResults()

    // 1. Fulltext prefix search — over-fetch, then cap per group in JS: the
    //    index returns global relevance order, and one very common type must
    //    not crowd out the others.
    const rows = await runQuery<{ props: Props; labels: string[] }>(session, `
      CALL db.index.fulltext.queryNodes('global_search', $lucene) YIELD node, score
      WHERE node.tenant_id = $tenantId
      RETURN properties(node) AS props, labels(node) AS labels
      ORDER BY score DESC
      LIMIT toInteger($fetchLimit)
    `, { lucene, tenantId: ctx.tenantId, fetchLimit: limit * 12 })

    const kbIds: string[] = []
    const ciTextHits: GlobalSearchResults['cis'] = []
    for (const r of rows) {
      if (r.labels.includes('Incident')) {
        if (puo('incidents') && res.incidents.length < limit) res.incidents.push(mapIncident(r.props))
      } else if (r.labels.includes('Change')) {
        if (r.props['deleted'] === true) continue // eliminata logicamente
        if (puo('changes') && res.changes.length < limit) res.changes.push(mapChange(r.props))
      } else if (r.labels.includes('Problem')) {
        if (puo('problems') && res.problems.length < limit) res.problems.push(mapProblem(r.props))
      } else if (r.labels.includes('KBArticle')) {
        if (puo('kbArticles') && kbIds.length < limit) kbIds.push(r.props['id'] as string)
      } else if (r.labels.includes('ServiceRequest')) {
        // Giro del 14 set 2026 (#54): erano nell'indice e venivano scartate.
        if (puo('serviceRequests') && res.serviceRequests.length < limit) res.serviceRequests.push(mapRequest(r.props))
      } else if (puo('cis') && ciTextHits.length < limit) {
        r.props['type'] = ciTypeFromLabels(ctx.tenantId, r.labels)
        ciTextHits.push(mapCI(r.props))
      }
    }

    // 2. CI direct id lookup (ids are UUIDs — useful when pasting an id).
    //    Direct matches take priority; union with fulltext hits, no duplicates.
    //    Senza `cmdb.read` non si cerca affatto: non è solo un filtro sui
    //    risultati, è una query che non ha ragione di girare.
    const idRows = !puo('cis') ? [] : await runQuery<{ props: Props; labels: string[] }>(session, `
      MATCH (ci)
      WHERE ${await ciLabelPredicateForTenant('ci', ctx.tenantId)}
        AND ci.tenant_id = $tenantId
        AND ci.id STARTS WITH $q
      RETURN properties(ci) AS props, labels(ci) AS labels
      LIMIT toInteger($limit)
    `, { q, tenantId: ctx.tenantId, limit })
    const seen = new Set<string>()
    for (const r of idRows) {
      r.props['type'] = ciTypeFromLabels(ctx.tenantId, r.labels)
      const ci = mapCI(r.props)
      if (!seen.has(ci.id)) {
        seen.add(ci.id)
        res.cis.push(ci)
      }
    }
    for (const ci of ciTextHits) {
      if (res.cis.length >= limit) break
      if (!seen.has(ci.id)) {
        seen.add(ci.id)
        res.cis.push(ci)
      }
    }

    // 3. Change tasks by code, resolved back to their Change and CI.
    const taskRows = !puo('tasks') ? [] : await runQuery<{
      id: string; code: string; label: string; status: string
      changeCode: string; changeId: string; ciName: string
    }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})
            -[:HAS_ASSESSMENT|HAS_DEPLOY_PLAN|HAS_VALIDATION|HAS_DEPLOYMENT|HAS_REVIEW]->(t)
      WHERE coalesce(c.deleted, false) = false
        AND t.code IS NOT NULL AND toLower(t.code) CONTAINS toLower($q)
      OPTIONAL MATCH (ci {id: t.ci_id, tenant_id: $tenantId})
      RETURN t.id AS id, t.code AS code, head([l IN labels(t) WHERE l <> 'ConfigurationItem']) AS label,
             coalesce(t.status, '') AS status,
             c.code AS changeCode, c.id AS changeId,
             coalesce(ci.name, coalesce(t.ci_id, '')) AS ciName
      ORDER BY t.code
      LIMIT toInteger($limit)
    `, { q, tenantId: ctx.tenantId, limit })
    /**
     * I COMPITI GENERICI (20 set 2026), quelli che un passo di workflow crea
     * su un ticket qualunque. Condividono la numerazione `TASK…` con i
     * compiti di change — per chi lavora sono la stessa cosa — quindi un
     * codice ricevuto per telefono deve trovarli. Prima la ricerca guardava
     * solo le cinque relazioni delle change, e `TASK00000042` non dava
     * niente pur esistendo, scritto sul ticket e nell'audit.
     *
     * Il badge è il NUMERO DEL TICKET, che è quello che porta da qualche
     * parte: un compito generico non ha una pagina sua.
     */
    const compitiRows = !puo('tasks') ? [] : await runQuery<{
      id: string; code: string; state: string; titolo: string
      entityNumber: string; entityId: string
    }>(session, `
      MATCH (ticket)-[:HAS_TASK]->(k:Task {tenant_id: $tenantId})
      WHERE coalesce(ticket.deleted, false) = false
        AND k.code IS NOT NULL AND toLower(k.code) CONTAINS toLower($q)
      RETURN k.id AS id, k.code AS code, coalesce(k.state, '') AS state, k.title AS titolo,
             coalesce(ticket.number, ticket.code, '') AS entityNumber, ticket.id AS entityId
      ORDER BY k.code
      LIMIT toInteger($limit)
    `, { q, tenantId: ctx.tenantId, limit })

    res.tasks = [
      ...taskRows.map((r) => ({
        id:         r.id,
        code:       r.code,
        taskType:   TASK_KIND[r.label] ?? r.label.toLowerCase(),
        status:     r.status,
        changeCode: r.changeCode,
        changeId:   r.changeId,
        ciName:     r.ciName,
      })),
      ...compitiRows.map((r) => ({
        id:         r.id,
        code:       r.code,
        taskType:   'task',
        status:     r.state,
        changeCode: r.entityNumber,
        changeId:   r.entityId,
        ciName:     r.titolo,
      })),
    ]

    // 4. KB articles: re-fetch by id with the canonical RETURN so the shared
    //    mapArticle mapper (incl. workflow instance fields) can be reused.
    if (kbIds.length > 0) {
      const kbRows = await runQuery<Record<string, unknown>>(session, `
        MATCH (a:KBArticle {tenant_id: $tenantId})
        WHERE a.id IN $ids
        ${ARTICLE_RETURN_WITH_WI}
      `, { tenantId: ctx.tenantId, ids: kbIds })
      const byId = new Map(kbRows.map((row) => [row['id'] as string, row]))
      res.kbArticles = kbIds
        .map((id) => byId.get(id))
        .filter((row): row is Record<string, unknown> => row != null)
        .map((row) => mapArticle({ get: (k) => row[k] }))
    }

    return res
  })
}

export const globalSearchResolvers = {
  Query: { globalSearch },
}
