/**
 * Post-incident intelligence (AI step 4):
 *  - draftResolutionNotes: bozza di note di risoluzione dal timeline reale
 *  - problemCandidates: cluster di incident ricorrenti → candidati Problem
 *  - draftKbFromIncident: bozza articolo KB (status draft) da un incident risolto
 *
 * Ogni funzione è invocata da un'azione ESPLICITA dell'utente e produce
 * suggerimenti/bozze da rivedere — mai auto-azioni. No-fallback: chiave
 * mancante, errori provider e violazioni di schema propagano.
 */
import { config } from '../lib/config.js'
import { GraphQLError } from 'graphql'
import { NotFoundError, ValidationError } from '../lib/errors.js'
import { getSession, runQuery } from '@opengraphity/neo4j'
import { vectorIndexName } from './embeddings.js'
import { requestEmbedding, type EmbeddingRequest } from '../jobs/embeddingWorker.js'
import { vectorSearchForTenant } from '../lib/vectorSearch.js'
import { logger } from '../lib/logger.js'
// I passi conclusivi (risolti/terminali) vengono dal workflow di QUESTO cliente
// e non da `['closed']`/`['resolved','closed']` (ondata 8 · B-22).
import { statusNamesForClasses, concludedStatusNames } from '../lib/statusStepNames.js'
import { modelLanguageFor } from '../lib/systemText.js'
import { localDateTimeIn, tenantTimezone } from '../lib/tenantTimezone.js'
import { domainVocabulary } from '../lib/domainMatrix.js'
import { aiSettings, assertAIFeature } from '../lib/aiSettings.js'
import { getAnthropic, leggiJSONDalModello, leggiTestoDalModello, registraDurata } from '../lib/aiClient.js'

/** Le stesse due chiavi per tutte e tre le chiamate di questo servizio. */
const CHIAVI_AI = { troncata: 'errors.ai.truncated', illeggibile: 'errors.ai.badAnswer' } as const

const log = logger.child({ module: 'post-incident' })

async function readQuery<T>(cypher: string, params: Record<string, unknown>): Promise<T[]> {
  const session = getSession(undefined, 'READ')
  try {
    return await runQuery<T>(session, cypher, params)
  } finally {
    await session.close()
  }
}

interface IncidentContext {
  props: Record<string, unknown>
  comments: Array<{ text: string; created_at: string | null }>
  steps: Array<{ step: string; at: string | null; trigger: string | null }>
  cis: string[]
}

async function loadIncidentContext(tenantId: string, incidentId: string): Promise<IncidentContext> {
  /*
   * The workflow history is reached from the incident (tour of 23 Sep 2026):
   * `WorkflowInstance {entity_id}` and `WorkflowStepExecution {instance_id}`
   * have no index, and on a tenant with a million step executions each draft
   * read all of them.
   */
  const rows = await readQuery<{
    props: Record<string, unknown>
    comments: Array<{ text: string | null; created_at: string | null }>
    steps: Array<{ step: string | null; at: string | null; trigger: string | null }>
    cis: string[]
  }>(`
    MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
    OPTIONAL MATCH (i)-[:HAS_COMMENT]->(c:Comment)
    WITH i, c ORDER BY c.created_at
    WITH i, collect(DISTINCT {text: c.text, created_at: c.created_at}) AS comments
    OPTIONAL MATCH (i)-[:HAS_WORKFLOW]->(:WorkflowInstance)-[:STEP_HISTORY]->(se:WorkflowStepExecution)
    WITH i, comments, se ORDER BY se.entered_at
    WITH i, comments, collect({step: se.step_name, at: se.entered_at, trigger: se.trigger_type}) AS steps
    OPTIONAL MATCH (i)-[:AFFECTED_BY]->(ci)
    RETURN properties(i) AS props, comments, steps, collect(DISTINCT ci.name) AS cis
  `, { tenantId, incidentId })
  if (!rows.length) throw new NotFoundError('Incident')
  const r = rows[0]
  return {
    props: r.props,
    comments: r.comments.filter((c): c is { text: string; created_at: string | null } => Boolean(c.text)),
    steps: r.steps.filter((s): s is { step: string; at: string | null; trigger: string | null } => Boolean(s.step)),
    cis: r.cis,
  }
}

/**
 * The organization's time zone, which the drafts need: without it the times
 * could only be raw UTC, and the model mixes them with the local times the
 * description and the comments are written in (D14).
 */
async function draftTimeZone(tenantId: string): Promise<string> {
  const timeZone = await tenantTimezone(tenantId)
  if (!timeZone) {
    throw new ValidationError(
      'The organization has no time zone, so the times in the draft cannot be written in local time: choose it in Settings → Organization.',
      { key: 'errors.ai.needsTimezone' },
    )
  }
  return timeZone
}

