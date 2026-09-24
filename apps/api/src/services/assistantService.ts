/**
 * Conversational assistant grounded in the tenant's graph — Claude tool use
 * over READ-ONLY typed tools (incidents, CIs, impact, changes, KB).
 *
 * Security by design: every tool is tenant-scoped and read-only, and the
 * model gets ONLY the tools the caller's role may read (wave 7: incidents need
 * `incident.read`, CIs `cmdb.read`, changes `change.read`, articles `kb.read`).
 * No mutations.
 * No-fallback: missing API key, tool failures and provider errors surface
 * as explicit SSE error events.
 */
import { kbArticlePublishedCypher } from '../lib/kbPublished.js'
import { vectorSearchForTenant } from '../lib/vectorSearch.js'
import type { Permission } from '@opengraphity/types'

/** Limite chiesto dal modello: intero in [1, max]; assente/NaN/negativo → default (mai LIMIT NaN o negativo in Cypher). */
function clampLimit(limit: unknown, def: number, max: number): number {
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.trunc(limit) : def
  return Math.min(Math.max(1, n), max)
}
import { config } from '../lib/config.js'
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { getSession, runQuery, toNumber } from '@opengraphity/neo4j'
import { getEmbedder, vectorIndexName } from './embeddings.js'
import { aiDisabledError, aiFeatureEnabled } from '../lib/aiSettings.js'
import { getAnthropic, registraChiamataFallita, registraDurata, registraRisposta } from '../lib/aiClient.js'
// Le etichette dei CI vengono dal metamodello del tenant (A-9): con la lista
// fissa l'assistente non trovava i CI dei tipi creati dal cliente e rispondeva
// «non trovato» — un buco invisibile a chi fa la domanda.
import { ciLabelsForTenant } from '../lib/ciLabelsForTenant.js'
// «Aperto» e «concluso» vengono dai metadata dei passi del workflow di QUESTO
// cliente (ondata 8 · B-22): le liste di nomi scritte a mano contavano come
// aperto un passo terminale aggiunto dal cliente, e nominavano stati
// (`completed`, `cancelled`) che nessun workflow produce.
import { concludedStatusNames } from '../lib/statusStepNames.js'
import { logger } from '../lib/logger.js'
import { languageForUser } from '../lib/tenantLanguage.js'
import { LANGUAGE_NAME_FOR_MODEL } from '../lib/systemText.js'
import { localDateTimeIn, tenantTimezone } from '../lib/tenantTimezone.js'

const log = logger.child({ module: 'assistant' })

// ── Query helpers (all tenant-scoped, read-only) ─────────────────────────────

async function readQuery<T>(cypher: string, params: Record<string, unknown>): Promise<T[]> {
  const session = getSession(undefined, 'READ')
  try {
    return await runQuery<T>(session, cypher, params)
  } finally {
    await session.close()
  }
}

/** Quanti articoli propone la ricerca semantica nella KB. */
const KB_SEARCH_LIMIT = 5

/** Ricerca vettoriale del tenant su una sessione di sola lettura (B-12). */
async function vectorSearch<T>(tenantId: string, opts: Omit<Parameters<typeof vectorSearchForTenant>[1], 'tenantId'>): Promise<T[]> {
  const session = getSession(undefined, 'READ')
  try {
    return await vectorSearchForTenant<T>(session, { ...opts, tenantId })
  } finally {
    await session.close()
  }
}

function j(value: unknown): string {
  // Neo4j Integer objects serialize as {low, high} — normalize first.
  return JSON.stringify(value, (_k, v: unknown) =>
    typeof v === 'object' && v !== null && 'low' in v && 'high' in v && Object.keys(v).length === 2
      ? (v as { low: number }).low
      : v,
  )
}

// ── Tool implementations ─────────────────────────────────────────────────────

/** Detto al modello quando l'organizzazione ha spento gli embedding: la ricerca per significato non c'è. */
const SEMANTIC_SEARCH_OFF = JSON.stringify({ error: 'Semantic search is turned off for this organization (embeddings disabled). Use lista_incident or cerca_ci instead.' })

