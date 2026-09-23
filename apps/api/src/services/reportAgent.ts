/**
 * Report AI agent — one agentic loop over the Anthropic SDK shared by the
 * streaming (SSE) and non-streaming (GraphQL) entry points.
 *
 * Before C-20a `streamReportAI` and `callReportAI` each carried their own
 * system prompt, tool definition, raw `fetch` + hand-written SSE parser and
 * loop, and had drifted to different models. Now there is a single system
 * prompt, a single tool, a single model and a single loop bounded by
 * `ToolLoopBudget`; the only difference between the two callers is the
 * optional `stream` callback.
 */
import Anthropic from '@anthropic-ai/sdk'
import { getAnthropic, registraRisposta } from '../lib/aiClient.js'
import { getSession, toNumber } from '@opengraphity/neo4j'
import { config } from '../lib/config.js'
import { logger } from '../lib/logger.js'
import { assertSafeReadOnlyCypher, redactSensitiveValue, UnsafeCypherError } from '../lib/cypherGuard.js'

// ── Model ─────────────────────────────────────────────────────────────────

/**
 * Modello dell'agente dei report: quello di tutti i servizi AI
 * (`config.anthropicModel`, variabile `ANTHROPIC_MODEL`), con `REPORT_AI_MODEL`
 * come scavalco del solo agente. Nessun id di modello scritto qui: il
 * commento di prima diceva «la stessa costante degli altri» e non era vero,
 * gli altri lo avevano copiato a mano.
 */
export const DEFAULT_REPORT_AI_MODEL = config.anthropicModel

export function resolveReportAIModel(): string {
  const fromEnv = process.env['REPORT_AI_MODEL']?.trim()
  return fromEnv || config.anthropicModel
}

/** Per-turn output cap (the cumulative cap is REPORT_AI_LIMITS.maxOutputTokens). */
const MAX_TOKENS_PER_TURN = 4096

// ── Schema cache ──────────────────────────────────────────────────────────

const schemaCache = new Map<string, { schema: string; expiresAt: number }>()

/**
 * Quanti nodi e quante relazioni si guardano per ricavare FORMA del grafo
 * (revisione totale · D-23).
 *
 * Le due letture che elencano proprietà e relazioni erano `MATCH (n)` e
 * `MATCH (a)-[r]->(b)` senza etichetta: una scansione di tutti i nodi e di
 * tutte le relazioni del database, alla prima domanda di ogni cinque minuti.
 * Per sapere «quali proprietà ha un Incident» non serve leggerli tutti: un
 * campione basta, e i CONTEGGI (che devono essere esatti, perché finiscono
 * nella risposta) restano un'aggregazione a parte.
 */
const SCHEMA_NODE_SAMPLE = 20_000
const SCHEMA_REL_SAMPLE  = 20_000

async function buildSchemaContext(session: ReturnType<typeof getSession>, tenantId: string): Promise<string> {
  const nodesResult = await session.executeRead((tx) => tx.run(`
    MATCH (n)
    WHERE n.tenant_id = $tenantId
    WITH n LIMIT toInteger($nodeSample)
    WITH head([l IN labels(n) WHERE l <> 'ConfigurationItem']) AS label, keys(n) AS props
    WITH label, [p IN props WHERE p <> 'tenant_id'] AS props
    RETURN DISTINCT label, props
    ORDER BY label
  `, { tenantId, nodeSample: SCHEMA_NODE_SAMPLE }))
  const relsResult = await session.executeRead((tx) => tx.run(`
    MATCH (a)-[r]->(b)
    WHERE a.tenant_id = $tenantId
    WITH a, r, b LIMIT toInteger($relSample)
    RETURN DISTINCT
      head([l IN labels(a) WHERE l <> 'ConfigurationItem']) AS from,
      type(r) AS rel,
      head([l IN labels(b) WHERE l <> 'ConfigurationItem']) AS to
    ORDER BY from, rel
  `, { tenantId, relSample: SCHEMA_REL_SAMPLE }))
  const countsResult = await session.executeRead((tx) => tx.run(`
    MATCH (n)
    WHERE n.tenant_id = $tenantId
    RETURN head([l IN labels(n) WHERE l <> 'ConfigurationItem']) AS label, count(n) AS count
    ORDER BY count DESC
  `, { tenantId }))

  let schema = '## Neo4j graph schema\n\n'

  schema += '### Available nodes:\n'
  for (const r of nodesResult.records) {
    const label = r.get('label') as string
    const props = r.get('props') as string[]
    const countRec = countsResult.records.find((c) => c.get('label') === label)
    // `toNumber` del pacchetto: il driver dà un `number` JS per i conteggi, e
    // `.toNumber()` alla cieca rompeva l'analisi AI (giro nel browser del 14 set 2026).
    const count = countRec ? toNumber(countRec.get('count')) : 0
    schema += `- **${label}** (${count} nodes): ${props.join(', ')}\n`
  }

  schema += '\n### Relationships:\n'
  for (const r of relsResult.records) {
    schema += `- (${r.get('from') as string})-[:${r.get('rel') as string}]->(${r.get('to') as string})\n`
  }

  return schema
}

