import { type Session } from 'neo4j-driver'
import { getSession } from '@opengraphity/neo4j'

// ── Schema cache ──────────────────────────────────────────────────────────

const schemaCache = new Map<string, { schema: string; expiresAt: number }>()

async function buildSchemaContext(session: Session, tenantId: string): Promise<string> {
  const [nodesResult, relsResult, countsResult] = await Promise.all([
    session.executeRead((tx) => tx.run(`
      MATCH (n)
      WHERE n.tenant_id = $tenantId
      WITH labels(n)[0] AS label, keys(n) AS props
      WITH label, [p IN props WHERE p <> 'tenant_id'] AS props
      RETURN DISTINCT label, props
      ORDER BY label
    `, { tenantId })),
    session.executeRead((tx) => tx.run(`
      MATCH (a)-[r]->(b)
      WHERE a.tenant_id = $tenantId
      RETURN DISTINCT
        labels(a)[0] AS from,
        type(r) AS rel,
        labels(b)[0] AS to
      ORDER BY from, rel
    `, { tenantId })),
    session.executeRead((tx) => tx.run(`
      MATCH (n)
      WHERE n.tenant_id = $tenantId
      RETURN labels(n)[0] AS label, count(n) AS count
      ORDER BY count DESC
    `, { tenantId })),
  ])

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

async function getCachedSchema(session: Session, tenantId: string): Promise<string> {
  const cached = schemaCache.get(tenantId)
  if (cached && cached.expiresAt > Date.now()) return cached.schema
  const schema = await buildSchemaContext(session, tenantId)
  schemaCache.set(tenantId, { schema, expiresAt: Date.now() + 5 * 60 * 1000 })
  return schema
}

// ── Tool definition ───────────────────────────────────────────────────────

const CYPHER_TOOL = {
  name: 'run_cypher_query',
  description: 'Esegue una query Cypher su Neo4j per il tenant corrente. Usa questo tool per recuperare dati su incident, change, CI, team, SLA. Il tenant_id è già filtrato automaticamente.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Query Cypher valida. Usa sempre $tenantId come parametro per filtrare per tenant. Non usare LIMIT > 100.',
      },
      description: {
        type: 'string',
        description: 'Descrizione breve di cosa stai cercando',
      },
    },
    required: ['query', 'description'],
  },
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
}

type MessageParam =
  | { role: 'user' | 'assistant'; content: string }
  | { role: 'user'; content: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> }
  | { role: 'assistant'; content: AnthropicContentBlock[] }

// ── Main function ─────────────────────────────────────────────────────────

export async function callReportAI(
  session: Session,
  tenantId: string,
  history: { role: string; content: string }[],
  question: string,
): Promise<string> {
  const apiKey = process.env['ANTHROPIC_API_KEY']
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')

  const schemaContext = await getCachedSchema(session, tenantId)

  const SYSTEM_PROMPT = `Sei un assistente di analisi ITSM per OpenGraphity.
Hai accesso a un grafo Neo4j tramite il tool run_cypher_query.

${schemaContext}

REGOLE:
- Filtra SEMPRE per tenant_id: $tenantId
- Non includere mai UUID nelle tabelle — usa titoli e nomi leggibili
- Nelle tabelle usa solo colonne significative: Titolo, Tipo, Stato, Severity, CI, Team, Data
- Tronca testi lunghi a 40 caratteri nelle celle
- Per calcolare MTTR usa WorkflowStepExecution dove step_name='new' (entered_at) e step_name='resolved' (entered_at)
- Le date sono in formato ISO string
- Puoi eseguire più query per rispondere
- Rispondi in italiano
- Usa tabelle markdown quando i dati sono tabulari
- Sii conciso e diretto, senza introduzioni verbose
- Mostra sempre i dati concreti, non generalizzare`

  const messages: MessageParam[] = [
    ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: question },
  ]

  const callAPI = async (msgs: MessageParam[]): Promise<AnthropicResponse> => {
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
    return res.json() as Promise<AnthropicResponse>
  }

  let response = await callAPI(messages)

  // Agentic loop
  while (response.stop_reason === 'tool_use') {
    const toolUse = response.content.find((b) => b.type === 'tool_use')
    if (!toolUse?.id || !toolUse.input) break

    console.log(`[reportAI] tool_use: ${toolUse.input.description}`)

    let toolResult: string
    const toolSession = getSession(undefined, 'READ')
    try {
      const result = await toolSession.executeRead((tx) =>
        tx.run(toolUse.input!.query, { tenantId }),
      )
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
      toolResult = JSON.stringify(rows, null, 2)
      if (toolResult.length > 8000) toolResult = toolResult.slice(0, 8000) + '\n... (truncated)'
    } catch (err: unknown) {
      toolResult = `Errore query: ${err instanceof Error ? err.message : String(err)}`
      console.warn('[reportAI] Cypher error:', toolResult)
    } finally {
      await toolSession.close()
    }

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
