/**
 * assistantService.streamAssistantChat — @anthropic-ai/sdk mockato (toolRunner
 * finto), Neo4j ed embedder mockati. Pinna:
 *  - ANTHROPIC_API_KEY assente → errore esplicito PRIMA di istanziare l'SDK;
 *  - i tool passati al runner sono tenant-scoped: ogni Cypher porta il
 *    tenantId del contesto, mai un tenant preso dall'input del modello;
 *  - clamp di `limit` (max reali 15/20/50/25, default 5/8/15/10, trunc);
 *    NaN/negativi NON sono clampati → it.fails (BUG);
 *  - tool_use → emit.tool, il tool viene eseguito e il risultato torna al
 *    runner; testo → emit.text/emit.done; refusal/errore → emit.error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type ToolLike = { name: string; run: (input: unknown) => Promise<string> }
type RunnerParams = { tools: ToolLike[]; messages: unknown[]; model: string; stream: boolean; max_iterations: number; system: unknown }

const h = vi.hoisted(() => {
  const cfg = { anthropicApiKey: undefined as string | undefined }
  const toolRunner = vi.fn<(p: RunnerParams) => AsyncIterable<unknown>>()
  const constructed: unknown[] = []
  const session = { close: vi.fn().mockResolvedValue(undefined) }
  return { cfg, toolRunner, constructed, session }
})

vi.mock('../../lib/config.js', () => ({ config: h.cfg }))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    beta = { messages: { toolRunner: h.toolRunner } }
    constructor(opts?: unknown) { h.constructed.push(opts ?? null) }
  },
}))
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => h.session),
  runQuery:   vi.fn().mockResolvedValue([]),
}))
vi.mock('../embeddings.js', () => ({
  getEmbedder:     vi.fn(() => ({ embed: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])) })),
  vectorIndexName: vi.fn((label: string) => `${label.toLowerCase()}_embedding_test`),
}))
vi.mock('../../lib/logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { streamAssistantChat } = await import('../assistantService.js')
const { runQuery, getSession } = await import('@opengraphity/neo4j')
import { config } from '../../lib/config.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const TENANT = 'tenant-A'

function emitter() {
  return { text: vi.fn(), tool: vi.fn(), done: vi.fn(), error: vi.fn() }
}

/** Stream finto di un singolo messaggio: eventi + finalMessage(). */
function messageStream(events: unknown[], final: { stop_reason: string } = { stop_reason: 'end_turn' }) {
  return {
    async *[Symbol.asyncIterator]() { for (const e of events) yield e },
    finalMessage: async () => final,
  }
}
const textDelta = (text: string) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text } })
const toolStart = (name: string) => ({ type: 'content_block_start', content_block: { type: 'tool_use', name } })

/** Runner che emette gli stream dati, nell'ordine. */
function runnerOf(...streams: ReturnType<typeof messageStream>[]) {
  h.toolRunner.mockImplementation(() => ({
    async *[Symbol.asyncIterator]() { for (const s of streams) yield s },
  }))
}

/** Costruisce i tool del tenant catturandoli dal runner (buildTools non è esportata). */
async function toolsFor(tenantId: string): Promise<Map<string, ToolLike>> {
  runnerOf(messageStream([]))
  await streamAssistantChat(tenantId, [{ role: 'user', content: 'ciao' }], emitter())
  const params = h.toolRunner.mock.calls.at(-1)![0]
  return new Map(params.tools.map(t => [t.name, t]))
}

const queries = () => vi.mocked(runQuery).mock.calls.map(c => ({ cypher: c[1] as string, params: c[2] as Record<string, unknown> }))
const limitOf = (cypher: string): string => /LIMIT (\S+)/.exec(cypher)?.[1] ?? /tutti\[\.\.(\S+?)\]/.exec(cypher)?.[1] ?? 'NONE'

beforeEach(() => {
  vi.clearAllMocks()
  h.constructed.length = 0
  h.cfg.anthropicApiKey = 'sk-test'
  vi.mocked(runQuery).mockResolvedValue([])
})