/**
 * How long the shape of the graph is considered fresh. The exact per-label
 * counts read every node of the tenant — 2.7 s on the demo tenant, and no
 * index helps (tour of 23 Sep 2026, D67) — while the shape changes slowly.
 */
export const SCHEMA_TTL_MS = 30 * 60 * 1000

const schemaRefreshes = new Map<string, Promise<string>>()

async function rebuildSchema(tenantId: string): Promise<string> {
  const schemaSession = getSession(undefined, 'READ')
  try {
    const schema = await buildSchemaContext(schemaSession, tenantId)
    schemaCache.set(tenantId, { schema, expiresAt: Date.now() + SCHEMA_TTL_MS })
    return schema
  } finally {
    await schemaSession.close()
  }
}

/** One rebuild per tenant at a time: concurrent questions share it. */
function refreshSchema(tenantId: string): Promise<string> {
  const running = schemaRefreshes.get(tenantId)
  if (running) return running
  const next = rebuildSchema(tenantId).finally(() => { schemaRefreshes.delete(tenantId) })
  schemaRefreshes.set(tenantId, next)
  return next
}

/**
 * The schema for the prompt. Only the very first question of a tenant waits
 * for the scan; after that an expired schema is used as it is while a new
 * one is built in the background (D67) — a failed rebuild is logged and the
 * next question tries again.
 */
export async function getCachedSchema(tenantId: string): Promise<string> {
  const cached = schemaCache.get(tenantId)
  if (cached && cached.expiresAt > Date.now()) return cached.schema
  if (!cached) return refreshSchema(tenantId)
  refreshSchema(tenantId).catch((err: unknown) => {
    logger.error({ err, tenantId }, `${LOG_LABEL} schema rebuild failed: the previous one stays in use until the next attempt`)
  })
  return cached.schema
}

/** For tests: forget every cached schema. */
export function clearSchemaCache(): void {
  schemaCache.clear()
  schemaRefreshes.clear()
}

// ── Tool definition + system prompt ───────────────────────────────────────

/*
 * In English like the system prompt (tour of 23 Sep 2026, D62): an Italian
 * tool description pulled the answers towards Italian on an English interface.
 */
export const CYPHER_TOOL: Anthropic.Tool = {
  name: 'run_cypher_query',
  description:
    'Runs a READ-ONLY Cypher query on Neo4j to fetch data about incidents, changes, CIs, teams and SLAs. ' +
    'The tenant is NOT filtered automatically: every node pattern a MATCH starts from MUST include ' +
    '{tenant_id: $tenantId} (nodes reached through a relationship from such a node are allowed). ' +
    'Refused: write clauses (CREATE/MERGE/SET/DELETE/REMOVE), procedure CALLs (except apoc.text/coll/map/date), ' +
    'parameters other than $tenantId, backticks and multiple statements. A refused query returns the reason: fix it and try again.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'A valid read-only Cypher query. Use $tenantId as the only parameter and name the label of every node, e.g. MATCH (i:Incident {tenant_id: $tenantId})-[:AFFECTS]->(c:ConfigurationItem) … Do not use LIMIT > 100.',
      },
      description: {
        type: 'string',
        description: 'A short description of what you are looking for',
      },
    },
    required: ['query', 'description'],
  },
}

/*
 * THE LANGUAGE IS SAID, NOT GUESSED (tour of 23 Sep 2026, D62).
 * The prompt was written in Italian and asked to «answer in the language of
 * the question»: asked in English on an English interface, the analysis
 * answered in Italian. The prompt is now in English and names the language of
 * the person's interface.
 */
