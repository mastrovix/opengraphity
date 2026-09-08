import { getSession } from '@opengraphity/neo4j'
import { logger } from '../lib/logger.js'
import { assertSafeReadOnlyCypher, UnsafeCypherError } from '../lib/cypherGuard.js'

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

// ── Tool definition ───────────────────────────────────────────────────────

const CYPHER_TOOL = {
  name: 'run_cypher_query',
  description:
    'Esegue una query Cypher di SOLA LETTURA su Neo4j per recuperare dati su incident, change, CI, team, SLA. ' +
    'Il tenant NON è filtrato automaticamente: ogni pattern di nodo da cui parte un MATCH DEVE includere ' +
    '{tenant_id: $tenantId} (i nodi raggiunti tramite relazione da un nodo così vincolato sono ammessi). ' +
    'Sono rifiutate: clausole di scrittura (CREATE/MERGE/SET/DELETE/REMOVE), CALL di procedure (eccetto apoc.text/coll/map/date), ' +
    'parametri diversi da $tenantId, backtick e più istruzioni. Una query rifiutata restituisce il motivo: correggila e riprova.',
  input_schema: {
    type: 'object' as const,
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

function buildSystemPrompt(schemaContext: string): string {
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

// ── Types ─────────────────────────────────────────────────────────────────

interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: { query: string; description: string }
}

interface AnthropicResponse {
  stop_reason: string
  content: AnthropicContentBlock[]
  usage?: { input_tokens?: number; output_tokens?: number }
}

type MessageParam =
  | { role: 'user' | 'assistant'; content: string }
  | { role: 'user'; content: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> }
  | { role: 'assistant'; content: AnthropicContentBlock[] }

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
 * fails. Neo4j errors are likewise returned to the model. Shared by both loops.
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

// ── Main function ─────────────────────────────────────────────────────────

export async function streamReportAI(
  tenantId: string,
  history: { role: string; content: string }[],
  question: string,
  onChunk: (text: string) => void,
  onToolUse: (description: string) => void,
): Promise<string> {
  const apiKey = process.env['ANTHROPIC_API_KEY']
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')

  const schemaContext = await getCachedSchema(tenantId)
  const SYSTEM_PROMPT = buildSystemPrompt(schemaContext)

  const messages: MessageParam[] = [
    ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: question },
  ]

  let fullText = ''
  const budget = new ToolLoopBudget()

  const runStreamingTurn = async (msgs: MessageParam[]): Promise<'end_turn' | 'tool_use'> => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 4096,
        stream: true,
        system: SYSTEM_PROMPT,
        tools: [CYPHER_TOOL],
        tool_choice: { type: 'auto' },
        messages: msgs,
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Anthropic API error ${res.status}: ${err}`)
    }

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    // Track current tool_use block
    let currentToolId: string | null = null
    let currentToolName: string | null = null
    let currentToolInputJson = ''
    const assistantContent: AnthropicContentBlock[] = []
    let currentTextBlock: AnthropicContentBlock | null = null
    let stopReason = 'end_turn'

    const processLine = (line: string) => {
      if (!line.startsWith('data: ')) return
      const data = line.slice(6)
      if (data === '[DONE]') return
      // Only the frame PARSE is defensive (a malformed provider frame is
      // logged and skipped). Errors in our own handling below propagate —
      // swallowing them silently truncated the AI output with no trace.
      let event: {
        type: string
        delta?: { type: string; text?: string; partial_json?: string }
        content_block?: { type: string; id?: string; name?: string }
        message?: { stop_reason: string }
        usage?: { output_tokens?: number }
        index?: number
      }
      try {
        event = JSON.parse(data) as typeof event
      } catch (err) {
        logger.error({ err, line: data.slice(0, 200) }, '[reportAI] malformed SSE frame from provider — skipped')
        return
      }
      {

        if (event.type === 'message_delta' && event.delta) {
          if ('stop_reason' in event.delta) {
            stopReason = (event.delta as unknown as { stop_reason: string }).stop_reason
          }
          budget.recordUsage(event.usage?.output_tokens)
        }

        if (event.type === 'content_block_start' && event.content_block) {
          if (event.content_block.type === 'text') {
            currentTextBlock = { type: 'text', text: '' }
            assistantContent.push(currentTextBlock)
          } else if (event.content_block.type === 'tool_use') {
            currentToolId = event.content_block.id ?? null
            currentToolName = event.content_block.name ?? null
            currentToolInputJson = ''
            currentTextBlock = null
            assistantContent.push({
              type: 'tool_use',
              id: currentToolId ?? undefined,
              name: currentToolName ?? undefined,
              input: undefined,
            })
          }
        }

        if (event.type === 'content_block_delta' && event.delta) {
          if (event.delta.type === 'text_delta' && event.delta.text) {
            const chunk = event.delta.text
            fullText += chunk
            onChunk(chunk)
            if (currentTextBlock) currentTextBlock.text = (currentTextBlock.text ?? '') + chunk
          } else if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
            currentToolInputJson += event.delta.partial_json
          }
        }

        if (event.type === 'content_block_stop') {
          if (currentToolId) {
            let parsed: { query: string; description: string }
            try {
              parsed = JSON.parse(currentToolInputJson) as { query: string; description: string }
            } catch (err) {
              // Corrupt tool input must fail the turn — executing the tool
              // with undefined input would produce a wrong-but-plausible answer.
              throw new Error(`[reportAI] corrupt tool input JSON from model: ${err instanceof Error ? err.message : String(err)}`)
            }
            const last = assistantContent[assistantContent.length - 1]
            if (last?.type === 'tool_use') last.input = parsed
            currentToolId = null
            currentToolName = null
            currentToolInputJson = ''
          }
        }
      }
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        processLine(line.trim())
      }
    }
    if (buffer.trim()) processLine(buffer.trim())

    msgs.push({ role: 'assistant', content: assistantContent })
    return stopReason === 'tool_use' ? 'tool_use' : 'end_turn'
  }

  // Agentic loop — bounded by ToolLoopBudget (iterations, rejections, tokens, time)
  budget.beforeModelCall()
  let reason = await runStreamingTurn(messages)

  while (reason === 'tool_use') {
    const lastAsst = messages[messages.length - 1] as { role: 'assistant'; content: AnthropicContentBlock[] }
    const toolUse = lastAsst.content.find((b) => b.type === 'tool_use')
    if (!toolUse?.id || !toolUse.input) break

    budget.beforeToolCall()
    onToolUse(toolUse.input.description)

    const toolResult = await runGuardedCypherTool(toolUse.input.query, tenantId, budget, 'streamReportAI')

    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: toolResult }],
    })

    budget.beforeModelCall()
    reason = await runStreamingTurn(messages)
  }

  return fullText
}

export async function callReportAI(
  tenantId: string,
  history: { role: string; content: string }[],
  question: string,
): Promise<string> {
  const apiKey = process.env['ANTHROPIC_API_KEY']
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')

  const schemaContext = await getCachedSchema(tenantId)
  const SYSTEM_PROMPT = buildSystemPrompt(schemaContext)

  const messages: MessageParam[] = [
    ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: question },
  ]

  const budget = new ToolLoopBudget()

  const callAPI = async (msgs: MessageParam[]): Promise<AnthropicResponse> => {
    budget.beforeModelCall()
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: [CYPHER_TOOL],
        messages: msgs,
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Anthropic API error ${res.status}: ${err}`)
    }
    const json = await res.json() as AnthropicResponse
    budget.recordUsage(json.usage?.output_tokens)
    return json
  }

  let response = await callAPI(messages)

  // Agentic loop — bounded by ToolLoopBudget (iterations, rejections, tokens, time)
  while (response.stop_reason === 'tool_use') {
    const toolUse = response.content.find((b) => b.type === 'tool_use')
    if (!toolUse?.id || !toolUse.input) break

    budget.beforeToolCall()
    const toolResult = await runGuardedCypherTool(toolUse.input.query, tenantId, budget, 'reportAI')

    messages.push(
      { role: 'assistant', content: response.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: toolResult }] },
    )

    response = await callAPI(messages)
  }

  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')
}
