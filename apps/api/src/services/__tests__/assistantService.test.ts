/**
 * assistantService.streamAssistantChat — @anthropic-ai/sdk mockato (toolRunner
 * finto), Neo4j ed embedder mockati. Pinna:
 *  - ANTHROPIC_API_KEY assente → errore esplicito PRIMA di istanziare l'SDK;
 *  - i tool passati al runner sono tenant-scoped: ogni Cypher porta il
 *    tenantId del contesto, mai un tenant preso dall'input del modello;
 *  - clamp di `limit` (max reali 15/20/50/25, default 5/8/15/10, trunc);
 *    NaN e negativi tornano al default e al minimo (erano «LIMIT NaN» e
 *    «LIMIT -3», Cypher invalido: corretto);
 *  - tool_use → emit.tool, il tool viene eseguito e il risultato torna al
 *    runner; testo → emit.text/emit.done; refusal/errore → emit.error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { perms } from '../../lib/__tests__/testPermissions.js'

// ── Ondata 6 (A-9): le etichette dei CI vengono dal metamodello del tenant ────
// `LoadBalancer` è un tipo creato dal cliente: deve comparire nei predicati.
// Prima questi punti usavano la lista fissa di `lib/ciLabels.ts` e i CI di quel
// tipo non contavano, in silenzio.
// Ondata 6 di «Nulla cablato»: le funzioni AI sono dell'organizzazione; qui tutte accese.
vi.mock('../../lib/aiSettings.js', () => import('../../lib/__tests__/aiSettingsFake.js'))
// The assistant is told the language of the person's interface (D62).
vi.mock('../../lib/tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'en'), languageForUser: vi.fn(async () => 'en') }))
// D14: the tools give times as wall-clock time in the organization's zone.
vi.mock('../../lib/tenantTimezone.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/tenantTimezone.js')>(),
  tenantTimezone: vi.fn(async () => 'Europe/Rome'),
}))
vi.mock('../../lib/ciLabelsForTenant.js', () => ({
  ciLabelsForTenant:         vi.fn(async () => ['Application', 'LoadBalancer', 'Server']),
  ciLabelPredicateForTenant: vi.fn(async (alias: string) => `(${alias}:Application OR ${alias}:LoadBalancer OR ${alias}:Server)`),
  apocLabelFilterForTenant:  vi.fn(async () => '+Application|+LoadBalancer|+Server'),
  ciTypeNameForLabel:        vi.fn(async (_t: string, label: string) => (label === 'LoadBalancer' ? 'load_balancer' : null)),
  clearCILabelCache:         vi.fn(),
}))

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
  toNumber:   (v: unknown) => (typeof v === 'object' && v !== null && 'low' in v ? (v as { low: number }).low : Number(v)),
}))
vi.mock('../embeddings.js', () => ({
  getEmbedder:     vi.fn(() => ({ embed: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])) })),
  vectorIndexName: vi.fn((label: string) => `${label.toLowerCase()}_embedding_test`),
}))
// ── Ondata 8 (B-22): «aperto» e «concluso» vengono dai passi del workflow ────
// I passi hanno nomi del CLIENTE (`sistemato`, `archiviato`, `archiviata`): il
// servizio non deve conoscere `resolved`/`closed`/`completed`, deve chiedere.
// Il modulo è mockato per non aprire una seconda sessione Neo4j nei tool (la
// derivazione vera è provata in workflowHelpers/statusStepNames).
vi.mock('../../lib/statusStepNames.js', () => ({
  concludedStatusNames: vi.fn(async (_t: string, entityType: string) =>
    entityType === 'change' ? ['archiviata'] : ['sistemato', 'archiviato']),
  statusNamesForClasses: vi.fn(async () => ['archiviato']),
}))
vi.mock('../../lib/logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { streamAssistantChat } = await import('../assistantService.js')
const { runQuery, getSession } = await import('@opengraphity/neo4j')
const { tenantTimezone } = await import('../../lib/tenantTimezone.js')
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
async function toolsFor(tenantId: string, permissions: ReadonlySet<string> = perms('operator')): Promise<Map<string, ToolLike>> {
  runnerOf(messageStream([]))
  await streamAssistantChat(tenantId, 'user-1', permissions as never, [{ role: 'user', content: 'ciao' }], emitter())
  const params = h.toolRunner.mock.calls.at(-1)![0]
  return new Map(params.tools.map(t => [t.name, t]))
}

const queries = () => vi.mocked(runQuery).mock.calls.map(c => ({ cypher: c[1] as string, params: c[2] as Record<string, unknown> }))
/**
 * Il limite della query: un letterale nel Cypher, oppure il parametro
 * `vectorLimit` per le ricerche vettoriali, che dalla revisione totale (B-12)
 * passano da `lib/vectorSearch.ts` e mandano il limite come parametro.
 */