export function buildSystemPrompt(schemaContext: string, language: string): string {
  return `You are an ITSM analysis assistant for OpenGrafo.
You can read a Neo4j graph through the run_cypher_query tool.
Write every sentence in ${language}, the language of the person's interface, including the sentences you write before running a query.

${schemaContext}

RULES:
- You MUST ALWAYS use run_cypher_query to answer any question about the data. NEVER invent data, counts or names you have not read from the database.
- If you cannot find the data with a query, say so explicitly and propose another query.
- NEVER answer with numbers or lists without reading them first with run_cypher_query.
- MANDATORY tenant constraint: every MATCH pattern must start from a node with {tenant_id: $tenantId}, e.g. MATCH (i:Incident {tenant_id: $tenantId})-[:AFFECTED_BY]->(c:ConfigurationItem). Queries without it are rejected.
- EVERY node of the pattern must have its label written: (c:ConfigurationItem), never (c) at first use. The labels of the integrations (OutboundWebhook, InboundWebhook, ApiKey, NotificationChannel, SlackInstallation, SyncSource) and the properties holding secrets (secret, headers, token, credentials, webhook_url, key_hash, transform_script) cannot be read.
- Reads only: no CREATE/MERGE/SET/DELETE, no CALL of procedures, no parameter other than $tenantId.
- Never put UUIDs in tables: use readable titles and names.
- In tables use only meaningful columns: Title, Type, Status, Severity, CI, Team, Date.
- Truncate long texts to 40 characters in table cells.
- To compute MTTR use WorkflowStepExecution. Find the initial step (entered_at) and the final step dynamically with:
  MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: 'incident'})-[:HAS_STEP]->(s:WorkflowStep)
  WHERE coalesce(s.is_initial, s.type = 'start') OR s.category = 'resolved' OR coalesce(s.is_terminal, s.type = 'end')
  RETURN s.name. Then use these names to look up the StepExecution entered_at.
- Dates are ISO strings.
- You can run several queries to answer.
- Use markdown tables when the data is tabular.
- Be concise and direct, no verbose introductions.
- Always show the concrete data, do not generalise.`
}

// ── Agentic loop budget (C-08) ────────────────────────────────────────────

export const REPORT_AI_LIMITS = {
  /** Tool calls (Cypher queries) per question. */
  maxIterations:   8,
  /** Guard rejections tolerated per question before failing the request. */
  maxRejections:   2,
  /** Cumulative model output tokens per question. */
  maxOutputTokens: 16_000,
  /** Wall-clock budget per question. */
  maxDurationMs:   120_000,
} as const

export class ToolLoopBudget {
  iterations   = 0
  rejections   = 0
  outputTokens = 0
  private readonly startedAt = Date.now()

  constructor(private readonly limits = REPORT_AI_LIMITS) {}

  beforeModelCall(): void {
    const elapsed = Date.now() - this.startedAt
    if (elapsed > this.limits.maxDurationMs) {
      throw new Error(`[reportAI] time budget exhausted (${Math.round(elapsed / 1000)}s > ${this.limits.maxDurationMs / 1000}s)`)
    }
    if (this.outputTokens > this.limits.maxOutputTokens) {
      throw new Error(`[reportAI] token budget exhausted (${this.outputTokens} > ${this.limits.maxOutputTokens} output tokens)`)
    }
  }

  beforeToolCall(): void {
    this.iterations++
    if (this.iterations > this.limits.maxIterations) {
      throw new Error(`[reportAI] limit of ${this.limits.maxIterations} queries per question exceeded`)
    }
  }

  recordRejection(reason: string): void {
    this.rejections++
    if (this.rejections > this.limits.maxRejections) {
      throw new Error(`[reportAI] the query generated by the model was refused ${this.rejections} times by the safety guard — last reason: ${reason}`)
    }
  }

  recordUsage(outputTokens: number | undefined): void {
    if (typeof outputTokens === 'number' && Number.isFinite(outputTokens)) this.outputTokens += outputTokens
  }
}

/**
 * Validates (assertSafeReadOnlyCypher) and runs one model-generated query in a
 * READ session. A guard rejection is returned to the model as the tool result
 * so it can correct itself; after REPORT_AI_LIMITS.maxRejections the request
 * fails. Neo4j errors are likewise returned to the model.
 */
export async function runGuardedCypherTool(
  query: string,
  tenantId: string,
  budget: ToolLoopBudget,
  logLabel: string,
): Promise<string> {
  try {
    assertSafeReadOnlyCypher(query)
  } catch (err) {
    if (!(err instanceof UnsafeCypherError)) throw err
    logger.warn({ reason: err.message, query: query.slice(0, 500) }, `${logLabel}: Cypher rejected by guard`)
    budget.recordRejection(err.message)
    return `${err.message}\nRewrite the query: read-only, every MATCH pattern must include {tenant_id: $tenantId}, every node must name its label, the only parameter is $tenantId.`
  }

  const querySession = getSession(undefined, 'READ')
  try {
    const result = await querySession.executeRead((tx) => tx.run(query, { tenantId }))
    const rows = result.records.map((r) => {
      const obj: Record<string, unknown> = {}
      r.keys.forEach((k) => {
        const key = String(k)
        const val = r.get(key)
        obj[key] = val !== null && typeof val === 'object' && 'toNumber' in val
          ? (val as { toNumber(): number }).toNumber()
          : redactSensitiveValue(val)
      })
      return obj
    })
    let toolResult = JSON.stringify(rows, null, 2)
    if (toolResult.length > 8000) toolResult = toolResult.slice(0, 8000) + '\n... (truncated)'
    return toolResult
  } catch (err: unknown) {
    const toolResult = `Query error: ${err instanceof Error ? err.message : String(err)}`
    logger.warn({ toolResult }, `${logLabel} Cypher error`)
    return toolResult
  } finally {
    await querySession.close()
  }
}

