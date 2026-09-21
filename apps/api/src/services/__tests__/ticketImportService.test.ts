import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Session mock usato da withSession ─────────────────────────────────────────
// executeWrite invoca la callback con una ManagedTransaction mock: il service
// esegue le scritture di ogni riga (MERGE nodo, relazioni, commenti, workflow)
// dentro una executeWrite per riga.

/** Il contatore dei numeri (lib/sequence.ts): ogni MERGE (c:Counter) restituisce il valore successivo. */
let counter = 0
const txRun = async (query: string) => {
  if (query.includes('MERGE (c:Counter') && query.includes('RETURN c.value')) {
    counter += 1
    return { records: [{ get: () => counter }] }
  }
  return { records: [] }
}
const mockTx = {
  run: vi.fn(txRun),
}

const mockSession = {
  executeRead:  vi.fn().mockResolvedValue({ records: [] }),
  executeWrite: vi.fn().mockImplementation(
    async (work: (tx: typeof mockTx) => Promise<unknown>) => work(mockTx),
  ),
  close:        vi.fn().mockResolvedValue(undefined),
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Ondata 7: la traduzione fra valori di dominio è una lettura (la matrice è
// dato del cliente). Qui si misura altro: il doppio risponde con la matrice di
// fabbrica e i vocabolari spediti, senza grafo (lib/__tests__/domainMatrixFake.ts).
// Ondata 6 di «Nulla cablato»: il formato dei numeri è del cliente; qui quello di fabbrica.
vi.mock('../../lib/ticketNumbering.js', () => import('../../lib/__tests__/ticketNumberingFake.js'))
vi.mock('../../lib/domainMatrix.js', () => import('../../lib/__tests__/domainMatrixFake.js'))

vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: {
    createInstance: vi.fn().mockResolvedValue({ id: 'wi-1' }),
    transition:     vi.fn().mockResolvedValue({ success: true }),
    registerCondition: vi.fn(),
  },
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession:  vi.fn(),
  runQuery:    vi.fn(),
  runQueryOne: vi.fn(),
  closeDriver: vi.fn(),
  toNumber:    (v: unknown) => Number(v),
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
      entityType === 'kb_article' ? KB_STEPS : INCIDENT_STEPS,
  ),
  getInitialStepName: vi.fn().mockResolvedValue('new'),
}))

vi.mock('../../graphql/resolvers/ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(
    async (fn: (s: unknown) => Promise<unknown>, _write?: boolean) => fn(mockSession),
  ),
  getSession: vi.fn(),
}))

// Ondata 4: i campi del cliente dell'incident, per le colonne omonime del file.
let customDefs: Array<Record<string, unknown>> = []
vi.mock('../../lib/ticketCustomFields.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  customFieldDefs: vi.fn(async () => customDefs),
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// ── Import after mocks ────────────────────────────────────────────────────────

const { parseCsv, importIncidents, importProblems, importChanges, importServiceRequests, importKBArticles } = await import('../ticketImportService.js')
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
    if (query.includes('n.import_external_id IN'))     return (opts.existing ?? []) as never
    if (query.includes('n.number IN'))                 return (opts.numbers ?? []) as never
    if (query.includes('a.import_external_id IN'))     return (opts.kbExisting ?? []) as never
    if (query.includes('RETURN a.slug'))               return (opts.slugs ?? []).map((slug) => ({ slug })) as never
    return [] as never
  })
  vi.mocked(runQueryOne).mockImplementation(async (_s: unknown, query: string) => {
    if (query.includes('STARTS WITH $prefix')) return { maxNum: opts.maxNum ?? 0 } as never
    return null as never
  })
}

/** Parametri della MERGE (n:<label> ...) per la riga n-esima scritta (0-based). */
function mergedParams(label: string, n = 0): Record<string, unknown> {
  const calls = mockTx.run.mock.calls.filter((c) => (c[0] as string).includes(`MERGE (n:${label}`))
  expect(calls.length).toBeGreaterThan(n)
  return calls[n]![1] as Record<string, unknown>
}
const mergedIncidentParams = (n = 0) => mergedParams('Incident', n)
/** Le proprietà del tipo scritte sulla riga (severità, descrizione, date…). */
const incidentProps = (n = 0) => mergedIncidentParams(n)['props'] as Record<string, unknown>

