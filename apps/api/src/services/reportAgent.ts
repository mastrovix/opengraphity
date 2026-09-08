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
import { getSession } from '@opengraphity/neo4j'
import { logger } from '../lib/logger.js'
import { assertSafeReadOnlyCypher, UnsafeCypherError } from '../lib/cypherGuard.js'

// ── Model ─────────────────────────────────────────────────────────────────

/**
 * Default model for the report agent — the same constant the other AI
 * services (assistant, triage, post-incident) already use. Override with the
 * `REPORT_AI_MODEL` environment variable (no other place picks the model).
 */
export const DEFAULT_REPORT_AI_MODEL = 'claude-opus-4-8'

export function resolveReportAIModel(): string {
  const fromEnv = process.env['REPORT_AI_MODEL']?.trim()
  return fromEnv || DEFAULT_REPORT_AI_MODEL
}

/** Per-turn output cap (the cumulative cap is REPORT_AI_LIMITS.maxOutputTokens). */
const MAX_TOKENS_PER_TURN = 4096

// ── Schema cache ──────────────────────────────────────────────────────────

const schemaCache = new Map<string, { schema: string; expiresAt: number }>()

async function buildSchemaContext(session: ReturnType<typeof getSession>, tenantId: string): Promise<string> {
  const nodesResult = await session.executeRead((tx) => tx.run(`
    MATCH (n)
    WHERE n.tenant_id = $tenantId
    WITH labels(n)[0] AS label, keys(n) AS props
    WITH label, [p IN props WHERE p <> 'tenant_id'] AS props
    RETURN DISTINCT label, props
    ORDER BY label
  `, { tenantId }))
  const relsResult = await session.executeRead((tx) => tx.run(`
    MATCH (a)-[r]->(b)
    WHERE a.tenant_id = $tenantId
    RETURN DISTINCT
      labels(a)[0] AS from,
      type(r) AS rel,
      labels(b)[0] AS to
    ORDER BY from, rel
  `, { tenantId }))
  const countsResult = await session.executeRead((tx) => tx.run(`
    MATCH (n)
    WHERE n.tenant_id = $tenantId
    RETURN labels(n)[0] AS label, count(n) AS count
    ORDER BY count DESC
  `, { tenantId }))

  let schema = '## Schema del grafo Neo4j\n\n'

  schema += '### Nodi disponibili:\n'
  for (const r of nodesResult.records) {
    const label = r.get('label') as string
    const props = r.get('props') as string[]
    const countRec = countsResult.records.find((c) => c.get('label') === label)
    const count = (countRec?.get('count') as { toNumber(): number } | null)?.toNumber() ?? 0
    schema += `- **${label}** (${count} nodi): ${props.join(', ')}\n`
  }

  schema += '\n### Relazioni:\n'
  for (const r of relsResult.records) {
    schema += `- (${r.get('from') as string})-[:${r.get('rel') as string}]->(${r.get('to') as string})\n`
  }

  return schema
}

async function getCachedSchema(tenantId: string): Promise<string> {
  const cached = schemaCache.get(tenantId)
  if (cached && cached.expiresAt > Date.now()) return cached.schema
  const schemaSession = getSession(undefined, 'READ')
  try {
    const schema = await buildSchemaContext(schemaSession, tenantId)
    schemaCache.set(tenantId, { schema, expiresAt: Date.now() + 5 * 60 * 1000 })
    return schema
  } finally {
    await schemaSession.close()
  }
}

// ── Tool definition + system prompt ───────────────────────────────────────

export const CYPHER_TOOL: Anthropic.Tool = {
  name: 'run_cypher_query',
  description:
    'Esegue una query Cypher di SOLA LETTURA su Neo4j per recuperare dati su incident, change, CI, team, SLA. ' +
    'Il tenant NON è filtrato automaticamente: ogni pattern di nodo da cui parte un MATCH DEVE includere ' +
    '{tenant_id: $tenantId} (i nodi raggiunti tramite relazione da un nodo così vincolato sono ammessi). ' +
    'Sono rifiutate: clausole di scrittura (CREATE/MERGE/SET/DELETE/REMOVE), CALL di procedure (eccetto apoc.text/coll/map/date), ' +
    'parametri diversi da $tenantId, backtick e più istruzioni. Una query rifiutata restituisce il motivo: correggila e riprova.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Query Cypher valida di sola lettura. Usa $tenantId come unico parametro, es. MATCH (i:Incident {tenant_id: $tenantId}) … Non usare LIMIT > 100.',
      },
      description: {
        type: 'string',
        description: 'Descrizione breve di cosa stai cercando',
      },
    },
    required: ['query', 'description'],
  },
}