/** What the model reads about an incident: real evidence only, every instant as local time. */
function incidentEvidence(ctx: IncidentContext, timeZone: string): Record<string, unknown> {
  const at = (v: unknown) => localDateTimeIn(typeof v === 'string' ? v : null, timeZone)
  return {
    title: ctx.props['title'], description: ctx.props['description'],
    severity: ctx.props['severity'], category: ctx.props['category'],
    opened_at: at(ctx.props['created_at']), resolved_at: at(ctx.props['resolved_at']),
    affected_cis: ctx.cis,
    comments: ctx.comments.map((c) => ({ at: at(c.created_at), text: c.text })),
    workflow_steps: ctx.steps.map((s) => ({ step: s.step, at: at(s.at), trigger: s.trigger })),
  }
}

/** The sentence that tells the model how to read the times (D14). */
function timesSentence(timeZone: string): string {
  return `Every time in the data (opened_at, resolved_at, comments, workflow steps) is local time in the organization's time zone, ${timeZone}, and so are the times people and the system wrote inside the description and the comments: use them as they are and never convert them.`
}

// ── 1. Bozza resolution notes ────────────────────────────────────────────────

export async function draftResolutionNotes(tenantId: string, incidentId: string): Promise<string> {
  await assertAIFeature(tenantId, 'postIncident')
  const ctx = await loadIncidentContext(tenantId, incidentId)
  const timeZone = await draftTimeZone(tenantId)
  const client = getAnthropic()
  const language = await modelLanguageFor(tenantId)
  const t0 = Date.now()

  const response = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: 1500,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: [{
      type: 'text',
      text: `You write the resolution notes of an ITSM incident. Write the text in ${language}. You receive the real data of the incident: title, description, the operators' comments, the workflow steps and the CIs involved. ${timesSentence(timeZone)} Produce ONLY the text of the notes: 3-6 concrete sentences describing the cause, the intervention carried out and the verification, based exclusively on the evidence provided. If the evidence does not make the cause or the intervention clear, say so explicitly (for example "cause not documented in the comments", in ${language}) instead of inventing it. No preamble, no markdown.`,
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{ role: 'user', content: JSON.stringify(incidentEvidence(ctx, timeZone), null, 1) }],
  })

  registraDurata('postIncident', Date.now() - t0)
  const text = leggiTestoDalModello(response, 'postIncident', CHIAVI_AI)
  log.info({ incidentId, ms: Date.now() - t0 }, '[post-incident] resolution draft generated')
  return text
}

// ── 2. Candidati Problem ─────────────────────────────────────────────────────

export interface ProblemCandidate {
  title: string
  motivation: string
  incidents: Array<{ id: string; number: string | null; title: string; status: string; severity: string }>
}

/**
 * What the clustering looked at, next to what it found (tour of 23 Sep 2026,
 * D15). With no incident analysed the page said «No cluster of recurring
 * similar incidents found»: true of zero incidents, false of the tenant. The
 * answer now says how many open incidents were examined, how many were left
 * out because their embedding is not computed yet (it is queued now) or its
 * computation failed, and whether the cap cut the older ones off.
 */
export interface ProblemCandidatesResult {
  candidates: ProblemCandidate[]
  examined: number
  notAnalysed: number
  analysisFailures: number
  capped: boolean
}

/**
 * Quanti incident aperti entrano nella ricerca dei cluster (D-22): oltre
 * questo numero la ricerca costerebbe più di quanto vale, perché è una query
 * vettoriale per incident dentro una richiesta dell'interfaccia.
 */
const CLUSTER_MAX_INCIDENTS = 300

/** How many neighbours of each incident the clustering looks at. */
const CLUSTER_PEERS_LIMIT = 15

interface OpenIncident {
  id: string; number: string | null; title: string; status: string; severity: string
  embedding: number[] | null; version: string | null
}
type AnalysedIncident = OpenIncident & { embedding: number[] }

/**
 * Un TETTO agli incident esaminati (revisione totale · D-22): la ricerca dei
 * cluster fa una query vettoriale PER incident, dentro una richiesta
 * GraphQL. Su un cliente con migliaia di incident aperti erano migliaia di
 * query e la pagina andava in timeout. Si guardano i più RECENTI, che sono
 * quelli su cui un problem ha senso, e quando il tetto è pieno lo si dice —
 * l'analisi non finge di aver guardato tutto. One row more than the cap tells
 * whether it cut; incidents without an embedding are read too, to be counted.
 */