beforeEach(() => {
  vi.clearAllMocks()
  counter = 0
  mockTx.run.mockImplementation(txRun)
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
  // CONTRATTO RINEGOZIATO (ondata 7 · D-16). Prima questo punto pretendeva
  // `urgentissimo` → **warning + `medium`**: la riga entrava nel CMDB con una
  // severità che il file non diceva, e l'unica traccia era una riga nel
  // riepilogo dell'import. Adesso la traduzione è la matrice `import_severity`
  // del cliente e una severità non traducibile mette la **riga in errore**:
  // non si scrive un ticket con una priorità inventata. I 25 sinonimi storici
  // (`P1`, `sev2`, `crit`, …) restano, perché sono il seme della matrice.
  it('i sinonimi restano (case-insensitive); una severità non traducibile mette la RIGA IN ERRORE, non a «medium»', async () => {
    const result = await importIncidents([
      { external_id: 'A-1', title: 'T1', severity: 'P1' },
      { external_id: 'A-2', title: 'T2', severity: 'urgentissimo' },
    ], ctx)

    expect(result.created).toBe(1)
    expect(result.warnings).toHaveLength(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({ row: 2, externalId: 'A-2' })
    expect(result.errors[0]!.message).toContain('urgentissimo')
    // Il messaggio dice la strada: il vocabolario e la matrice.
    expect(result.errors[0]!.message).toMatch(/Import Severity/)
    expect(incidentProps(0)['severity']).toBe('critical')
  })

  // Verifica «Cosa resta cablato», ondata 1: senza severità non c'è più il
  // default `medium`, che né il file né il cliente avevano scelto.
  it('senza severity la riga è IN ERRORE, non nasce con un valore scelto dal codice', async () => {
    const result = await importIncidents([
      { external_id: 'A-1', title: 'T1' },
      { external_id: 'A-2', title: 'T2', severity: 'med' },
    ], ctx)
    expect(result.created).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({ row: 1, externalId: 'A-1', messageKey: 'severityRequired' })
    expect(incidentProps(0)['severity']).toBe('medium')
  })

  // Verifica «Cosa resta cablato», ondata 4: una colonna per campo del cliente.
  it('colonne dei campi del cliente: valore convertito e scritto; valore fuori vocabolario → riga in errore che nomina la colonna', async () => {
    customDefs = [
      { name: 'site', label: 'Sede', fieldType: 'enum', required: true, enumValues: ['mi', 'rm'], enumTypeName: 'site', validationScript: null, visibleToEndUser: false, order: 1 },
      { name: 'effort', label: 'Ore', fieldType: 'number', required: false, enumValues: [], enumTypeName: null, validationScript: null, visibleToEndUser: false, order: 2 },
    ]
    const result = await importIncidents([
      { external_id: 'A-1', title: 'T1', severity: 'P1', site: 'rm', effort: '2.5' },
      { external_id: 'A-2', title: 'T2', severity: 'P1', site: 'napoli' },
      // Storico senza il campo: l'obbligo non vale nell'import, e la cella vuota non tocca il campo.
      { external_id: 'A-3', title: 'T3', severity: 'P1', site: '' },
    ], ctx)
    customDefs = []
    expect(result.created).toBe(2)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({ row: 2, externalId: 'A-2', messageKey: 'customFieldInvalid', messageParams: expect.objectContaining({ field: 'site' }) })
    expect(mergedIncidentParams(0)['customProps']).toEqual({ site: 'rm', effort: 2.5 })
    expect(mergedIncidentParams(1)['customProps']).toEqual({})
  })

  it('mappa status case-insensitive sugli step del workflow; sconosciuto → warning + step iniziale', async () => {
    const result = await importIncidents([
      { external_id: 'A-1', title: 'T1', status: 'IN_PROGRESS', severity: 'med' },
      { external_id: 'A-2', title: 'T2', status: 'inesistente', severity: 'med' },
    ], ctx)

    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]!.message).toContain('inesistente')
    expect(mergedIncidentParams(0)['status']).toBe('in_progress')
    expect(mergedIncidentParams(1)['status']).toBe('new')
  })

  it('errore di riga su external_id mancante, title mancante e data invalida — le righe valide procedono', async () => {
    const result = await importIncidents([
      { external_id: '',    title: 'T1', severity: 'med' },
      { external_id: 'A-2', title: '', severity: 'med' },
      { external_id: 'A-3', title: 'T3', created_at: 'non-una-data', severity: 'med' },
      { external_id: 'A-4', title: 'T4', created_at: '2024-01-01T10:00:00Z', severity: 'med' },
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

    const result = await importIncidents([{ external_id: 'A-1', title: 'T1 aggiornato', severity: 'med' }], ctx)

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
      { external_id: 'A-1', title: 'Esistente', severity: 'med' },
      { external_id: 'A-2', title: 'Nuovo', severity: 'boh' },
      { external_id: '',    title: 'Invalida', severity: 'med' },
    ], ctx, { dryRun: true })

    // Ondata 7: `severity: 'boh'` non e' piu' un avviso con ripiego a `medium`
    // ma un errore di riga, quindi la riga «Nuovo» non viene creata: due
    // errori (severita' non traducibile, external_id assente) e zero avvisi.
    expect(result).toMatchObject({ totalRows: 3, created: 0, updated: 1 })
    expect(result.errors).toHaveLength(2)
    expect(result.warnings).toHaveLength(0)
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
    expect(mockTx.run).not.toHaveBeenCalled()
    expect(workflowEngine.createInstance).not.toHaveBeenCalled()
  })

  it('number collision: number già usato da un altro incident → errore di riga', async () => {
    mockReads({ numbers: [{ number: 'INC00000042', externalId: 'ALTRO' }] })

    const result = await importIncidents([
      { external_id: 'A-1', title: 'T1', number: 'INC00000042', severity: 'med' },
    ], ctx)

    expect(result.created).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.message).toContain('INC00000042')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  // Ondata 5 di «Nulla cablato»: il numero generato viene dal contatore dei
  // ticket (lib/sequence.ts), e il contatore sale oltre i numeri già presenti o
  // preservati. Prima era max()+1 senza toccare il contatore: il primo incident
  // aperto dalla pagina dopo un import riprendeva un numero già scritto.
  it('number preservato se già suo; generato dal contatore se assente, e il contatore sale oltre il più alto', async () => {
    mockReads({ numbers: [{ number: 'INC90000001', externalId: 'A-1' }], maxNum: 7, existing: [{ id: 'inc-1', externalId: 'A-1', number: 'INC90000001' }] })
    counter = 90000001

    const result = await importIncidents([
      { external_id: 'A-1', title: 'T1', number: 'INC90000001', severity: 'med' },
      { external_id: 'A-2', title: 'T2', severity: 'med' },
    ], ctx)

    expect(result.errors).toHaveLength(0)
    const raise = mockSession.executeWrite.mock.calls.length
    expect(raise).toBeGreaterThan(0)
    expect(mergedIncidentParams(0)['numberUpdate']).toBe('INC90000001')
    expect(mergedIncidentParams(1)['number']).toBe('INC90000002')
    const raised = mockTx.run.mock.calls.find((c) => (c[0] as string).includes('CASE WHEN c.value < $value'))
    expect(raised?.[1]).toMatchObject({ kind: 'incident' })
    expect(Number((raised![1] as { value: unknown }).value)).toBe(90000001)
  })

  it('external_id duplicato nel file → errore sulla seconda riga', async () => {
    const result = await importIncidents([
      { external_id: 'A-1', title: 'T1', severity: 'med' },
      { external_id: 'A-1', title: 'T2', severity: 'med' },
    ], ctx)
    expect(result.created).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.row).toBe(2)
  })

  it('assignee/team non trovati → warning senza bloccare; trovati → relazioni scritte', async () => {
    mockReads({ users: [{ email: 'mario@acme.it', id: 'u-1' }], teams: [{ name: 'platform', id: 't-1' }] })

    const result = await importIncidents([
      { external_id: 'A-1', title: 'T1', assignee_email: 'Mario@Acme.it', team_name: 'Platform', severity: 'med' },
      { external_id: 'A-2', title: 'T2', assignee_email: 'ghost@acme.it', team_name: 'Nessuno', severity: 'med' },
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
      { external_id: 'A-1', title: 'T1', comments: 'non-json', severity: 'med' },
      { external_id: 'A-2', title: 'T2', comments: '[{"author_email":"mario@acme.it","text":"ok","created_at":"2024-02-01T08:00:00Z"}]', severity: 'med' },
    ], ctx)

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.row).toBe(1)
    const commentCalls = mockTx.run.mock.calls.filter((c) => (c[0] as string).includes('CREATE (c:Comment'))
    expect(commentCalls).toHaveLength(1)
    const comments = (commentCalls[0]![1] as { comments: Array<Record<string, unknown>> }).comments
    expect(comments[0]).toMatchObject({ text: 'ok', authorId: 'u-1', createdAt: '2024-02-01T08:00:00.000Z' })
  })

  it('crea la workflow instance e la porta allo step mappato dentro la stessa tx', async () => {
    await importIncidents([{ external_id: 'A-1', title: 'T1', status: 'resolved', severity: 'med' }], ctx)

    expect(mockSession.executeWrite).toHaveBeenCalledTimes(1)
    expect(workflowEngine.createInstance).toHaveBeenCalledWith(mockTx, ctx.tenantId, expect.any(String), 'incident')
    const repointCalls = mockTx.run.mock.calls.filter((c) => (c[0] as string).includes('wi.current_step <> $stepName'))
    expect(repointCalls).toHaveLength(1)
    expect((repointCalls[0]![1] as Record<string, unknown>)['stepName']).toBe('resolved')
  })
})

