import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Session mock usato da withSession ─────────────────────────────────────────
// executeWrite invoca la callback con una ManagedTransaction mock: il service
// esegue le scritture di ogni riga (MERGE nodo, relazioni, commenti, workflow)
// dentro una executeWrite per riga.

const mockTx = {
  run: vi.fn().mockResolvedValue({ records: [] }),
}

const mockSession = {
  executeRead:  vi.fn().mockResolvedValue({ records: [] }),
  executeWrite: vi.fn().mockImplementation(
    async (work: (tx: typeof mockTx) => Promise<unknown>) => work(mockTx),
  ),
  close:        vi.fn().mockResolvedValue(undefined),
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: {
    createInstance: vi.fn().mockResolvedValue({ id: 'wi-1' }),
    transition:     vi.fn().mockResolvedValue({ success: true }),
  },
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession:  vi.fn(),
  runQuery:    vi.fn(),
  runQueryOne: vi.fn(),
  closeDriver: vi.fn(),
}))

const INCIDENT_STEPS = [
  { name: 'new',         isInitial: true,  isTerminal: false, isOpen: true,  category: null,        stepOrder: 1 },
  { name: 'assigned',    isInitial: false, isTerminal: false, isOpen: true,  category: null,        stepOrder: 2 },
  { name: 'in_progress', isInitial: false, isTerminal: false, isOpen: true,  category: null,        stepOrder: 3 },
  { name: 'resolved',    isInitial: false, isTerminal: false, isOpen: false, category: 'resolved',  stepOrder: 4 },
  { name: 'closed',      isInitial: false, isTerminal: true,  isOpen: false, category: null,        stepOrder: 5 },
]

const KB_STEPS = [
  { name: 'draft',     isInitial: true,  isTerminal: false, isOpen: true,  category: null,        stepOrder: 1 },
  { name: 'review',    isInitial: false, isTerminal: false, isOpen: true,  category: null,        stepOrder: 2 },
  { name: 'published', isInitial: false, isTerminal: true,  isOpen: false, category: 'published', stepOrder: 3 },
]

vi.mock('../../lib/workflowHelpers.js', () => ({
  getWorkflowSteps: vi.fn().mockImplementation(
    async (_s: unknown, _t: string, entityType: string) =>
      entityType === 'incident' ? INCIDENT_STEPS : KB_STEPS,
  ),
  getInitialStepName: vi.fn().mockResolvedValue('new'),
}))

vi.mock('../../graphql/resolvers/ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(
    async (fn: (s: unknown) => Promise<unknown>, _write?: boolean) => fn(mockSession),
  ),
  getSession: vi.fn(),
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// ── Import after mocks ────────────────────────────────────────────────────────

const { parseCsv, importIncidents, importKBArticles } = await import('../ticketImportService.js')
const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { workflowEngine } = await import('@opengraphity/workflow')

const ctx = { tenantId: 'tenant-1', userId: 'user-1' }

/** Dispatch delle letture del service in base al contenuto della query. */
function mockReads(opts: {
  users?:      Array<{ email: string; id: string }>
  teams?:      Array<{ name: string; id: string }>
  existing?:   Array<{ id: string; externalId: string; number: string | null }>
  numbers?:    Array<{ number: string; externalId: string | null }>
  maxNum?:     number
  kbExisting?: Array<{ id: string; externalId: string }>
  slugs?:      string[]
} = {}) {
  vi.mocked(runQuery).mockImplementation(async (_s: unknown, query: string) => {
    if (query.includes('MATCH (u:User'))               return (opts.users ?? []) as never
    if (query.includes('MATCH (t:Team'))               return (opts.teams ?? []) as never
    if (query.includes('i.import_external_id IN'))     return (opts.existing ?? []) as never
    if (query.includes('i.number IN'))                 return (opts.numbers ?? []) as never
    if (query.includes('a.import_external_id IN'))     return (opts.kbExisting ?? []) as never
    if (query.includes('RETURN a.slug'))               return (opts.slugs ?? []).map((slug) => ({ slug })) as never
    return [] as never
  })
  vi.mocked(runQueryOne).mockImplementation(async (_s: unknown, query: string) => {
    if (query.includes("STARTS WITH 'INC'")) return { maxNum: opts.maxNum ?? 0 } as never
    return null as never
  })
}