const limitOf = (q: { cypher: string; params: Record<string, unknown> }): string =>
  q.params['vectorLimit'] !== undefined ? String(q.params['vectorLimit'])
  : /LIMIT (\S+)/.exec(q.cypher)?.[1] ?? /tutti\[\.\.(\S+?)\]/.exec(q.cypher)?.[1] ?? 'NONE'
/** The query that lists: change_aperti first counts per step (no limit), then lists. */
const listingQuery = () => queries().find((q) => limitOf(q) !== 'NONE') ?? queries()[0]!

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
    await streamAssistantChat(TENANT, 'user-1', perms('operator'), [{ role: 'user', content: 'ciao' }], emit)
    expect(emit.error).toHaveBeenCalledWith('AI assistant not configured: ANTHROPIC_API_KEY is missing')
    expect(emit.done).not.toHaveBeenCalled()
    expect(h.constructed).toHaveLength(0)
    expect(h.toolRunner).not.toHaveBeenCalled()
  })

  it('con la chiave: runner con modello, 7 tool di sola lettura, messaggi mappati, stream e max_iterations', async () => {
    runnerOf(messageStream([]))
    const messages = [{ role: 'user' as const, content: 'q1' }, { role: 'assistant' as const, content: 'a1' }, { role: 'user' as const, content: 'q2' }]
    await streamAssistantChat(TENANT, 'user-1', perms('operator'), messages, emitter())
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
    await streamAssistantChat(TENANT, 'user-1', perms('operator'), [{ role: 'user', content: 'ciao' }], emit)
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
    await streamAssistantChat(TENANT, 'user-1', perms('operator'), [{ role: 'user', content: 'quanti incident aperti?' }], emit)

    expect(emit.tool).toHaveBeenCalledWith('lista_incident')
    expect(JSON.parse(toolResult!)).toEqual({ totale: 2, elencati: 2, incident: [{ numero: 'INC00000001', creato: null }, { numero: 'INC00000002', creato: null }] })
    expect(queries()[0]!.params).toMatchObject({ tenantId: TENANT, soloAperti: true })
    expect(emit.done).toHaveBeenCalledWith('Hai 2 incident aperti')
    expect(emit.error).not.toHaveBeenCalled()
  })

  // D62 (tour of 23 Sep 2026): an English interface got answers in Italian.
  it("the system prompt is in English and names the language of the person's interface", async () => {
    await toolsFor(TENANT)
    const system = h.toolRunner.mock.calls.at(-1)![0].system as Array<{ text: string }>
    const text = system[0]!.text
    expect(text).toContain('Write every sentence in English')
    expect(text).not.toMatch(/Rispondi|lingua/)
    // D14: the times the tools return are local, and the model is told so.
    expect(text).toContain("local time in the organization's time zone, Europe/Rome")
  })

  it('an organization without a time zone gets an explicit error, and the model is not called', async () => {
    vi.mocked(tenantTimezone).mockResolvedValueOnce(null)
    const emit = emitter()
    await streamAssistantChat(TENANT, 'user-1', perms('operator'), [{ role: 'user', content: 'x' }], emit)
    expect(emit.error).toHaveBeenCalledWith(expect.stringContaining('The organization has no time zone'))
    expect(h.toolRunner).not.toHaveBeenCalled()
  })

  it('refusal → emit.error, nessun done', async () => {
    runnerOf(messageStream([textDelta('parziale')], { stop_reason: 'refusal' }))
    const emit = emitter()
    await streamAssistantChat(TENANT, 'user-1', perms('operator'), [{ role: 'user', content: 'x' }], emit)
    expect(emit.error).toHaveBeenCalledWith('The model refused the request')
    expect(emit.done).not.toHaveBeenCalled()
  })

  it('errore del provider → emit.error col messaggio, mai inghiottito', async () => {
    h.toolRunner.mockImplementation(() => ({
      // eslint-disable-next-line require-yield -- il provider fallisce prima di produrre qualsiasi chunk: è il caso in prova
      async *[Symbol.asyncIterator]() { throw new Error('overloaded_error') },
    }))
    const emit = emitter()
    await streamAssistantChat(TENANT, 'user-1', perms('operator'), [{ role: 'user', content: 'x' }], emit)
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

  // A-9: i tool sui CI chiedono le etichette al metamodello del tenant — prima
  // usavano la lista fissa e l'assistente rispondeva «non trovato» per i CI dei
  // tipi creati dal cliente.
  it('cerca_ci / analisi_impatto passano le etichette del TENANT, compreso un suo tipo', async () => {
    const tools = await toolsFor(TENANT)
    for (const name of ['cerca_ci', 'analisi_impatto']) {
      vi.mocked(runQuery).mockClear()
      await tools.get(name)!.run(INPUTS[name])
      expect(queries()[0]!.params['labels'], name).toEqual(['Application', 'LoadBalancer', 'Server'])
    }
  })

  // B-22: incident aperti e change in corso dentro analisi_impatto e
  // change_aperti si riconoscono dai passi del workflow del cliente. Prima le
  // liste erano scritte a mano e contenevano valori che nessun workflow produce
  // (`completed`, `cancelled`), quindi una change ferma in un passo terminale
  // aggiunto dal cliente risultava «in corso».
  it('analisi_impatto e change_aperti escludono i passi conclusivi del workflow del cliente', async () => {
    const tools = await toolsFor(TENANT)
    vi.mocked(runQuery).mockClear()
    await tools.get('analisi_impatto')!.run({ ci_id_o_nome: 'db-01' })
    expect(queries()[0]!.params).toMatchObject({
      incidentConcluded: ['sistemato', 'archiviato'],
      changeConcluded:   ['archiviata'],
    })

    vi.mocked(runQuery).mockClear()
    await tools.get('change_aperti')!.run({})
    expect(queries()[0]!.params['concluded']).toEqual(['archiviata'])
    expect(queries()[1]!.params['concluded']).toEqual(['archiviata'])
  })

  // D73 (tour of 23 Sep 2026): the tool gave the first page and the model took it for the whole.
  it('change_aperti gives the exact total and the count per step, and says when its list is partial', async () => {
    const tools = await toolsFor(TENANT)
    vi.mocked(runQuery).mockReset()
    vi.mocked(runQuery)
      .mockResolvedValueOnce([{ passo: 'approval', n: { low: 166, high: 0 } }, { passo: 'deployment', n: 44 }])
      .mockResolvedValueOnce([{ numero: 'CHG1', stato: 'approval' }, { numero: 'CHG2', stato: 'deployment' }])
    const out = JSON.parse(await tools.get('change_aperti')!.run({ limit: 2 })) as Record<string, unknown>
    expect(out).toEqual({
      totale: 210,
      per_passo: [{ passo: 'approval', n: 166 }, { passo: 'deployment', n: 44 }],
      elencati: 2,
      elenco_parziale: true,
      change: [{ numero: 'CHG1', stato: 'approval' }, { numero: 'CHG2', stato: 'deployment' }],
    })
    // A change in its first step may have no status yet: the workflow step counts.
    expect(queries()[0]!.cypher).toContain('coalesce(ch.status, wi.current_step)')
    vi.mocked(runQuery).mockReset()
    vi.mocked(runQuery).mockResolvedValue([])
  })

  it('apre una sessione READ e la chiude anche se la query fallisce', async () => {
    const tools = await toolsFor(TENANT)
    vi.mocked(getSession).mockClear(); h.session.close.mockClear()
    await tools.get('change_aperti')!.run({})
    expect(getSession).toHaveBeenCalledWith(undefined, 'READ')
    // Two reads (the counts per step, then the list), each on its own session.
    expect(h.session.close).toHaveBeenCalledTimes(2)

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

  it('dettaglio_incident: local times, and the latest three comments in order', async () => {
    const tools = await toolsFor(TENANT)
    vi.mocked(runQuery).mockResolvedValueOnce([{ numero: 'INC1', creato: '2026-09-23T04:20:00Z', risolto: null, commenti: ['c3', 'c2', 'c1'] }])
    expect(JSON.parse(await tools.get('dettaglio_incident')!.run({ numero_o_id: 'INC1' })))
      .toEqual({ numero: 'INC1', creato: '2026-09-23 06:20', risolto: null, commenti: ['c3', 'c2', 'c1'] })
    const q = queries().at(-1)!.cypher
    expect(q).toContain('WITH i, team, cis, c ORDER BY c.created_at DESC')
    expect(q).toContain('collect(c.text)[..3] AS commenti')
  })

  it('dettaglio_incident / analisi_impatto: nessuna riga → JSON con "errore" esplicito, non un vuoto', async () => {
    const tools = await toolsFor(TENANT)
    expect(JSON.parse(await tools.get('dettaglio_incident')!.run({ numero_o_id: 'INC00000099' })))
      .toEqual({ errore: 'Incident INC00000099 not found' })
    expect(JSON.parse(await tools.get('analisi_impatto')!.run({ ci_id_o_nome: 'ghost' })))
      .toEqual({ errore: 'CI "ghost" not found: use cerca_ci to find the exact name' })
  })

  it('lista_incident: filtri assenti → null (query neutra), solo_aperti → soloAperti boolean; conteggio esatto anche con elenco troncato', async () => {
    const tools = await toolsFor(TENANT)
    await tools.get('lista_incident')!.run({})
    expect(queries()[0]!.params).toEqual({ tenantId: TENANT, stato: null, severity: null, categoria: null, soloAperti: false, concluded: [] })

    // solo_aperti → i passi CONCLUSIVI del workflow di questo cliente (nomi suoi),
    // non i letterali `['resolved','closed']`.
    vi.mocked(runQuery).mockClear()
    await tools.get('lista_incident')!.run({ solo_aperti: true })
    expect(queries()[0]!.params['concluded']).toEqual(['sistemato', 'archiviato'])
    expect(queries()[0]!.cypher).toContain('NOT i.status IN $concluded')

    vi.mocked(runQuery).mockResolvedValue([{ totale: 120, incident: [{ numero: 'a', creato: '2026-09-23T04:20:00Z' }] }])
    // D14: the opening time as wall-clock time in Europe/Rome, never raw UTC.
    expect(JSON.parse(await tools.get('lista_incident')!.run({ solo_aperti: true, limit: 1 })))
      .toEqual({ totale: 120, elencati: 1, incident: [{ numero: 'a', creato: '2026-09-23 06:20' }] })
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
      return limitOf(listingQuery())
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
    expect(limitOf(queries()[0]!)).toBe('5')
  })

  it('limit negativo → clampato a un minimo ≥ 1 (con il solo Math.min era «LIMIT -3», Cypher invalido)', async () => {
    const tools = await toolsFor(TENANT)
    for (const [name, input] of CASES) {
      vi.mocked(runQuery).mockClear()
      await tools.get(name)!.run({ ...input, limit: -3 })
      expect(Number(limitOf(listingQuery())), name).toBeGreaterThanOrEqual(1)
    }
  })

  it('limit NaN → default (Math.min(NaN, max) era NaN, cioè «LIMIT NaN»)', async () => {
    const tools = await toolsFor(TENANT)
    for (const [name, input, def] of CASES) {
      vi.mocked(runQuery).mockClear()
      await tools.get(name)!.run({ ...input, limit: Number.NaN })
      expect(limitOf(listingQuery()), name).toBe(def)
    }
  })
})

// ── Permessi del ruolo (ondata 7) ─────────────────────────────────────────────

describe('gli strumenti sono quelli dei dati che il ruolo può vedere', () => {
  it('operator: tutti gli strumenti', async () => {
    const tools = await toolsFor(TENANT, perms('operator'))
    expect([...tools.keys()].sort()).toEqual(['analisi_impatto', 'cerca_ci', 'cerca_incident', 'cerca_kb', 'change_aperti', 'dettaglio_incident', 'lista_incident'])
  })

  it('un ruolo con sola CMDB: niente incident né change, e l\'analisi d\'impatto non li nomina nemmeno come «zero»', async () => {
    const tools = await toolsFor(TENANT, new Set(['workspace.use', 'assistant.use', 'cmdb.read']))
    expect([...tools.keys()].sort()).toEqual(['analisi_impatto', 'cerca_ci'])
    vi.mocked(runQuery).mockResolvedValue([{ nome: 'db-01', tipo: 'Database', incident_aperti: [], change_in_corso: [] }])
    const out = JSON.parse(String(await tools.get('analisi_impatto')!.run({ ci_id_o_nome: 'db-01' }))) as Record<string, unknown>
    expect(out).not.toHaveProperty('incident_aperti')
    expect(out).not.toHaveProperty('change_in_corso')
    const q = queries().at(-1)!
    expect(q.params['seeIncidents']).toBe(false)
    expect(q.params['seeChanges']).toBe(false)
  })

  it('un ruolo senza permessi di lettura: nessuno strumento', async () => {
    const tools = await toolsFor(TENANT, new Set(['workspace.use', 'assistant.use']))
    expect(tools.size).toBe(0)
  })
})