function buildTools(tenantId: string, permissions: ReadonlySet<Permission>, timeZone: string) {
  const can = (p: Permission) => permissions.has(p)
  /** Instants reach the model as wall-clock time in the organization's zone (D14), like in the drafts. */
  const local = (v: unknown) => localDateTimeIn(typeof v === 'string' ? v : null, timeZone)
  const cercaIncident = betaTool({
    name: 'cerca_incident',
    description: 'Semantic search among the incidents of the organization (past and open). Use it to find incidents by topic, symptom or free text. Returns number, title, status, severity, team and a similarity score. It is a top-K search, not a count.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text to search for' },
        limit: { type: 'number', description: 'Maximum results (default 5)' },
      },
      required: ['query'],
    },
    run: async (input) => {
      const { query, limit } = input as { query: string; limit?: number }
      if (!(await aiFeatureEnabled(tenantId, 'embeddings'))) return SEMANTIC_SEARCH_OFF
      const [embedding] = await getEmbedder().embed([query])
      // K cresce finché i risultati DEL TENANT bastano: l'indice vettoriale è
      // cross-tenant (revisione totale · B-12).
      const rows = await vectorSearch(tenantId, {
        index: vectorIndexName('Incident'),
        embedding,
        limit: clampLimit(limit, 5, 15),
        extra: 'OPTIONAL MATCH (node)-[:ASSIGNED_TO_TEAM]->(team:Team)',
        returns: `node.number AS numero, node.title AS titolo, node.status AS stato,
               node.severity AS severity, node.category AS categoria,
               team.name AS team, round(score, 2) AS similarita, node.id AS id`,
        what: 'assistant.cerca_incident',
      })
      return j(rows)
    },
  })

  const dettaglioIncident = betaTool({
    name: 'dettaglio_incident',
    description: 'Full detail of an incident by number (e.g. INC00000012) or id: description, status, team, impacted CIs and latest comments.',
    inputSchema: {
      type: 'object',
      properties: { numero_o_id: { type: 'string' } },
      required: ['numero_o_id'],
    },
    run: async (input) => {
      const { numero_o_id } = input as { numero_o_id: string }
      const rows = await readQuery(`
        MATCH (i:Incident {tenant_id: $tenantId})
        WHERE i.number = $key OR i.id = $key
        OPTIONAL MATCH (i)-[:ASSIGNED_TO_TEAM]->(team:Team)
        OPTIONAL MATCH (i)-[:AFFECTED_BY]->(ci)
        WITH i, team, collect(DISTINCT ci.name) AS cis
        // The LATEST comments, as the description promises: the three were
        // whichever the graph returned first.
        OPTIONAL MATCH (i)-[:HAS_COMMENT]->(c:Comment)
        WITH i, team, cis, c ORDER BY c.created_at DESC
        WITH i, team, cis, collect(c.text)[..3] AS commenti
        RETURN i.number AS numero, i.title AS titolo, i.description AS descrizione,
               i.status AS stato, i.severity AS severity, i.category AS categoria,
               i.created_at AS creato, i.resolved_at AS risolto,
               team.name AS team, cis AS ci_impattati, commenti
      `, { tenantId, key: numero_o_id })
      const row = rows[0] as Record<string, unknown> | undefined
      return row ? j({ ...row, creato: local(row['creato']), risolto: local(row['risolto']) }) : j({ errore: `Incident ${numero_o_id} not found` })
    },
  })

  const cercaCI = betaTool({
    name: 'cerca_ci',
    description: 'Search Configuration Items by name (partial, case-insensitive match). Returns id, name, type, environment and status.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
    },
    run: async (input) => {
      const { query, limit } = input as { query: string; limit?: number }
      const rows = await readQuery(`
        MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
        WHERE any(l IN labels(ci) WHERE l IN $labels)
          AND toLower(ci.name) CONTAINS toLower($query)
        RETURN ci.id AS id, ci.name AS nome, head([l IN labels(ci) WHERE l <> 'ConfigurationItem']) AS tipo,
               ci.environment AS ambiente, ci.status AS stato
        LIMIT ${clampLimit(limit, 8, 20)}
      `, { tenantId, labels: await ciLabelsForTenant(tenantId), query })
      return j(rows)
    },
  })

  const analisiImpatto = betaTool({
    name: 'analisi_impatto',
    description: 'Impact analysis of a CI: who depends on it (directly and at 2 levels), reachable business capabilities, open incidents and changes touching it. Use it for questions like "what happens if I switch X off".',
    inputSchema: {
      type: 'object',
      properties: { ci_id_o_nome: { type: 'string' } },
      required: ['ci_id_o_nome'],
    },
    run: async (input) => {
      const { ci_id_o_nome } = input as { ci_id_o_nome: string }
      const rows = await readQuery(`
        MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
        WHERE any(l IN labels(ci) WHERE l IN $labels)
          AND (ci.id = $key OR toLower(ci.name) = toLower($key))
        OPTIONAL MATCH (dep)-[:DEPENDS_ON]->(ci)
        WITH ci, collect(DISTINCT {nome: dep.name, tipo: head([l IN labels(dep) WHERE l <> 'ConfigurationItem'])}) AS dipendenti_diretti
        OPTIONAL MATCH (dep2)-[:DEPENDS_ON*2]->(ci)
        WITH ci, dipendenti_diretti, count(DISTINCT dep2) AS dipendenti_secondo_livello
        // The capabilities that REALLY depend on this CI (review of 23 Sep 2026):
        // capability → ENABLED_BY → business application, which is the CI or
        // whose service map INCLUDES it. It was any relationship in any
        // direction up to 4 hops — through a shared team almost every CI
        // «reached» some capability, and the triage raised its severity.
        OPTIONAL MATCH (cap:BusinessCapability {tenant_id: $tenantId})-[:ENABLED_BY]->(ba:BusinessApplication {tenant_id: $tenantId})
          WHERE ba = ci OR EXISTS { MATCH (ba)-[:HAS_SERVICE_MAP]->(:ServiceMap {tenant_id: $tenantId})-[:INCLUDES]->(ci) }
        WITH ci, dipendenti_diretti, dipendenti_secondo_livello,
             collect(DISTINCT cap.name)[..5] AS business_capability
        OPTIONAL MATCH (inc:Incident {tenant_id: $tenantId})-[:AFFECTED_BY]->(ci)
        WHERE $seeIncidents AND NOT inc.status IN $incidentConcluded
        WITH ci, dipendenti_diretti, dipendenti_secondo_livello, business_capability,
             collect(DISTINCT inc.number) AS incident_aperti
        // La relazione delle CHANGE è AFFECTS_CI (revisione totale · D-10):
        // AFFECTS lega i PROBLEM ai CI, quindi «change in corso su questo CI»
        // era sempre vuoto — e all'assistente sembrava che non ce ne fossero.
        OPTIONAL MATCH (ch:Change {tenant_id: $tenantId})-[:AFFECTS_CI]->(ci)
        WHERE $seeChanges AND NOT ch.status IN $changeConcluded AND coalesce(ch.deleted, false) = false
        RETURN ci.name AS nome, head([l IN labels(ci) WHERE l <> 'ConfigurationItem']) AS tipo, ci.environment AS ambiente,
               dipendenti_diretti, dipendenti_secondo_livello, business_capability,
               incident_aperti, collect(DISTINCT coalesce(ch.number, ch.code)) AS change_in_corso
      `, {
        tenantId, labels: await ciLabelsForTenant(tenantId), key: ci_id_o_nome,
        incidentConcluded: await concludedStatusNames(tenantId, 'incident'),
        changeConcluded:   await concludedStatusNames(tenantId, 'change'),
        seeIncidents: can('incident.read'), seeChanges: can('change.read'),
      })
      if (!rows.length) return j({ errore: `CI "${ci_id_o_nome}" not found: use cerca_ci to find the exact name` })
      // Quello che il ruolo non vede non c'è nemmeno come «zero»: il modello non deve dire «nessun incident».
      const row = { ...(rows[0] as Record<string, unknown>) }
      if (!can('incident.read')) delete row['incident_aperti']
      if (!can('change.read')) delete row['change_in_corso']
      return j(row)
    },
  })

  const listaIncident = betaTool({
    name: 'lista_incident',
    description: 'List and EXACT COUNT of incidents, with optional filters on status, severity and category. Use THIS (not cerca_incident) for questions like "how many open incidents do we have" or "list the critical incidents": the field "totale" is the exact number in the database; "elencati" is how many are listed.',
    inputSchema: {
      type: 'object',
      properties: {
        stato:       { type: 'string', description: "Exact status filter: the NAME of a step of this organization's workflow" },
        solo_aperti: { type: 'boolean', description: "true = leave out concluded tickets (resolved and terminal steps of this organization's workflow)" },
        severity:    { type: 'string', description: 'Severity filter (low, medium, high, critical)' },
        categoria:   { type: 'string', description: 'Category filter' },
        limit:       { type: 'number', description: 'Maximum incidents listed (default 15; the total is exact anyway)' },
      },
      required: [],
    },
    run: async (input) => {
      const { stato, solo_aperti, severity, categoria, limit } = input as {
        stato?: string; solo_aperti?: boolean; severity?: string; categoria?: string; limit?: number
      }
      const n = clampLimit(limit, 15, 50)
      const rows = await readQuery<{ totale: unknown; incident: unknown[] }>(`
        MATCH (i:Incident {tenant_id: $tenantId})
        WHERE ($stato IS NULL OR i.status = $stato)
          AND ($severity IS NULL OR i.severity = $severity)
          AND ($categoria IS NULL OR i.category = $categoria)
          AND ($soloAperti = false OR NOT i.status IN $concluded)
        WITH i ORDER BY i.created_at DESC
        WITH collect({numero: i.number, titolo: i.title, stato: i.status,
                      severity: i.severity, categoria: i.category, creato: i.created_at}) AS tutti
        RETURN size(tutti) AS totale, tutti[..${n}] AS incident
      `, {
        tenantId,
        stato: stato ?? null,
        severity: severity ?? null,
        categoria: categoria ?? null,
        soloAperti: solo_aperti === true,
        concluded: solo_aperti === true ? await concludedStatusNames(tenantId, 'incident') : [],
      })
      const r = rows[0] ?? { totale: 0, incident: [] }
      const listed = (Array.isArray(r.incident) ? r.incident : []) as Array<Record<string, unknown>>
      return j({ totale: r.totale, elencati: listed.length, incident: listed.map((x) => ({ ...x, creato: local(x['creato']) })) })
    },
  })

  /*
   * THE EXACT TOTAL, NOT THE FIRST PAGE (tour of 23 Sep 2026, D73).
   * The tool returned the ten or twenty most recent changes and nothing else:
   * asked «which changes are in flight», the model answered «20 open changes,
   * none in implementation, no CI overlap» while there were 602, 44 of them in
   * deployment and a third with deploy conflicts. Now the tool gives the exact
   * total and the count per step, says when its list is partial, and the
   * status comes from the workflow when the change has none (a change in its
   * first step had no `status`, D3, and `NOT null IN [...]` left it out).
   */
  const changeAperti = betaTool({
    name: 'change_aperti',
    description: 'EXACT count and list of the changes that are not concluded. "totale" is the exact number of open changes and "per_passo" how many are in each workflow step; "change" lists only the most recent ones ("elencati" of "totale", with status, type, risk and the CIs they touch). Use it for questions about changes in progress, scheduled or waiting for approval. Deploy conflicts are not computed by this tool: never infer them from the list.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Maximum changes listed (default 10; the total and the per-step counts are exact anyway)' } },
      required: [],
    },
    run: async (input) => {
      const { limit } = input as { limit?: number }
      const concluded = await concludedStatusNames(tenantId, 'change')
      const perStep = await readQuery<{ passo: string; n: unknown }>(`
        MATCH (ch:Change {tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
        WHERE coalesce(ch.deleted, false) = false
        WITH coalesce(ch.status, wi.current_step) AS passo
        WHERE NOT passo IN $concluded
        RETURN passo, count(*) AS n
        ORDER BY n DESC
      `, { tenantId, concluded })
      const rows = await readQuery(`
        MATCH (ch:Change {tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
        WHERE coalesce(ch.deleted, false) = false AND NOT coalesce(ch.status, wi.current_step) IN $concluded
        WITH ch, wi ORDER BY ch.created_at DESC LIMIT ${clampLimit(limit, 10, 25)}
        // D-10: AFFECTS_CI, e i campi che una change ha DAVVERO: risk_level e
        // planned_start non esistono sul nodo (il rischio sta in
        // aggregate_risk_score), quindi l'assistente rispondeva «rischio:
        // null» su ogni change.
        OPTIONAL MATCH (ch)-[:AFFECTS_CI]->(ci)
        WITH ch, wi, collect(DISTINCT ci.name) AS cis
        RETURN coalesce(ch.number, ch.code) AS numero, ch.title AS titolo, coalesce(ch.status, wi.current_step) AS stato,
               ch.change_type AS tipo, ch.aggregate_risk_score AS punteggio_rischio,
               ch.priority AS priorita, cis AS ci_toccati
        ORDER BY ch.created_at DESC
      `, { tenantId, concluded })
      const totale = perStep.reduce((sum, r) => sum + toNumber(r.n), 0)
      return j({
        totale,
        per_passo: perStep.map((r) => ({ passo: r.passo, n: toNumber(r.n) })),
        elencati: rows.length,
        elenco_parziale: rows.length < totale,
        change: rows,
      })
    },
  })

  const cercaKB = betaTool({
    name: 'cerca_kb',
    description: 'Semantic search in the published Knowledge Base articles. Returns title, category, slug and score.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    run: async (input) => {
      const { query } = input as { query: string }
      if (!(await aiFeatureEnabled(tenantId, 'embeddings'))) return SEMANTIC_SEARCH_OFF
      const [embedding] = await getEmbedder().embed([query])
      const rows = await vectorSearch(tenantId, {
        index: vectorIndexName('KBArticle'),
        embedding,
        limit: KB_SEARCH_LIMIT,
        where: kbArticlePublishedCypher('node'),
        returns: `node.title AS titolo, node.category AS categoria,
               node.slug AS slug, round(score, 2) AS similarita`,
        what: 'assistant.cerca_kb',
      })
      return j(rows)
    },
  })

  return [
    ...(can('incident.read') ? [cercaIncident, dettaglioIncident, listaIncident] : []),
    ...(can('cmdb.read') ? [cercaCI, analisiImpatto] : []),
    ...(can('change.read') ? [changeAperti] : []),
    ...(can('kb.read') ? [cercaKB] : []),
  ]
}