async function openIncidentsForClusters(tenantId: string, closedSteps: string[]): Promise<{ incidents: OpenIncident[]; capped: boolean }> {
  const rows = await readQuery<OpenIncident>(`
    MATCH (i:Incident {tenant_id: $tenantId})
    WHERE NOT i.status IN $closedSteps
    WITH i ORDER BY i.created_at DESC
    LIMIT toInteger($limit)
    RETURN i.id AS id, i.number AS number, i.title AS title,
           i.status AS status, i.severity AS severity, i.embedding AS embedding,
           coalesce(i.updated_at, i.created_at) AS version
  `, { tenantId, closedSteps, limit: CLUSTER_MAX_INCIDENTS + 1 })
  const capped = rows.length > CLUSTER_MAX_INCIDENTS
  if (capped) {
    log.warn({ tenantId, maxIncidents: CLUSTER_MAX_INCIDENTS },
      'Problem candidates: the cap on examined incidents was reached, the analysis looks at the most recent ones')
  }
  return { incidents: rows.slice(0, CLUSTER_MAX_INCIDENTS), capped }
}

/** Queues the embedding of the open incidents that have none (D15), and says which ones had failed. */
async function requestMissingEmbeddings(tenantId: string, missing: OpenIncident[]): Promise<EmbeddingRequest[]> {
  return Promise.all(missing.map((i) => {
    if (!i.version) throw new Error(`Incident ${i.id} has neither updated_at nor created_at: its embedding cannot be versioned`)
    return requestEmbedding({ entityType: 'incident', entityId: i.id, tenantId, updatedAt: i.version })
  }))
}

/** Union-find over the vector neighbours of every analysed incident, above the organization's similarity. */
async function clusterIncidents(
  tenantId: string, incidents: AnalysedIncident[], closedSteps: string[], minSimilarity: number,
): Promise<AnalysedIncident[][]> {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    return r
  }
  const union = (a: string, b: string) => { parent.set(find(a), find(b)) }
  for (const i of incidents) parent.set(i.id, i.id)

  const index = vectorIndexName('Incident')
  for (const i of incidents) {
    // K cresce finché i vicini DEL TENANT bastano: l'indice è cross-tenant e
    // i 15 globali di un'installazione con clienti grandi non contengono
    // nessun incident di questo cliente (revisione totale · B-12).
    const session = getSession(undefined, 'READ')
    let peers: { id: string; score: number }[]
    try {
      peers = await vectorSearchForTenant<{ id: string; score: number }>(session, {
        index,
        embedding: i.embedding,
        tenantId,
        limit: CLUSTER_PEERS_LIMIT,
        where: 'node.id <> $selfId AND NOT node.status IN $closedSteps AND score >= $minSimilarity',
        returns: 'node.id AS id, score',
        params: { selfId: i.id, closedSteps, minSimilarity },
        what: 'postIncident.problemCandidates',
      })
    } finally { await session.close() }
    for (const p of peers) if (parent.has(p.id)) union(i.id, p.id)
  }

  const groups = new Map<string, AnalysedIncident[]>()
  for (const i of incidents) {
    const root = find(i.id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root)!.push(i)
  }
  return [...groups.values()]
}

/** Claude names each cluster and motivates the Problem candidate. */
async function nameClusters(tenantId: string, clusters: AnalysedIncident[][]): Promise<ProblemCandidate[]> {
  const client = getAnthropic()
  const language = await modelLanguageFor(tenantId)
  const schema = {
    type: 'object',
    properties: {
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            cluster_index: { type: 'integer' },
            title: { type: 'string' },
            motivation: { type: 'string' },
          },
          required: ['cluster_index', 'title', 'motivation'],
          additionalProperties: false,
        },
      },
    },
    required: ['candidates'],
    additionalProperties: false,
  }

  const response = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: 2000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system: [{
      type: 'text',
      text: `You are an ITSM analyst. You receive clusters of semantically similar incidents that are not closed. For each cluster propose a Problem candidate: a short title naming the probable common root cause and a motivation of 2-3 sentences, both written in ${language} and based ONLY on the titles and data provided. If a cluster looks made of test tickets or shows no real pattern, say so openly in the motivation.`,
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{ role: 'user', content: JSON.stringify(
      clusters.map((g, idx) => ({ cluster_index: idx, incidents: g.map(i => ({ number: i.number, title: i.title, severity: i.severity, status: i.status })) })),
      null, 1,
    ) }],
  })

  const parsed = leggiJSONDalModello(response, 'postIncident', CHIAVI_AI) as { candidates: Array<{ cluster_index: number; title: string; motivation: string }> }

  return parsed.candidates
    .filter(c => clusters[c.cluster_index])
    .map(c => ({
      title: c.title,
      motivation: c.motivation,
      incidents: clusters[c.cluster_index].map(({ id, number, title, status, severity }) => ({ id, number, title, status, severity })),
    }))
}