// ── problem, change, service request (ondata 5 di «Nulla cablato») ──────────────

describe('import dei problem, delle change e delle richieste', () => {
  it('problem: priorità dal vocabolario del cliente (maiuscole indifferenti), impatto facoltativo; fuori vocabolario o senza priorità → riga in errore', async () => {
    const result = await importProblems([
      { external_id: 'P-1', title: 'Disco pieno', priority: 'HIGH', impact: 'medium', workaround: 'pulire /tmp', resolved_at: '2024-03-01T00:00:00Z' },
      { external_id: 'P-2', title: 'Senza priorità' },
      { external_id: 'P-3', title: 'Priorità strana', priority: 'altissima' },
    ], ctx)
    expect(result.created).toBe(1)
    expect(result.errors.map((e) => [e.row, e.messageKey])).toEqual([[2, 'columnRequired'], [3, 'vocabularyUnknown']])
    const params = mergedParams('Problem')
    expect(params['props']).toMatchObject({ priority: 'high', impact: 'medium', workaround: 'pulire /tmp', resolved_at: '2024-03-01T00:00:00.000Z' })
    expect(params['number']).toBe('PRB00000001')
    expect(workflowEngine.createInstance).toHaveBeenCalledWith(mockTx, ctx.tenantId, expect.any(String), 'problem')
  })

  it('change: tipo obbligatorio dal vocabolario change_type, numero anche in code, rischio 0..100; niente assegnatario', async () => {
    mockReads({ users: [{ email: 'mario@acme.it', id: 'u-1' }] })
    const result = await importChanges([
      { external_id: 'C-1', title: 'Patch kernel', change_type: 'Emergency', why: 'CVE', what: 'kernel', aggregate_risk_score: '72', number: 'CHG00000900', assignee_email: 'mario@acme.it' },
      { external_id: 'C-2', title: 'Senza tipo' },
      { external_id: 'C-3', title: 'Rischio fuori scala', change_type: 'normal', aggregate_risk_score: '140' },
    ], ctx)
    expect(result.created).toBe(1)
    expect(result.errors.map((e) => e.messageKey)).toEqual(['columnRequired', 'integerOutOfRange'])
    const call = mockTx.run.mock.calls.find((c) => (c[0] as string).includes('MERGE (n:Change'))!
    expect(call[0]).toContain('n.code       = $number')
    expect(call[1]).toMatchObject({ number: 'CHG00000900', props: { change_type: 'emergency', why: 'CVE', what: 'kernel', aggregate_risk_score: 72 } })
    expect(mockTx.run.mock.calls.filter((c) => (c[0] as string).includes(':ASSIGNED_TO]'))).toHaveLength(0)
    expect(workflowEngine.createInstance).toHaveBeenCalledWith(mockTx, ctx.tenantId, expect.any(String), 'change')
  })

  it('service request: priorità obbligatoria, date di scadenza e completamento, campi del cliente della richiesta', async () => {
    customDefs = [{ name: 'office', label: 'Sede', fieldType: 'string', required: true, enumValues: [], enumTypeName: null, validationScript: null, visibleToEndUser: false, order: 1 }]
    const result = await importServiceRequests([
      { external_id: 'R-1', title: 'Nuovo PC', priority: 'low', due_date: '2024-05-10', office: 'Milano' },
      { external_id: 'R-2', title: 'Data sbagliata', priority: 'low', due_date: 'domani' },
    ], ctx)
    customDefs = []
    expect(result.created).toBe(1)
    expect(result.errors).toEqual([expect.objectContaining({ row: 2, messageKey: 'invalidDate' })])
    const params = mergedParams('ServiceRequest')
    expect(params['props']).toMatchObject({ priority: 'low', due_date: '2024-05-10T00:00:00.000Z' })
    expect(params['customProps']).toEqual({ office: 'Milano' })
    expect(params['number']).toBe('REQ00000001')
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
      { external_id: 'K-1', title: 'Reset Password', severity: 'med' },
      { external_id: 'K-2', title: 'Reset password', status: 'strano', severity: 'med' },
    ], ctx)

    expect(result.created).toBe(2)
    expect(result.warnings).toHaveLength(1) // status sconosciuto → draft
    expect(mergedKBParams(0)['slug']).toBe('reset-password-2')
    expect(mergedKBParams(1)['slug']).toBe('reset-password-3')
    expect(mergedKBParams(0)['status']).toBe('draft') // step iniziale del workflow kb
  })

  it('status published → step con category published; tags separati da ;', async () => {
    await importKBArticles([
      { external_id: 'K-1', title: 'Guida VPN', status: 'Published', tags: 'vpn; rete ;', published_at: '2024-06-01T00:00:00Z', severity: 'med' },
    ], ctx)

    const params = mergedKBParams(0)
    expect(params['status']).toBe('published')
    expect(params['tags']).toBe(JSON.stringify(['vpn', 'rete']))
    expect(params['publishedAt']).toBe('2024-06-01T00:00:00.000Z')
  })

  it('idempotenza: articolo esistente → updated e slug esistente conservato', async () => {
    mockReads({ kbExisting: [{ id: 'kb-1', externalId: 'K-1' }] })

    const result = await importKBArticles([{ external_id: 'K-1', title: 'Guida aggiornata', severity: 'med' }], ctx)

    expect(result.created).toBe(0)
    expect(result.updated).toBe(1)
    expect(mergedKBParams(0)['slug']).toBeNull() // ON CREATE only: slug non toccato
  })

  it('dry-run: nessuna scrittura', async () => {
    const result = await importKBArticles([
      { external_id: 'K-1', title: 'Guida', severity: 'med' },
      { external_id: '',    title: 'Senza id', severity: 'med' },
    ], ctx, { dryRun: true })

    expect(result).toMatchObject({ totalRows: 2, created: 1, updated: 0 })
    expect(result.errors).toHaveLength(1)
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  /** Revisione del 14 set 2026 · F5: la categoria di un articolo importato è una categoria KB del Dizionario. */
  it('categoria fuori dal vocabolario kb_category → riga in errore che la nomina; una valida passa', async () => {
    const result = await importKBArticles([
      { external_id: 'K-1', title: 'Guida', category: 'boh', severity: 'med' },
      { external_id: 'K-2', title: 'Guida DB', category: 'database', severity: 'med' },
    ], ctx)
    expect(result.created).toBe(1)
    expect(result.errors).toEqual([expect.objectContaining({ externalId: 'K-1', message: expect.stringContaining('boh') })])
    expect(mergedKBParams(0)['category']).toBe('database')
  })
})