// ── Streaming chat ───────────────────────────────────────────────────────────

/*
 * THE LANGUAGE IS SAID, NOT GUESSED (tour of 23 Sep 2026, D62).
 * The prompt was written in Italian and asked to «answer in the language the
 * user writes in»: on an English interface, asked in English, the assistant
 * started in English and went on in Italian. Now the prompt is in English and
 * names the language of the person's interface (their own choice, or the
 * organization's).
 */
export function assistantSystemPrompt(language: string, timeZone: string): string {
  return `You are the operations assistant of OpenGrafo, an ITSM platform built on a Neo4j graph (CMDB, incidents, changes, knowledge base).
Write every sentence in ${language}, the language of the person's interface, including the sentences you write before using a tool. Be concise and concrete.

Rules:
- Ground EVERY answer on the organization's real data through the tools. Never invent ticket numbers, CI names or statuses.
- For COUNTS or filtered lists use lista_incident (exact count) and change_aperti (exact count per step); cerca_incident is a top-K semantic search and is not exhaustive.
- When a tool returns a partial list ("elencati" smaller than "totale", or "elenco_parziale": true), say that it is partial and never draw conclusions about the whole set from it.
- Always quote the numbers of the entities (INC..., CHG...) and the exact names of the CIs you mention.
- Every time in the tool results is local time in the organization's time zone, ${timeZone}: quote times as they are and never convert them.
- If a tool finds nothing, say so explicitly: do not fill the gap with guesses.
- You only have READ tools: you cannot create or change anything. If the person asks for an action, explain where to do it in the interface.
- For impact questions ("what happens if I switch X off"), use analisi_impatto and summarise: dependants, business capabilities, open incidents and changes.
- You only have the tools for the data the person's role can see. If a question is about data you have no tool for, say that their role does not see it: do not deduce it and do not say it does not exist.
- Short answers: bullet points where useful, no preamble.`
}