// ── Agent loop ────────────────────────────────────────────────────────────

export type ReportAgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; description: string }

export interface RunReportAgentOptions {
  tenantId: string
  /** The language the answer is written in, as named for the model ("English", "Italian"). */
  language: string
  /** Conversation so far, ending with the user's question. */
  messages: Anthropic.MessageParam[]
  /** When given, text deltas and tool calls are emitted as they happen. */
  stream?: (event: ReportAgentEvent) => void
  /** Test seam; defaults to the shared client of `lib/aiClient.ts`. */
  client?: Anthropic
}

const LOG_LABEL = '[reportAI]'

/**
 * Runs the report agent to completion and returns the full assistant text
 * (concatenation of every text block across turns — identical to what a
 * streaming caller received chunk by chunk).
 */
export async function runReportAgent(opts: RunReportAgentOptions): Promise<string> {
  if (!process.env['ANTHROPIC_API_KEY']) throw new Error('ANTHROPIC_API_KEY not set')
  if (!opts.messages.length) throw new Error(`${LOG_LABEL} no messages to send`)

  const client = opts.client ?? getAnthropic()
  const system = buildSystemPrompt(await getCachedSchema(opts.tenantId), opts.language)
  const budget = new ToolLoopBudget()
  const messages: Anthropic.MessageParam[] = [...opts.messages]
  const model = resolveReportAIModel()
  let fullText = ''

  const base = {
    model,
    max_tokens: MAX_TOKENS_PER_TURN,
    thinking: { type: 'adaptive' } as const,
    // Schema context is stable for 5 minutes per tenant: cache the prefix so
    // the multi-turn loop does not pay for it on every tool round-trip.
    system: [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }],
    tools: [CYPHER_TOOL],
    tool_choice: { type: 'auto' as const },
  }

  const runTurn = async (): Promise<Anthropic.Message> => {
    if (opts.stream) {
      const emit = opts.stream
      const s = client.messages.stream({ ...base, messages })
      // Giro del 14 set 2026 (#52): il testo di un turno nuovo si incollava a
      // quello del turno prima («I'll query…Totale:»). Paragrafo nuovo.
      let firstDelta = true
      s.on('text', (delta) => {
        if (firstDelta && fullText !== '' && !fullText.endsWith('\n')) emit({ type: 'text', text: '\n\n' })
        firstDelta = false
        emit({ type: 'text', text: delta })
      })
      return s.finalMessage()
    }
    return client.messages.create({ ...base, messages })
  }

  // Bounded by ToolLoopBudget (iterations, rejections, tokens, time).
  while (true) {
    budget.beforeModelCall()
    const message = await runTurn()
    // Ogni turno dell'anello è una chiamata pagata: si conta, come le altre.
    registraRisposta('reportAnalysis', message.stop_reason === 'refusal' ? 'refused' : 'ok', message)
    budget.recordUsage(message.usage.output_tokens)

    for (const block of message.content) {
      if (block.type !== 'text') continue
      if (fullText !== '' && !fullText.endsWith('\n')) fullText += '\n\n'
      fullText += block.text
    }

    if (message.stop_reason === 'refusal') {
      throw new Error(`${LOG_LABEL} the model refused the request`)
    }
    if (message.stop_reason !== 'tool_use') {
      if (message.stop_reason === 'max_tokens') {
        logger.warn({ tenantId: opts.tenantId, maxTokens: MAX_TOKENS_PER_TURN }, `${LOG_LABEL} answer truncated by max_tokens`)
      }
      break
    }

    const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    messages.push({ role: 'assistant', content: message.content })

    // Every tool_use of the turn gets its result in ONE user message.
    const results: Anthropic.ToolResultBlockParam[] = []
    for (const toolUse of toolUses) {
      budget.beforeToolCall()
      if (toolUse.name !== CYPHER_TOOL.name) {
        throw new Error(`${LOG_LABEL} the model called an unknown tool "${toolUse.name}"`)
      }
      const input = toolUse.input as { query?: unknown; description?: unknown }
      if (typeof input.query !== 'string' || !input.query.trim()) {
        // A tool call without a query would produce a wrong-but-plausible answer.
        throw new Error(`${LOG_LABEL} tool input without a query (tool_use ${toolUse.id})`)
      }
      opts.stream?.({ type: 'tool', description: typeof input.description === 'string' ? input.description : '' })
      const content = await runGuardedCypherTool(input.query, opts.tenantId, budget, LOG_LABEL)
      results.push({ type: 'tool_result', tool_use_id: toolUse.id, content })
    }
    messages.push({ role: 'user', content: results })
  }

  return fullText
}
