/**
 * triageService.suggestTriage — @anthropic-ai/sdk mockato (messages.create),
 * Neo4j ed embedder mockati. Pinna: bozza vuota → BAD_USER_INPUT; chiave
 * assente → FAILED_PRECONDITION senza chiamare l'SDK; enum del metamodello
 * assenti → errore; output JSON non parsabile → errore esplicito (mai un
 * triage vuoto); refusal / risposta senza testo → errore; happy path con
 * schema vincolato agli enum del tenant e query tenant-scoped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

const h = vi.hoisted(() => {
  const cfg = { anthropicApiKey: undefined as string | undefined }
  const create = vi.fn<(p: Record<string, unknown>) => Promise<unknown>>()
  const constructed: unknown[] = []
  // A-2: il triage legge anche le PERSONALIZZAZIONI del tenant
  // (`loadTenantEnumOverrides`), che passa da `session.executeRead`/`tx.run` e
  // non da `runQuery`: la sessione finta deve saperlo fare. `ownEnums` sono i
  // vocabolari propri del tenant (vuoto = nessuna personalizzazione).
  const ownEnums: Array<Record<string, unknown>> = []
  const overridesRun = vi.fn(async () => ({
    records: ownEnums.map((m) => ({ get: (k: string) => (k in m ? m[k] : null) })),
  }))
  const session = {
    close: vi.fn().mockResolvedValue(undefined),
    executeRead: (fn: (tx: { run: typeof overridesRun }) => unknown) => fn({ run: overridesRun }),
  }
  const embed = vi.fn<(texts: string[]) => Promise<number[][]>>()
  return { cfg, create, constructed, session, embed, ownEnums, overridesRun }
})

vi.mock('../../lib/config.js', () => ({ config: h.cfg }))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: h.create }
    constructor(opts?: unknown) { h.constructed.push(opts ?? null) }
  },
}))
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => h.session),
  runQuery:   vi.fn(),
}))
vi.mock('../embeddings.js', () => ({
  getEmbedder:     vi.fn(() => ({ embed: h.embed })),
  vectorIndexName: vi.fn((label: string) => `${label.toLowerCase()}_embedding_test`),
}))
vi.mock('../../lib/logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { suggestTriage } = await import('../triageService.js')
const { runQuery } = await import('@opengraphity/neo4j')
import { config } from '../../lib/config.js'

// ── Fixture ───────────────────────────────────────────────────────────────────

const TENANT = 'tenant-A'
const input = { tenantId: TENANT, title: 'VPN lenta', description: 'da stamattina', ciIds: ['ci-1'] }

const similar = (n: number, score: number, teamName: string | null = 'NOC') =>
  ({ id: `inc-${n}`, number: `INC0000000${n}`, title: `Simile ${n}`, severity: 'high', category: 'network', status: 'resolved', teamName, score })

const SIMILAR = [similar(1, 0.91), similar(2, 0.88), similar(3, 0.8, null), similar(4, 0.7), similar(5, 0.6), similar(6, 0.5)]

function graph(opts: { severities?: string[] | null; categories?: string[] | null; similar?: unknown[]; impact?: unknown[] } = {}) {
  vi.mocked(runQuery).mockImplementation(async (_s: unknown, cypher: string, params?: Record<string, unknown>) => {
    if (cypher.includes('CITypeDefinition')) {
      const values = params?.['field'] === 'severity' ? (opts.severities === undefined ? ['low', 'medium', 'high', 'critical'] : opts.severities)
                                                      : (opts.categories === undefined ? ['network', 'database'] : opts.categories)
      return [{ values }]
    }
    if (cypher.includes('db.index.vector.queryNodes')) return opts.similar ?? SIMILAR
    if (cypher.includes('BusinessCapability')) return opts.impact ?? [
      { name: 'vpn-gw-01', type: 'Server', environment: 'prod', dependentCount: { toNumber: () => 12 }, capabilities: ['Remote work'] },
    ]
    throw new Error(`query inattesa: ${cypher.slice(0, 60)}`)
  })
}

const modelReply = (text: string | null, stop_reason = 'end_turn') => ({
  stop_reason,
  content: text === null ? [{ type: 'thinking', thinking: '…' }] : [{ type: 'thinking', thinking: '…' }, { type: 'text', text }],
})

const SUGGESTION = { severity: 'high', category: 'network', teamName: 'NOC', confidence: 'high', motivation: 'Simili risolti dal NOC', riskFactors: ['12 dipendenti'] }

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => { throw new Error('atteso un rifiuto') }, (e: unknown) => e)
}

beforeEach(() => {
  vi.clearAllMocks()
  h.constructed.length = 0
  h.ownEnums.length = 0
  h.cfg.anthropicApiKey = 'sk-test'
  h.embed.mockResolvedValue([[0.1, 0.2, 0.3]])
  h.create.mockResolvedValue(modelReply(JSON.stringify(SUGGESTION)))
  graph()
})

describe('suggestTriage — precondizioni', () => {
  it('titolo e descrizione vuoti → BAD_USER_INPUT senza embedding né query', async () => {
    const err = await failure(suggestTriage({ ...input, title: '  ', description: null }))
    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).extensions['code']).toBe('BAD_USER_INPUT')
    expect(h.embed).not.toHaveBeenCalled()
    expect(runQuery).not.toHaveBeenCalled()
    expect(h.create).not.toHaveBeenCalled()
  })

  it('ANTHROPIC_API_KEY assente → FAILED_PRECONDITION prima di istanziare l\'SDK / chiamare messages.create', async () => {
    h.cfg.anthropicApiKey = undefined
    const err = await failure(suggestTriage(input))
    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).message).toBe('Triage AI non configurato: ANTHROPIC_API_KEY mancante')
    expect((err as GraphQLError).extensions['code']).toBe('FAILED_PRECONDITION')
    expect(h.constructed).toHaveLength(0)
    expect(h.create).not.toHaveBeenCalled()
  })

  it('enum severity/category assenti dal metamodello → errore esplicito, nessuna chiamata al modello', async () => {
    graph({ severities: null })
    await expect(suggestTriage(input)).rejects.toThrow('[triage] enum values for incident.severity not found in the metamodel')
    graph({ categories: [] })
    await expect(suggestTriage(input)).rejects.toThrow('[triage] enum values for incident.category not found in the metamodel')
    expect(h.create).not.toHaveBeenCalled()
  })
})

describe('suggestTriage — chiamata al modello', () => {
  it('embedda la bozza, vincola lo schema di output agli enum del tenant e passa il contesto reale', async () => {
    const result = await suggestTriage(input)
    expect(h.embed).toHaveBeenCalledWith(['VPN lenta\nda stamattina'])
    expect(h.create).toHaveBeenCalledTimes(1)
    const params = h.create.mock.calls[0]![0]
    expect(params).toMatchObject({ model: config.anthropicModel, max_tokens: 2000, thinking: { type: 'adaptive' } })
    const schema = (params['output_config'] as { format: { type: string; schema: Record<string, { enum?: string[] }> } }).format
    expect(schema.type).toBe('json_schema')
    expect(schema.schema['properties']).toMatchObject({
      severity: { enum: ['low', 'medium', 'high', 'critical'] },
      category: { enum: ['network', 'database'] },
      confidence: { enum: ['low', 'medium', 'high'] },
    })
    const userContent = JSON.parse((params['messages'] as Array<{ content: string }>)[0]!.content) as Record<string, unknown>
    expect(userContent['bozza']).toEqual({ titolo: 'VPN lenta', descrizione: 'da stamattina' })
    expect(userContent['incident_simili']).toHaveLength(6)
    expect((userContent['incident_simili'] as unknown[])[0]).toEqual({ numero: 'INC00000001', titolo: 'Simile 1', severity: 'high', categoria: 'network', stato: 'resolved', team: 'NOC', similarita: 0.91 })
    expect(userContent['impatto_ci']).toEqual([{ name: 'vpn-gw-01', type: 'Server', environment: 'prod', dependentCount: 12, capabilities: ['Remote work'] }])

    expect(result).toEqual({ ...SUGGESTION, similarUsed: SIMILAR.slice(0, 5) })
  })

  it('tutte le query sono tenant-scoped; i CI sono limitati ai primi 5', async () => {
    await suggestTriage({ ...input, ciIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })
    const calls = vi.mocked(runQuery).mock.calls
    expect(calls.length).toBe(4)
    for (const c of calls) {
      expect(c[1]).toContain('$tenantId')
      expect((c[2] as Record<string, unknown>)['tenantId']).toBe(TENANT)
    }
    const impact = calls.find(c => (c[1] as string).includes('BusinessCapability'))!
    expect((impact[2] as Record<string, unknown>)['ciIds']).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  // ── A-2: i valori ammessi sono quelli di QUESTO cliente ───────────────────
  // `incident` è un tipo spedito col prodotto: il suo `USES_ENUM` è unico per
  // tutti, e letto senza ambito portava qui i vocabolari del cliente che li
  // aveva agganciati per primo (dal vivo: c-one).

  it('il vocabolario agganciato si legge solo se di sistema o del tenant, e il tipo incident è quello condiviso', async () => {
    await suggestTriage(input)
    const enumCalls = vi.mocked(runQuery).mock.calls.filter((c) => (c[1] as string).includes('CITypeDefinition'))
    expect(enumCalls).toHaveLength(2)
    for (const c of enumCalls) {
      expect(c[1]).toContain("WHERE t.tenant_id IN [$tenantId, 'system']")
      expect(c[1]).toContain("WHERE e.tenant_id IN [$tenantId, 'system']")
    }
  })

  it('la personalizzazione del tenant (stesso nome) vince sui valori agganciati', async () => {
    h.ownEnums.push({ id: 'own-sev', name: 'severity', values: ['bassa', 'alta'] })
    vi.mocked(runQuery).mockImplementation(async (_s: unknown, cypher: string, params?: Record<string, unknown>) => {
      if (cypher.includes('CITypeDefinition')) {
        return [params?.['field'] === 'severity'
          ? { values: ['low', 'high'], enumId: 'sys-sev', enumName: 'severity' }
          : { values: ['network'],     enumId: 'sys-cat', enumName: 'category' }]
      }
      if (cypher.includes('db.index.vector.queryNodes')) return SIMILAR
      return []
    })
    h.create.mockResolvedValue(modelReply(JSON.stringify({ ...SUGGESTION, severity: 'alta', category: 'network' })))
    await suggestTriage({ ...input, ciIds: [] })
    const outputConfig = h.create.mock.calls[0]![0]['output_config'] as { format: { schema: { properties: Record<string, { enum?: string[] }> } } }
    // i valori del vocabolario agganciato (low/high) non arrivano al modello
    expect(outputConfig.format.schema.properties['severity']!.enum).toEqual(['bassa', 'alta'])
    expect(outputConfig.format.schema.properties['category']!.enum).toEqual(['network'])
  })

  it('senza CI non interroga l\'impatto e passa impatto_ci vuoto', async () => {
    await suggestTriage({ ...input, ciIds: [] })
    expect(vi.mocked(runQuery).mock.calls.some(c => (c[1] as string).includes('BusinessCapability'))).toBe(false)
    const userContent = JSON.parse((h.create.mock.calls[0]![0]['messages'] as Array<{ content: string }>)[0]!.content) as Record<string, unknown>
    expect(userContent['impatto_ci']).toEqual([])
  })

  it('output JSON non parsabile → errore esplicito (nessun triage vuoto)', async () => {
    h.create.mockResolvedValue(modelReply('{"severity": "high", '))
    await expect(suggestTriage(input)).rejects.toThrow(SyntaxError)
  })

  it('refusal → INTERNAL_SERVER_ERROR; risposta senza blocco testo → errore', async () => {
    h.create.mockResolvedValue(modelReply(null, 'refusal'))
    const err = await failure(suggestTriage(input))
    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).extensions['code']).toBe('INTERNAL_SERVER_ERROR')

    h.create.mockResolvedValue(modelReply(null))
    await expect(suggestTriage(input)).rejects.toThrow('[triage] risposta senza blocco testo')
  })

  it('errore del provider propaga (no-fallback)', async () => {
    h.create.mockRejectedValue(new Error('overloaded_error'))
    await expect(suggestTriage(input)).rejects.toThrow('overloaded_error')
  })
})