// ── Configurazione ────────────────────────────────────────────────────────────

describe('streamAssistantChat — configurazione', () => {
  it('ANTHROPIC_API_KEY assente → emit.error esplicito senza istanziare l\'SDK né chiamare il runner', async () => {
    h.cfg.anthropicApiKey = undefined
    const emit = emitter()
    await streamAssistantChat(TENANT, [{ role: 'user', content: 'ciao' }], emit)
    expect(emit.error).toHaveBeenCalledWith('Assistente AI non configurato: ANTHROPIC_API_KEY mancante')
    expect(emit.done).not.toHaveBeenCalled()
    expect(h.constructed).toHaveLength(0)
    expect(h.toolRunner).not.toHaveBeenCalled()
  })

  it('con la chiave: runner con modello, 7 tool di sola lettura, messaggi mappati, stream e max_iterations', async () => {
    runnerOf(messageStream([]))
    const messages = [{ role: 'user' as const, content: 'q1' }, { role: 'assistant' as const, content: 'a1' }, { role: 'user' as const, content: 'q2' }]
    await streamAssistantChat(TENANT, messages, emitter())
    expect(h.constructed).toHaveLength(1)
    const params = h.toolRunner.mock.calls[0]![0]
    expect(params).toMatchObject({ model: config.anthropicModel, stream: true, max_iterations: 8, messages })
    expect(params.tools.map(t => t.name)).toEqual([
      'cerca_incident', 'dettaglio_incident', 'lista_incident', 'cerca_ci', 'analisi_impatto', 'change_aperti', 'cerca_kb',
    ])
    expect(params.system).toEqual([expect.objectContaining({ type: 'text', cache_control: { type: 'ephemeral' } })])
  })
})

// ── Streaming ─────────────────────────────────────────────────────────────────

describe('streamAssistantChat — streaming', () => {
  it('inoltra i delta di testo e chiude con done(testo completo)', async () => {
    runnerOf(messageStream([textDelta('Ciao '), { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } }, textDelta('mondo')]))
    const emit = emitter()
    await streamAssistantChat(TENANT, [{ role: 'user', content: 'ciao' }], emit)
    expect(emit.text.mock.calls.map(c => c[0])).toEqual(['Ciao ', 'mondo'])
    expect(emit.done).toHaveBeenCalledWith('Ciao mondo')
    expect(emit.error).not.toHaveBeenCalled()
  })

  it('tool_use → emit.tool(nome); il tool eseguito dal runner interroga il tenant del contesto e il risultato torna al modello', async () => {
    vi.mocked(runQuery).mockResolvedValue([{ totale: { low: 2, high: 0 }, incident: [{ numero: 'INC00000001' }, { numero: 'INC00000002' }] }])
    let toolResult: string | undefined
    h.toolRunner.mockImplementation((params) => ({
      async *[Symbol.asyncIterator]() {
        yield messageStream([toolStart('lista_incident')], { stop_reason: 'tool_use' })
        // come farebbe l'SDK: esegue il tool con l'input del modello e rimanda il risultato
        const tool = params.tools.find(t => t.name === 'lista_incident')!
        toolResult = await tool.run({ solo_aperti: true, tenantId: 'tenant-EVIL' })
        yield messageStream([textDelta(`Hai ${JSON.parse(toolResult).totale} incident aperti`)])
      },
    }))
    const emit = emitter()
    await streamAssistantChat(TENANT, [{ role: 'user', content: 'quanti incident aperti?' }], emit)

    expect(emit.tool).toHaveBeenCalledWith('lista_incident')
    expect(JSON.parse(toolResult!)).toEqual({ totale: 2, elencati: 2, incident: [{ numero: 'INC00000001' }, { numero: 'INC00000002' }] })
    expect(queries()[0]!.params).toMatchObject({ tenantId: TENANT, soloAperti: true })
    expect(emit.done).toHaveBeenCalledWith('Hai 2 incident aperti')
    expect(emit.error).not.toHaveBeenCalled()
  })

  it('refusal → emit.error, nessun done', async () => {
    runnerOf(messageStream([textDelta('parziale')], { stop_reason: 'refusal' }))
    const emit = emitter()
    await streamAssistantChat(TENANT, [{ role: 'user', content: 'x' }], emit)
    expect(emit.error).toHaveBeenCalledWith('Il modello ha rifiutato la richiesta')
    expect(emit.done).not.toHaveBeenCalled()
  })

  it('errore del provider → emit.error col messaggio, mai inghiottito', async () => {
    h.toolRunner.mockImplementation(() => ({
      // eslint-disable-next-line require-yield -- il provider fallisce prima di produrre qualsiasi chunk: è il caso in prova
      async *[Symbol.asyncIterator]() { throw new Error('overloaded_error') },
    }))
    const emit = emitter()
    await streamAssistantChat(TENANT, [{ role: 'user', content: 'x' }], emit)
    expect(emit.error).toHaveBeenCalledWith('overloaded_error')
    expect(emit.done).not.toHaveBeenCalled()
  })
})

