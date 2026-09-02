/**
 * Conversational assistant grounded in the tenant's graph — Claude tool use
 * over READ-ONLY typed tools (incidents, CIs, impact, changes, KB).
 *
 * Security by design: every tool is tenant-scoped and read-only; the model
 * can only see what the tenant's own resolvers would expose. No mutations.
 * No-fallback: missing API key, tool failures and provider errors surface
 * as explicit SSE error events.
 */
import Anthropic from '@anthropic-ai/sdk'
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { getSession, runQuery } from '@opengraphity/neo4j'
import { getEmbedder, vectorIndexName } from './embeddings.js'
import { ALL_CI_LABELS } from '../lib/ciLabels.js'
import { logger } from '../lib/logger.js'

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

function j(value: unknown): string {
  // Neo4j Integer objects serialize as {low, high} — normalize first.
  return JSON.stringify(value, (_k, v: unknown) =>
    typeof v === 'object' && v !== null && 'low' in v && 'high' in v && Object.keys(v).length === 2
      ? (v as { low: number }).low
      : v,
  )
}

// ── Tool implementations ─────────────────────────────────────────────────────

function buildTools(tenantId: string) {
  const cercaIncident = betaTool({
    name: 'cerca_incident',
    description: 'Ricerca semantica tra gli incident del tenant (storici e aperti). Usalo per trovare incident per argomento, sintomo o testo libero. Ritorna numero, titolo, stato, severity, team e score di similarità.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Testo libero da cercare' },
        limit: { type: 'number', description: 'Max risultati (default 5)' },
      },
      required: ['query'],
    },
    run: async (input) => {
      const { query, limit } = input as { query: string; limit?: number }
      const [embedding] = await getEmbedder().embed([query])
      const rows = await readQuery(`
        CALL db.index.vector.queryNodes($index, 30, $embedding)
        YIELD node, score
        WHERE node.tenant_id = $tenantId
        OPTIONAL MATCH (node)-[:ASSIGNED_TO_TEAM]->(team:Team)
        RETURN node.number AS numero, node.title AS titolo, node.status AS stato,
               node.severity AS severity, node.category AS categoria,
               team.name AS team, round(score, 2) AS similarita, node.id AS id
        ORDER BY score DESC
        LIMIT ${Math.min(Math.trunc(limit ?? 5), 15)}
      `, { index: vectorIndexName('Incident'), embedding, tenantId })
      return j(rows)
    },
  })

  const dettaglioIncident = betaTool({
    name: 'dettaglio_incident',
    description: 'Dettaglio completo di un incident dato il numero (es. INC00000012) o l\'id: descrizione, stato, team, CI impattati e ultimi commenti.',
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
        OPTIONAL MATCH (i)-[:HAS_COMMENT]->(c:Comment)
        WITH i, team, collect(DISTINCT ci.name) AS cis,
             collect(DISTINCT c.text)[..3] AS commenti
        RETURN i.number AS numero, i.title AS titolo, i.description AS descrizione,
               i.status AS stato, i.severity AS severity, i.category AS categoria,
               i.created_at AS creato, i.resolved_at AS risolto,
               team.name AS team, cis AS ci_impattati, commenti
      `, { tenantId, key: numero_o_id })
      return rows.length ? j(rows[0]) : j({ errore: `Incident ${numero_o_id} non trovato` })
    },
  })

  const cercaCI = betaTool({
    name: 'cerca_ci',
    description: 'Cerca Configuration Item per nome (match parziale, case-insensitive). Ritorna id, nome, tipo, ambiente e stato.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
    },
    run: async (input) => {
      const { query, limit } = input as { query: string; limit?: number }
      const rows = await readQuery(`
        MATCH (ci {tenant_id: $tenantId})
        WHERE any(l IN labels(ci) WHERE l IN $labels)
          AND toLower(ci.name) CONTAINS toLower($query)
        RETURN ci.id AS id, ci.name AS nome, labels(ci)[0] AS tipo,
               ci.environment AS ambiente, ci.status AS stato
        LIMIT ${Math.min(Math.trunc(limit ?? 8), 20)}
      `, { tenantId, labels: ALL_CI_LABELS, query })
      return j(rows)
    },
  })

  const analisiImpatto = betaTool({
    name: 'analisi_impatto',
    description: 'Analisi di impatto di un CI: chi dipende da lui (diretti e a 2 livelli), Business Capability raggiungibili, incident aperti e change che lo toccano. Usalo per domande tipo "se spengo X cosa succede".',
    inputSchema: {
      type: 'object',
      properties: { ci_id_o_nome: { type: 'string' } },
      required: ['ci_id_o_nome'],
    },
    run: async (input) => {
      const { ci_id_o_nome } = input as { ci_id_o_nome: string }
      const rows = await readQuery(`
        MATCH (ci {tenant_id: $tenantId})
        WHERE any(l IN labels(ci) WHERE l IN $labels)
          AND (ci.id = $key OR toLower(ci.name) = toLower($key))
        OPTIONAL MATCH (dep)-[:DEPENDS_ON]->(ci)
        WITH ci, collect(DISTINCT {nome: dep.name, tipo: labels(dep)[0]}) AS dipendenti_diretti
        OPTIONAL MATCH (dep2)-[:DEPENDS_ON*2]->(ci)
        WITH ci, dipendenti_diretti, count(DISTINCT dep2) AS dipendenti_secondo_livello
        OPTIONAL MATCH (cap:BusinessCapability {tenant_id: $tenantId})-[*1..4]-(ci)
        WITH ci, dipendenti_diretti, dipendenti_secondo_livello,
             collect(DISTINCT cap.name)[..5] AS business_capability
        OPTIONAL MATCH (inc:Incident {tenant_id: $tenantId})-[:AFFECTED_BY]->(ci)
        WHERE NOT inc.status IN ['closed', 'resolved']
        WITH ci, dipendenti_diretti, dipendenti_secondo_livello, business_capability,
             collect(DISTINCT inc.number) AS incident_aperti
        OPTIONAL MATCH (ch:Change {tenant_id: $tenantId})-[:AFFECTS]->(ci)
        WHERE NOT ch.status IN ['completed', 'closed', 'cancelled', 'failed']
        RETURN ci.name AS nome, labels(ci)[0] AS tipo, ci.environment AS ambiente,
               dipendenti_diretti, dipendenti_secondo_livello, business_capability,
               incident_aperti, collect(DISTINCT ch.number) AS change_in_corso
      `, { tenantId, labels: ALL_CI_LABELS, key: ci_id_o_nome })
      return rows.length ? j(rows[0]) : j({ errore: `CI "${ci_id_o_nome}" non trovato — prova cerca_ci per il nome esatto` })
    },
  })

  const changeAperti = betaTool({
    name: 'change_aperti',
    description: 'Elenca i change non conclusi del tenant con stato, tipo, rischio e CI toccati. Usalo per domande su change in corso, pianificati o potenzialmente in conflitto.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max risultati (default 10)' } },
      required: [],
    },
    run: async (input) => {
      const { limit } = input as { limit?: number }
      const rows = await readQuery(`
        MATCH (ch:Change {tenant_id: $tenantId})
        WHERE NOT ch.status IN ['completed', 'closed', 'cancelled', 'failed']
        OPTIONAL MATCH (ch)-[:AFFECTS]->(ci)
        WITH ch, collect(DISTINCT ci.name) AS cis
        RETURN ch.number AS numero, ch.title AS titolo, ch.status AS stato,
               ch.change_type AS tipo, ch.risk_level AS rischio,
               ch.planned_start AS inizio_pianificato, cis AS ci_toccati
        ORDER BY ch.created_at DESC
        LIMIT ${Math.min(Math.trunc(limit ?? 10), 25)}
      `, { tenantId })
      return j(rows)
    },
  })

  const cercaKB = betaTool({
    name: 'cerca_kb',
    description: 'Ricerca semantica negli articoli pubblicati della Knowledge Base. Ritorna titolo, categoria, slug e score.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    run: async (input) => {
      const { query } = input as { query: string }
      const [embedding] = await getEmbedder().embed([query])
      const rows = await readQuery(`
        CALL db.index.vector.queryNodes($index, 15, $embedding)
        YIELD node, score
        WHERE node.tenant_id = $tenantId AND node.status = 'published'
        RETURN node.title AS titolo, node.category AS categoria,
               node.slug AS slug, round(score, 2) AS similarita
        ORDER BY score DESC
        LIMIT 5
      `, { index: vectorIndexName('KBArticle'), embedding, tenantId })
      return j(rows)
    },
  })

  return [cercaIncident, dettaglioIncident, cercaCI, analisiImpatto, changeAperti, cercaKB]
}

// ── Streaming chat ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Sei l'assistente operativo di OpenGrafo, una piattaforma ITSM basata su un grafo Neo4j (CMDB, incident, change, knowledge base). Rispondi in italiano, conciso e concreto.

Regole:
- Usa i tool per fondare OGNI risposta sui dati reali del tenant. Non inventare mai numeri di ticket, nomi di CI o stati.
- Cita sempre i numeri delle entità (INC..., CHG...) e i nomi esatti dei CI che riporti.
- Se un tool non trova nulla, dillo esplicitamente — non riempire il vuoto con supposizioni.
- Hai SOLO strumenti di lettura: non puoi creare o modificare nulla. Se l'utente chiede un'azione, spiega dove farla nella UI.
- Per domande di impatto ("se spengo X..."), usa analisi_impatto e riassumi: dipendenti, business capability, incident/change in corso.
- Risposte brevi: elenchi puntati dove utile, niente preamboli.`

export interface AssistantMessage { role: 'user' | 'assistant'; content: string }

export interface AssistantEmitter {
  text(delta: string): void
  tool(name: string): void
  done(fullText: string): void
  error(message: string): void
}

export async function streamAssistantChat(
  tenantId: string,
  messages: AssistantMessage[],
  emit: AssistantEmitter,
): Promise<void> {
  if (!process.env['ANTHROPIC_API_KEY']) {
    emit.error('Assistente AI non configurato: ANTHROPIC_API_KEY mancante')
    return
  }

  const client = new Anthropic()
  const t0 = Date.now()
  let fullText = ''

  try {
    const runner = client.beta.messages.toolRunner({
      model: 'claude-opus-4-8',
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: buildTools(tenantId),
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: true,
      max_iterations: 8,
    })

    for await (const messageStream of runner) {
      for await (const event of messageStream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          fullText += event.delta.text
          emit.text(event.delta.text)
        } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
          emit.tool(event.content_block.name)
        }
      }
      const message = await messageStream.finalMessage()
      if (message.stop_reason === 'refusal') {
        emit.error('Il modello ha rifiutato la richiesta')
        return
      }
    }

    log.info({ ms: Date.now() - t0, turns: messages.length }, '[assistant] chat completed')
    emit.done(fullText)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error({ err, tenantId }, '[assistant] chat failed')
    emit.error(msg)
  }
}