export function buildSystemPrompt(schemaContext: string): string {
  return `Sei un assistente di analisi ITSM per OpenGraphity.
Hai accesso a un grafo Neo4j tramite il tool run_cypher_query.

${schemaContext}

REGOLE:
- DEVI SEMPRE usare run_cypher_query per rispondere a qualsiasi domanda sui dati. NON inventare mai dati, conteggi o nomi che non hai recuperato dal database.
- Se non riesci a trovare i dati con una query, dillo esplicitamente e proponi una query alternativa.
- Non rispondere MAI con dati numerici o elenchi senza averli prima recuperati con run_cypher_query.
- Vincolo tenant OBBLIGATORIO: ogni pattern MATCH deve partire da un nodo con {tenant_id: $tenantId}, es. MATCH (i:Incident {tenant_id: $tenantId})-[:AFFECTS]->(c). Le query senza questo vincolo vengono rifiutate.
- Solo letture: niente CREATE/MERGE/SET/DELETE, niente CALL di procedure, nessun parametro oltre $tenantId.
- Non includere mai UUID nelle tabelle — usa titoli e nomi leggibili
- Nelle tabelle usa solo colonne significative: Titolo, Tipo, Stato, Severity, CI, Team, Data
- Tronca testi lunghi a 40 caratteri nelle celle
- Per calcolare MTTR usa WorkflowStepExecution. Trova dinamicamente lo step iniziale (entered_at) e lo step finale via:
  MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: 'incident'})-[:HAS_STEP]->(s:WorkflowStep)
  WHERE coalesce(s.is_initial, s.type = 'start') OR s.category = 'resolved' OR coalesce(s.is_terminal, s.type = 'end')
  RETURN s.name. Poi usa questi nomi per cercare StepExecution entered_at.
- Le date sono in formato ISO string
- Puoi eseguire più query per rispondere
- Rispondi in italiano
- Usa tabelle markdown quando i dati sono tabulari
- Sii conciso e diretto, senza introduzioni verbose
- Mostra sempre i dati concreti, non generalizzare`
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
      throw new Error(`[reportAI] budget di tempo esaurito (${Math.round(elapsed / 1000)}s > ${this.limits.maxDurationMs / 1000}s)`)
    }
    if (this.outputTokens > this.limits.maxOutputTokens) {
      throw new Error(`[reportAI] budget token esaurito (${this.outputTokens} > ${this.limits.maxOutputTokens} token di output)`)
    }
  }

  beforeToolCall(): void {
    this.iterations++
    if (this.iterations > this.limits.maxIterations) {
      throw new Error(`[reportAI] superato il limite di ${this.limits.maxIterations} query per domanda`)
    }
  }

  recordRejection(reason: string): void {
    this.rejections++
    if (this.rejections > this.limits.maxRejections) {
      throw new Error(`[reportAI] la query generata dal modello è stata rifiutata ${this.rejections} volte dal guard di sicurezza — ultimo motivo: ${reason}`)
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
    return `${err.message}\nRiscrivi la query: sola lettura, ogni pattern MATCH deve includere {tenant_id: $tenantId}, unico parametro $tenantId.`
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
          : val
      })
      return obj
    })
    let toolResult = JSON.stringify(rows, null, 2)
    if (toolResult.length > 8000) toolResult = toolResult.slice(0, 8000) + '\n... (truncated)'
    return toolResult
  } catch (err: unknown) {
    const toolResult = `Errore query: ${err instanceof Error ? err.message : String(err)}`
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
  /** Conversation so far, ending with the user's question. */
  messages: Anthropic.MessageParam[]
  /** When given, text deltas and tool calls are emitted as they happen. */
  stream?: (event: ReportAgentEvent) => void
  /** Test seam; defaults to `new Anthropic()` (credentials from the environment). */
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

  const client = opts.client ?? new Anthropic()
  const system = buildSystemPrompt(await getCachedSchema(opts.tenantId))
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
      s.on('text', (delta) => emit({ type: 'text', text: delta }))
      return s.finalMessage()
    }
    return client.messages.create({ ...base, messages })
  }

  // Bounded by ToolLoopBudget (iterations, rejections, tokens, time).
  while (true) {
    budget.beforeModelCall()
    const message = await runTurn()
    budget.recordUsage(message.usage.output_tokens)

    for (const block of message.content) {
      if (block.type === 'text') fullText += block.text
    }

    if (message.stop_reason === 'refusal') {
      throw new Error(`${LOG_LABEL} il modello ha rifiutato la richiesta`)
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