// ── Tool: tenant scoping ──────────────────────────────────────────────────────

describe('tool dell\'assistente — tenant scoping e sola lettura', () => {
  const INPUTS: Record<string, unknown> = {
    cerca_incident:     { query: 'vpn', tenantId: 'tenant-EVIL', tenant_id: 'tenant-EVIL' },
    dettaglio_incident: { numero_o_id: 'INC00000001', tenantId: 'tenant-EVIL' },
    lista_incident:     { stato: 'new', severity: 'high', categoria: 'net', tenantId: 'tenant-EVIL' },
    cerca_ci:           { query: 'db', tenantId: 'tenant-EVIL' },
    analisi_impatto:    { ci_id_o_nome: 'db-01', tenantId: 'tenant-EVIL' },
    change_aperti:      { tenantId: 'tenant-EVIL' },
    cerca_kb:           { query: 'reset password', tenantId: 'tenant-EVIL' },
  }

  it('ogni tool esegue Cypher con il tenantId del contesto, filtra per tenant_id e ignora il tenant nell\'input del modello', async () => {
    const tools = await toolsFor(TENANT)
    expect([...tools.keys()].sort()).toEqual(Object.keys(INPUTS).sort())
    for (const [name, tool] of tools) {
      vi.mocked(runQuery).mockClear()
      await tool.run(INPUTS[name])
      const qs = queries()
      expect(qs.length, name).toBeGreaterThan(0)
      for (const { cypher, params } of qs) {
        expect(params['tenantId'], name).toBe(TENANT)
        expect(cypher, name).toMatch(/tenant_id(: \$tenantId| = \$tenantId)/)
        expect(JSON.stringify(params), name).not.toContain('tenant-EVIL')
        expect(cypher, name).not.toMatch(/\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE)\b/)
      }
    }
  })

  it('apre una sessione READ e la chiude anche se la query fallisce', async () => {
    const tools = await toolsFor(TENANT)
    vi.mocked(getSession).mockClear(); h.session.close.mockClear()
    await tools.get('change_aperti')!.run({})
    expect(getSession).toHaveBeenCalledWith(undefined, 'READ')
    expect(h.session.close).toHaveBeenCalledTimes(1)

    vi.mocked(runQuery).mockRejectedValueOnce(new Error('neo4j down'))
    h.session.close.mockClear()
    await expect(tools.get('change_aperti')!.run({})).rejects.toThrow('neo4j down')
    expect(h.session.close).toHaveBeenCalledTimes(1)
  })

  it('normalizza gli Integer neo4j ({low, high}) nel JSON restituito al modello', async () => {
    const tools = await toolsFor(TENANT)
    vi.mocked(runQuery).mockResolvedValue([{ numero: 'INC1', similarita: 0.9, conteggio: { low: 7, high: 0 }, altro: { low: 1, high: 0, x: 1 } }])
    expect(JSON.parse(await tools.get('cerca_incident')!.run({ query: 'x' })))
      .toEqual([{ numero: 'INC1', similarita: 0.9, conteggio: 7, altro: { low: 1, high: 0, x: 1 } }])
  })

  it('dettaglio_incident / analisi_impatto: nessuna riga → JSON con "errore" esplicito, non un vuoto', async () => {
    const tools = await toolsFor(TENANT)
    expect(JSON.parse(await tools.get('dettaglio_incident')!.run({ numero_o_id: 'INC00000099' })))
      .toEqual({ errore: 'Incident INC00000099 non trovato' })
    expect(JSON.parse(await tools.get('analisi_impatto')!.run({ ci_id_o_nome: 'ghost' })))
      .toEqual({ errore: 'CI "ghost" non trovato — prova cerca_ci per il nome esatto' })
  })

  it('lista_incident: filtri assenti → null (query neutra), solo_aperti → soloAperti boolean; conteggio esatto anche con elenco troncato', async () => {
    const tools = await toolsFor(TENANT)
    await tools.get('lista_incident')!.run({})
    expect(queries()[0]!.params).toEqual({ tenantId: TENANT, stato: null, severity: null, categoria: null, soloAperti: false })

    vi.mocked(runQuery).mockResolvedValue([{ totale: 120, incident: [{ numero: 'a' }] }])
    expect(JSON.parse(await tools.get('lista_incident')!.run({ solo_aperti: true, limit: 1 })))
      .toEqual({ totale: 120, elencati: 1, incident: [{ numero: 'a' }] })
    expect(JSON.parse(await tools.get('lista_incident')!.run({}))).toMatchObject({ totale: 120 })
  })
})