export async function problemCandidates(tenantId: string): Promise<ProblemCandidatesResult> {
  // Il raggruppamento usa gli embedding e il modello: servono entrambe le funzioni.
  await assertAIFeature(tenantId, 'postIncident')
  await assertAIFeature(tenantId, 'embeddings')
  // Le soglie sono dell'organizzazione (ondata 6): prima 0,72 e 3 nel codice.
  const { clusterMinSimilarity, clusterMinSize } = await aiSettings(tenantId)
  // Incident non CHIUSI (un incident risolto ma non chiuso è ancora un
  // candidato: il cluster serve a capire se il problema si ripete). «Chiuso» è
  // la classe di stato del workflow del cliente, non il nome `closed`.
  const closedSteps = await statusNamesForClasses(tenantId, 'incident', ['closed'])
  const { incidents, capped } = await openIncidentsForClusters(tenantId, closedSteps)
  const analysed = incidents.filter((i): i is AnalysedIncident => i.embedding != null)
  const missing = incidents.filter((i) => i.embedding == null)
  const requests = await requestMissingEmbeddings(tenantId, missing)
  const summary = {
    examined: analysed.length,
    notAnalysed: missing.length,
    analysisFailures: requests.filter((r) => r.state === 'failed').length,
    capped,
  }

  const clusters = (await clusterIncidents(tenantId, analysed, closedSteps, clusterMinSimilarity))
    .filter(g => g.length >= clusterMinSize)
    .sort((a, b) => b.length - a.length)
    .slice(0, 3)
  if (clusters.length === 0) return { candidates: [], ...summary }
  return { candidates: await nameClusters(tenantId, clusters), ...summary }
}

// ── 3. Bozza articolo KB da incident risolto ────────────────────────────────

export interface KbDraftContent {
  title: string
  body: string
  category: string
  tags: string[]
}

export async function draftKbContent(tenantId: string, incidentId: string): Promise<KbDraftContent> {
  await assertAIFeature(tenantId, 'kbArticles')
  const ctx = await loadIncidentContext(tenantId, incidentId)
  const status = String(ctx.props['status'] ?? '')
  // Risolto o chiuso secondo i METADATA del passo di questo cliente: con un
  // passo di risoluzione rinominato la bozza KB era irraggiungibile (il web non
  // mostrava il bottone e il server l'avrebbe rifiutata comunque).
  const concluded = await concludedStatusNames(tenantId, 'incident')
  if (!concluded.includes(status)) {
    throw new GraphQLError(
      `The KB draft is generated only from resolved or closed incidents: this one is in step "${status}". `
      + `Concluding steps of the incident workflow: ${concluded.length > 0 ? concluded.join(', ') : '(none declared — mark a step as terminal, or of category "resolved", in the designer)'}.`,
      {
        extensions: {
          code: 'BAD_USER_INPUT',
          i18n: concluded.length > 0
            ? { key: 'errors.kb.onlyFromConcluded', params: { step: status, concluded: concluded.join(', ') } }
            : { key: 'errors.kb.onlyFromConcludedNone', params: { step: status } },
        },
      },
    )
  }

  const timeZone = await draftTimeZone(tenantId)
  const client = getAnthropic()
  const language = await modelLanguageFor(tenantId)
  // F5: il modello sceglie fra le categorie KB del cliente. Prima scriveva
  // «una parola», e l'articolo nasceva con una categoria che la pagina e il
  // portale non conoscevano.
  const kbCategories = [...await domainVocabulary(tenantId, 'kb_category')]
  const schema = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      body: { type: 'string' },
      category: { type: 'string', enum: kbCategories },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['title', 'body', 'category', 'tags'],
    additionalProperties: false,
  } as const

  const response = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: 3000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system: [{
      type: 'text',
      text: `You are a Knowledge Base editor for ITSM. From a resolved incident write a KB article entirely in ${language} (title, body and section headings), structured as Symptom, Cause, Solution, Verification, with the section headings in ${language}. Use ONLY the evidence provided (description, comments, workflow); where the evidence is missing write "to be completed" (in ${language}) instead of inventing. ${timesSentence(timeZone)} body: simple markdown. category: the most suitable KB category among those the schema allows. tags: 2-5 keywords.`,
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{ role: 'user', content: JSON.stringify(incidentEvidence(ctx, timeZone), null, 1) }],
  })

  return leggiJSONDalModello(response, 'kbArticles', CHIAVI_AI) as KbDraftContent
}