export interface AssistantMessage { role: 'user' | 'assistant'; content: string }

export interface AssistantEmitter {
  text(delta: string): void
  tool(name: string): void
  done(fullText: string): void
  error(message: string): void
}

export async function streamAssistantChat(
  tenantId: string,
  userId: string,
  permissions: ReadonlySet<Permission>,
  messages: AssistantMessage[],
  emit: AssistantEmitter,
): Promise<void> {
  if (!config.anthropicApiKey) {
    emit.error('AI assistant not configured: ANTHROPIC_API_KEY is missing')
    return
  }
  // Funzione spenta dall'organizzazione: nessuna chiamata al modello (ondata 6).
  if (!(await aiFeatureEnabled(tenantId, 'assistant'))) {
    emit.error(aiDisabledError('assistant').message)
    return
  }

  // The times the tools return are local to the organization (D14): without a zone they could only be raw UTC.
  const timeZone = await tenantTimezone(tenantId)
  if (!timeZone) {
    emit.error('The organization has no time zone, so the assistant cannot write times in local time: choose it in Settings → Organization.')
    return
  }

  const client = getAnthropic()
  const t0 = Date.now()
  let fullText = ''

  try {
    const runner = client.beta.messages.toolRunner({
      model: config.anthropicModel,
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      system: [{ type: 'text', text: assistantSystemPrompt(LANGUAGE_NAME_FOR_MODEL[await languageForUser(tenantId, userId)], timeZone), cache_control: { type: 'ephemeral' } }],
      tools: buildTools(tenantId, permissions, timeZone),
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: true,
      max_iterations: 8,
    })

    for await (const messageStream of runner) {
      for await (const event of messageStream) {
        if (event.type === 'content_block_start' && event.content_block.type === 'text' && fullText !== '' && !fullText.endsWith('\n')) {
          // Giro nel browser del 14 set 2026 (#52): la frase scritta prima di
          // uno strumento e la risposta dopo erano incollate («…clienti.**CI:»).
          // Un nuovo blocco di testo comincia su un paragrafo nuovo.
          fullText += '\n\n'
          emit.text('\n\n')
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          fullText += event.delta.text
          emit.text(event.delta.text)
        } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
          emit.tool(event.content_block.name)
        }
      }
      const message = await messageStream.finalMessage()
      // Ogni giro dell'agente è una chiamata al modello e si conta come tale:
      // l'assistente ne fa fino a `max_iterations`, ed è la funzione AI che
      // può costare di più senza che nessuno se ne accorga.
      registraRisposta('assistant', message.stop_reason === 'refusal' ? 'refused' : 'ok', message)
      if (message.stop_reason === 'refusal') {
        emit.error('The model refused the request')
        return
      }
    }

    registraDurata('assistant', Date.now() - t0)
    log.info({ ms: Date.now() - t0, turns: messages.length }, '[assistant] chat completed')
    emit.done(fullText)
  } catch (err) {
    registraChiamataFallita('assistant', err)
    const msg = err instanceof Error ? err.message : String(err)
    log.error({ err, tenantId }, '[assistant] chat failed')
    emit.error(msg)
  }
}