// ── Tool: clamp di limit ──────────────────────────────────────────────────────

describe('tool dell\'assistente — clamp di limit', () => {
  const CASES: Array<[tool: string, input: Record<string, unknown>, def: string, max: string]> = [
    ['cerca_incident', { query: 'x' }, '5',  '15'],
    ['cerca_ci',       { query: 'x' }, '8',  '20'],
    ['lista_incident', {},             '15', '50'],
    ['change_aperti',  {},             '10', '25'],
  ]

  it.each(CASES)('%s: default %s, massimo %s, valori enormi/decimali troncati', async (name, input, def, max) => {
    const tools = await toolsFor(TENANT)
    const run = async (extra: Record<string, unknown>) => {
      vi.mocked(runQuery).mockClear()
      await tools.get(name)!.run({ ...input, ...extra })
      return limitOf(queries()[0]!.cypher)
    }
    expect(await run({})).toBe(def)
    expect(await run({ limit: 999_999 })).toBe(max)
    expect(await run({ limit: Number.MAX_SAFE_INTEGER })).toBe(max)
    expect(await run({ limit: 2.9 })).toBe('2')
    expect(await run({ limit: 1 })).toBe('1')
  })

  it('cerca_kb ha LIMIT fisso 5 (nessun limit nell\'input)', async () => {
    const tools = await toolsFor(TENANT)
    vi.mocked(runQuery).mockClear()
    await tools.get('cerca_kb')!.run({ query: 'x', limit: 999 })
    expect(limitOf(queries()[0]!.cypher)).toBe('5')
  })

  it('limit negativo → clampato a un minimo ≥ 1 — BUG: assistantService.ts:66/115/174/216 usano solo Math.min (LIMIT -3 → Cypher invalido)', async () => {
    const tools = await toolsFor(TENANT)
    for (const [name, input] of CASES) {
      vi.mocked(runQuery).mockClear()
      await tools.get(name)!.run({ ...input, limit: -3 })
      expect(Number(limitOf(queries()[0]!.cypher)), name).toBeGreaterThanOrEqual(1)
    }
  })

  it('limit NaN → default — BUG: assistantService.ts:66/115/174/216 (Math.min(NaN, max) = NaN → "LIMIT NaN")', async () => {
    const tools = await toolsFor(TENANT)
    for (const [name, input, def] of CASES) {
      vi.mocked(runQuery).mockClear()
      await tools.get(name)!.run({ ...input, limit: Number.NaN })
      expect(limitOf(queries()[0]!.cypher), name).toBe(def)
    }
  })
})