/** Parametri della MERGE (i:Incident ...) per la riga n-esima scritta (0-based). */
function mergedIncidentParams(n = 0): Record<string, unknown> {
  const calls = mockTx.run.mock.calls.filter((c) => (c[0] as string).includes('MERGE (i:Incident'))
  expect(calls.length).toBeGreaterThan(n)
  return calls[n]![1] as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
  mockTx.run.mockResolvedValue({ records: [] })
  mockSession.executeWrite.mockImplementation(
    async (work: (tx: typeof mockTx) => Promise<unknown>) => work(mockTx),
  )
  mockReads()
})

// ── parseCsv ──────────────────────────────────────────────────────────────────

describe('parseCsv', () => {
  it('gestisce campi quotati con virgole e doppi apici escapati', () => {
    const rows = parseCsv('external_id,title\nA-1,"Ciao, mondo con ""quote"""\n')
    expect(rows).toEqual([{ external_id: 'A-1', title: 'Ciao, mondo con "quote"' }])
  })

  it('gestisce newline dentro campi quotati', () => {
    const rows = parseCsv('id,desc\n1,"riga uno\nriga due"\n2,ok')
    expect(rows).toHaveLength(2)
    expect(rows[0]!['desc']).toBe('riga uno\nriga due')
    expect(rows[1]!['desc']).toBe('ok')
  })

  it('rimuove il BOM UTF-8 dalla prima intestazione', () => {
    const rows = parseCsv('﻿external_id,title\nA-1,Titolo')
    expect(rows[0]!['external_id']).toBe('A-1')
  })

  it('gestisce CRLF e salta righe completamente vuote', () => {
    const rows = parseCsv('a,b\r\n1,2\r\n,\r\n\r\n3,4\r\n')
    expect(rows).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }])
  })

  it('ritorna [] per testo vuoto o solo intestazione', () => {
    expect(parseCsv('')).toEqual([])
    expect(parseCsv('a,b\n')).toEqual([])
  })
})

// ── importIncidents ───────────────────────────────────────────────────────────

describe('importIncidents', () => {
  it('mappa severity libere case-insensitive e segnala warning su valori sconosciuti', async () => {
    const result = await importIncidents([
      { external_id: 'A-1', title: 'T1', severity: 'P1' },
      { external_id: 'A-2', title: 'T2', severity: 'urgentissimo' },
    ], ctx)

    expect(result.created).toBe(2)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatchObject({ row: 2, externalId: 'A-2' })
    expect(result.warnings[0]!.message).toContain('urgentissimo')
    expect(mergedIncidentParams(0)['severity']).toBe('critical')
    expect(mergedIncidentParams(1)['severity']).toBe('medium')
  })

  it('mappa status case-insensitive sugli step del workflow; sconosciuto → warning + step iniziale', async () => {
    const result = await importIncidents([
      { external_id: 'A-1', title: 'T1', status: 'IN_PROGRESS' },
      { external_id: 'A-2', title: 'T2', status: 'inesistente' },
    ], ctx)

    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]!.message).toContain('inesistente')
    expect(mergedIncidentParams(0)['status']).toBe('in_progress')
    expect(mergedIncidentParams(1)['status']).toBe('new')
  })

  it('errore di riga su external_id mancante, title mancante e data invalida — le righe valide procedono', async () => {
    const result = await importIncidents([
      { external_id: '',    title: 'T1' },
      { external_id: 'A-2', title: ''   },
      { external_id: 'A-3', title: 'T3', created_at: 'non-una-data' },
      { external_id: 'A-4', title: 'T4', created_at: '2024-01-01T10:00:00Z' },
    ], ctx)

    expect(result.totalRows).toBe(4)
    expect(result.created).toBe(1)
    expect(result.errors).toHaveLength(3)
    expect(result.errors.map((e) => e.row)).toEqual([1, 2, 3])
    expect(result.errors[0]!.message).toContain('external_id')
    expect(result.errors[1]!.message).toContain('title')
    expect(result.errors[2]!.message).toContain('created_at')
    // timestamp originale preservato sulla riga valida
    expect(mergedIncidentParams(0)['createdAt']).toBe('2024-01-01T10:00:00.000Z')
  })

  it('idempotenza: secondo run sullo stesso external_id → updated, non created', async () => {
    mockReads({ existing: [{ id: 'inc-1', externalId: 'A-1', number: 'INC00000001' }] })

    const result = await importIncidents([{ external_id: 'A-1', title: 'T1 aggiornato' }], ctx)

    expect(result.created).toBe(0)
    expect(result.updated).toBe(1)
    expect(result.errors).toHaveLength(0)
    // la scrittura resta una MERGE su (tenant_id, import_external_id)
    const params = mergedIncidentParams(0)
    expect(params['externalId']).toBe('A-1')
    // update senza number nel CSV → numberUpdate null (conserva quello esistente)
    expect(params['numberUpdate']).toBeNull()
  })

  it('dry-run: valida tutto senza scrivere — executeWrite mai chiamata', async () => {
    mockReads({ existing: [{ id: 'inc-1', externalId: 'A-1', number: null }] })

    const result = await importIncidents([
      { external_id: 'A-1', title: 'Esistente' },
      { external_id: 'A-2', title: 'Nuovo', severity: 'boh' },
      { external_id: '',    title: 'Invalida' },
    ], ctx, { dryRun: true })

    expect(result).toMatchObject({ totalRows: 3, created: 1, updated: 1 })
    expect(result.errors).toHaveLength(1)
    expect(result.warnings).toHaveLength(1)
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
    expect(mockTx.run).not.toHaveBeenCalled()
    expect(workflowEngine.createInstance).not.toHaveBeenCalled()
  })

  it('number collision: number già usato da un altro incident → errore di riga', async () => {
    mockReads({ numbers: [{ number: 'INC00000042', externalId: 'ALTRO' }] })

    const result = await importIncidents([
      { external_id: 'A-1', title: 'T1', number: 'INC00000042' },
    ], ctx)

    expect(result.created).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.message).toContain('INC00000042')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('number preservato se già suo; generato progressivo se assente', async () => {
    mockReads({ numbers: [{ number: 'INC90000001', externalId: 'A-1' }], maxNum: 7, existing: [{ id: 'inc-1', externalId: 'A-1', number: 'INC90000001' }] })

    const result = await importIncidents([
      { external_id: 'A-1', title: 'T1', number: 'INC90000001' },
      { external_id: 'A-2', title: 'T2' },
    ], ctx)

    expect(result.errors).toHaveLength(0)
    expect(mergedIncidentParams(0)['numberUpdate']).toBe('INC90000001')
    expect(mergedIncidentParams(1)['number']).toBe('INC00000008')
  })

  it('external_id duplicato nel file → errore sulla seconda riga', async () => {
    const result = await importIncidents([
      { external_id: 'A-1', title: 'T1' },
      { external_id: 'A-1', title: 'T2' },
    ], ctx)
    expect(result.created).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.row).toBe(2)
  })

  it('assignee/team non trovati → warning senza bloccare; trovati → relazioni scritte', async () => {
    mockReads({ users: [{ email: 'mario@acme.it', id: 'u-1' }], teams: [{ name: 'platform', id: 't-1' }] })

    const result = await importIncidents([
      { external_id: 'A-1', title: 'T1', assignee_email: 'Mario@Acme.it', team_name: 'Platform' },
      { external_id: 'A-2', title: 'T2', assignee_email: 'ghost@acme.it', team_name: 'Nessuno' },
    ], ctx)

    expect(result.created).toBe(2)
    expect(result.warnings).toHaveLength(2)
    const assignQueries = mockTx.run.mock.calls.filter((c) => (c[0] as string).includes(':ASSIGNED_TO]'))
    const teamQueries   = mockTx.run.mock.calls.filter((c) => (c[0] as string).includes(':ASSIGNED_TO_TEAM]'))
    expect(assignQueries).toHaveLength(1)
    expect(teamQueries).toHaveLength(1)
    expect((assignQueries[0]![1] as Record<string, unknown>)['userId']).toBe('u-1')
    expect((teamQueries[0]![1] as Record<string, unknown>)['teamId']).toBe('t-1')
  })

  it('comments JSON invalido → errore riga; commenti validi → nodi Comment con created_at originali', async () => {
    mockReads({ users: [{ email: 'mario@acme.it', id: 'u-1' }] })

    const result = await importIncidents([
      { external_id: 'A-1', title: 'T1', comments: 'non-json' },
      { external_id: 'A-2', title: 'T2', comments: '[{"author_email":"mario@acme.it","text":"ok","created_at":"2024-02-01T08:00:00Z"}]' },
    ], ctx)

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.row).toBe(1)
    const commentCalls = mockTx.run.mock.calls.filter((c) => (c[0] as string).includes('CREATE (c:Comment'))
    expect(commentCalls).toHaveLength(1)
    const comments = (commentCalls[0]![1] as { comments: Array<Record<string, unknown>> }).comments
    expect(comments[0]).toMatchObject({ text: 'ok', authorId: 'u-1', createdAt: '2024-02-01T08:00:00.000Z' })
  })

  it('crea la workflow instance e la porta allo step mappato dentro la stessa tx', async () => {
    await importIncidents([{ external_id: 'A-1', title: 'T1', status: 'resolved' }], ctx)

    expect(mockSession.executeWrite).toHaveBeenCalledTimes(1)
    expect(workflowEngine.createInstance).toHaveBeenCalledWith(mockTx, ctx.tenantId, expect.any(String), 'incident')
    const repointCalls = mockTx.run.mock.calls.filter((c) => (c[0] as string).includes('wi.current_step <> $stepName'))
    expect(repointCalls).toHaveLength(1)
    expect((repointCalls[0]![1] as Record<string, unknown>)['stepName']).toBe('resolved')
  })
})

// ── importKBArticles ──────────────────────────────────────────────────────────

describe('importKBArticles', () => {
  function mergedKBParams(n = 0): Record<string, unknown> {
    const calls = mockTx.run.mock.calls.filter((c) => (c[0] as string).includes('MERGE (a:KBArticle'))
    expect(calls.length).toBeGreaterThan(n)
    return calls[n]![1] as Record<string, unknown>
  }

  it('genera slug dal titolo con dedup -2, -3 e default status draft', async () => {
    mockReads({ slugs: ['reset-password'] })

    const result = await importKBArticles([
      { external_id: 'K-1', title: 'Reset Password' },
      { external_id: 'K-2', title: 'Reset password', status: 'strano' },
    ], ctx)

    expect(result.created).toBe(2)
    expect(result.warnings).toHaveLength(1) // status sconosciuto → draft
    expect(mergedKBParams(0)['slug']).toBe('reset-password-2')
    expect(mergedKBParams(1)['slug']).toBe('reset-password-3')
    expect(mergedKBParams(0)['status']).toBe('draft') // step iniziale del workflow kb
  })

  it('status published → step con category published; tags separati da ;', async () => {
    await importKBArticles([
      { external_id: 'K-1', title: 'Guida VPN', status: 'Published', tags: 'vpn; rete ;', published_at: '2024-06-01T00:00:00Z' },
    ], ctx)

    const params = mergedKBParams(0)
    expect(params['status']).toBe('published')
    expect(params['tags']).toBe(JSON.stringify(['vpn', 'rete']))
    expect(params['publishedAt']).toBe('2024-06-01T00:00:00.000Z')
  })

  it('idempotenza: articolo esistente → updated e slug esistente conservato', async () => {
    mockReads({ kbExisting: [{ id: 'kb-1', externalId: 'K-1' }] })

    const result = await importKBArticles([{ external_id: 'K-1', title: 'Guida aggiornata' }], ctx)

    expect(result.created).toBe(0)
    expect(result.updated).toBe(1)
    expect(mergedKBParams(0)['slug']).toBeNull() // ON CREATE only: slug non toccato
  })

  it('dry-run: nessuna scrittura', async () => {
    const result = await importKBArticles([
      { external_id: 'K-1', title: 'Guida' },
      { external_id: '',    title: 'Senza id' },
    ], ctx, { dryRun: true })

    expect(result).toMatchObject({ totalRows: 2, created: 1, updated: 0 })
    expect(result.errors).toHaveLength(1)
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })
})
