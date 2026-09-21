/**
 * Il catalogo delle entità dei report (`navigableGraph`).
 *
 * Personalizzazioni, ondata 8 — A8-4 (B-11, parziale): i valori dello STATO
 * offerti dal costruttore di report sono i PASSI del workflow del cliente, non
 * una lista di fabbrica (`open` non è un passo di nessun workflow).
 *
 * Giro nel browser del 14 set 2026: i ticket vengono dal METAMODELLO ITIL del
 * tenant — tutti e quattro, con i loro campi e vocabolari — e le relazioni
 * sono quelle che i servizi scrivono davvero (`AFFECTED_BY`, `AFFECTS_CI`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const session = { close: vi.fn().mockResolvedValue(undefined), executeRead: vi.fn() }
// `runQuery`: da quando le richieste portano anche i campi della libreria dei
// moduli (ondata 4), `getNavigableEntities` legge la libreria. La finta la
// restituisce vuota per difetto — i test che la vogliono la impostano.
const libreria = vi.fn<() => Promise<Array<Record<string, unknown>>>>(async () => [])
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => session),
  runQuery: vi.fn(async () => await libreria()),
}))
vi.mock('@opengraphity/schema-generator', () => ({ toPascalCase: (s: string) => s.replace(/(^|_)(\w)/g, (_m, _u, c: string) => c.toUpperCase()) }))
// `child`: la finta del logger serve anche ai moduli tirati dentro da
// `catalogForm.ts` (la lingua del tenant), che si fanno un logger figlio.
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(() => log) }
vi.mock('../logger.js', () => ({ logger: log }))
vi.mock('../enumScope.js', () => ({
  enumScopeClause: () => '',
  loadTenantEnumOverrides: vi.fn().mockResolvedValue(new Map()),
  applyEnumOverrides: <T>(rows: T[]) => rows,
}))

const steps = vi.fn<(s: unknown, t: string, e: string) => Promise<Array<{ name: string; stepOrder: number | null }>>>()
vi.mock('../workflowHelpers.js', () => ({ getWorkflowSteps: (s: unknown, t: string, e: string) => steps(s, t, e) }))

const field = (name: string, extra: Record<string, unknown> = {}) => ({ name, label: name, fieldType: 'string', enumValues: [], enumTypeName: null, ...extra })
const ITIL = [
  { name: 'incident', label: 'Incident', neo4jLabel: 'Incident', fields: [field('title'), field('status', { fieldType: 'enum', enumValues: ['new', 'open'] }), field('category', { fieldType: 'enum', enumValues: ['network'], enumTypeName: 'category' })] },
  { name: 'change', label: 'Change', neo4jLabel: 'Change', fields: [field('status', { fieldType: 'enum' })] },
  { name: 'problem', label: 'Problem', neo4jLabel: 'Problem', fields: [field('priority', { fieldType: 'enum', enumValues: ['high'], enumTypeName: 'priority' })] },
  { name: 'service_request', label: 'Service Request', neo4jLabel: 'ServiceRequest', fields: [field('title')] },
]
vi.mock('../itilTypes.js', () => ({ loadITILTypes: vi.fn(async () => ITIL) }))

const { getNavigableEntities } = await import('../navigableGraph.js')
const { logger } = await import('../logger.js')

const STEPS: Record<string, Array<{ name: string; stepOrder: number | null }>> = {
  incident: [
    { name: 'sistemato',  stepOrder: 5 },
    { name: 'nuovo',      stepOrder: 1 },
    { name: 'archiviato', stepOrder: 6 },
    { name: 'su_misura',  stepOrder: null },
  ],
  change: [{ name: 'valutazione', stepOrder: 1 }, { name: 'archiviata', stepOrder: 5 }],
}

type Entities = Array<{ entityType: string; group: string; fields: Array<{ name: string; enumValues: string[]; enumTypeName: string | null }>; relations: Array<{ relationshipType: string; targetNeo4jLabel: string }> }>
const load = async (tenant: string) => await getNavigableEntities(tenant) as never as Entities
const statusOf = (entities: Entities, entityType: string) =>
  entities.find((e) => e.entityType === entityType)!.fields.find((f) => f.name === 'status')!.enumValues

beforeEach(() => {
  vi.clearAllMocks()
  // nessun tipo CI dal metamodello: interessano i ticket
  session.executeRead.mockResolvedValue({ records: [] })
  libreria.mockResolvedValue([])
  steps.mockImplementation(async (_s, _t, entityType) => STEPS[entityType] ?? [])
})

describe('getNavigableEntities — i ticket dal metamodello ITIL', () => {
  it('tutti e quattro i ticket, nel gruppo itsm, con i campi del metamodello e il loro vocabolario', async () => {
    const entities = await load('c-two')
    // I quattro ticket, poi i TASK (20 set 2026): il generico del workflow e
    // i cinque per CI delle change, che prima non si potevano riportare.
    expect(entities.filter((e) => e.group === 'itsm').map((e) => e.entityType)).toEqual([
      'Incident', 'Change', 'Problem', 'ServiceRequest',
      'Task', 'AssessmentTask', 'DeployPlanTask', 'ValidationTest', 'DeploymentTask', 'ReviewTask',
    ])
    const incident = entities.find((e) => e.entityType === 'Incident')!
    // `number` in testa: è del prodotto, non del metamodello (20 set 2026).
    expect(incident.fields.map((f) => f.name)).toEqual(['number', 'title', 'status', 'category'])
    expect(incident.fields.find((f) => f.name === 'category')!.enumTypeName).toBe('category')
    expect(entities.filter((e) => e.group === 'organization').map((e) => e.entityType)).toEqual(['Team', 'User'])
  })

  it('le relazioni sono quelle che i servizi scrivono: AFFECTED_BY per gli incident, AFFECTS_CI per le change', async () => {
    const entities = await load('c-two')
    const rels = (t: string) => entities.find((e) => e.entityType === t)!.relations.map((r) => r.relationshipType)
    expect(rels('Incident')).toContain('AFFECTED_BY')
    expect(rels('Incident')).not.toContain('AFFECTS')
    expect(rels('Change')).toContain('AFFECTS_CI')
    expect(rels('Problem')).toEqual(expect.arrayContaining(['AFFECTS', 'CAUSED_BY', 'RESOLVED_BY']))
  })
})

describe('getNavigableEntities — lo stato viene dal workflow del tenant', () => {
  it('Incident e Change offrono i passi del cliente, in ordine di flusso', async () => {
    const entities = await load('c-two')
    expect(statusOf(entities, 'Incident')).toEqual(['nuovo', 'sistemato', 'archiviato', 'su_misura'])
    expect(statusOf(entities, 'Change')).toEqual(['valutazione', 'archiviata'])
    expect(steps).toHaveBeenCalledWith(session, 'c-two', 'incident')
    expect(steps).toHaveBeenCalledWith(session, 'c-two', 'change')
  })

  it('i valori del metamodello non compaiono: `open` non è un passo di nessun workflow', async () => {
    expect(statusOf(await load('c-two'), 'Incident')).not.toContain('open')
  })

  // c-one ha DUE definizioni incident attive (base e «Security»): l'unione dei
  // passi ripete i nomi in comune. Trovato dal vivo.
  it('due definizioni attive della stessa entità → nomi senza ripetizioni', async () => {
    steps.mockImplementation(async (_s, _t, entityType) => entityType === 'incident'
      ? [...STEPS['incident']!, { name: 'nuovo', stepOrder: 1 }, { name: 'sistemato', stepOrder: 5 }, { name: 'revisione_sicurezza', stepOrder: 2 }]
      : STEPS[entityType] ?? [])
    expect(statusOf(await load('c-one'), 'Incident')).toEqual(['nuovo', 'revisione_sicurezza', 'sistemato', 'archiviato', 'su_misura'])
  })

  it('tenant senza workflow → tendina vuota (testo libero) e un warn, non la lista factory', async () => {
    steps.mockResolvedValue([])
    const entities = await load('c-three')
    expect(statusOf(entities, 'Incident')).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'c-three', entityType: 'Incident' }),
      expect.stringContaining('Nessun passo di workflow'),
    )
  })
})

describe('i campi della libreria dei moduli (ondata 4)', () => {
  const campo = (name: string, fieldType: string, extra: Record<string, unknown> = {}) => ({
    id: name, name, fieldType, label: name.toUpperCase(), labels: null, help: null, helps: null,
    required: false, vocabulary: null, validationScript: null, inList: false,
    createdAt: null, updatedAt: null, ...extra,
  })

  it('si aggiungono alle RICHIESTE, con il loro vocabolario, e solo se diventano una proprietà', async () => {
    libreria.mockResolvedValue([
      campo('ambienti_coinvolti', 'multi_enum', { vocabulary: 'environment' }),
      campo('istruzioni', 'note'),            // niente risposta
      campo('preventivo', 'attachment'),      // un file, non una colonna
      campo('per_chi', 'ref_user'),           // una relazione, non una colonna
    ])
    const entities = await load('t1')
    const richiesta = entities.find((e) => e.entityType === 'ServiceRequest')!
    const nomi = richiesta.fields.map((f) => f.name)
    expect(nomi).toContain('ambienti_coinvolti')
    expect(nomi).not.toContain('istruzioni')
    expect(nomi).not.toContain('preventivo')
    expect(nomi).not.toContain('per_chi')
    expect(richiesta.fields.find((f) => f.name === 'ambienti_coinvolti')!.enumTypeName).toBe('environment')
  })

  it('agli ALTRI ticket non si aggiungono: i moduli del catalogo li compilano solo le richieste', async () => {
    libreria.mockResolvedValue([campo('ambienti_coinvolti', 'multi_enum', { vocabulary: 'environment' })])
    const entities = await load('t1')
    for (const tipo of ['Incident', 'Change', 'Problem']) {
      expect(entities.find((e) => e.entityType === tipo)!.fields.map((f) => f.name)).not.toContain('ambienti_coinvolti')
    }
  })
})

/**
 * L'IDENTIFICATIVO FRA I CAMPI (20 set 2026, dal giro nel browser: «tra le
 * colonne non c'è l'id del ci (in questo caso il numero del ticket)»).
 *
 * `number` di un ticket e `name` di un CI sono proprietà del PRODOTTO: il
 * metamodello non le dichiara, quindi non arrivavano fra i campi navigabili e
 * non si potevano mettere in colonna. Una tabella di incident senza
 * INC00000024 è un elenco di righe che non si sa a cosa si riferiscono.
 */
describe('i campi identificativi delle entità navigabili', () => {
  it('ogni ticket offre «number», ogni task «code», ogni CI «name»', async () => {
    const entita = await load('t1')
    // I TASK hanno un `code`, non un `number`: è il loro identificativo
    // leggibile (TASK00000042), e vale la stessa ragione — una tabella di
    // righe che non si sa a cosa si riferiscono non serve a niente.
    const TASK = ['Task', 'AssessmentTask', 'DeployPlanTask', 'ValidationTest', 'DeploymentTask', 'ReviewTask']
    const ticket = entita.filter((e) => e.group === 'itsm' && !TASK.includes(e.entityType))
    expect(ticket.length).toBeGreaterThan(0)
    for (const e of ticket) {
      expect(e.fields.map((f) => f.name)).toContain('number')
    }
    for (const e of entita.filter((x) => TASK.includes(x.entityType))) {
      expect(e.fields.map((f) => f.name), `${e.entityType} senza codice`).toContain('code')
    }
    for (const e of entita.filter((x) => x.group === 'cmdb')) {
      expect(e.fields.map((f) => f.name)).toContain('name')
    }
  })

  it('«number» porta la chiave i18n del prodotto, non una etichetta inglese fissa', async () => {
    const entita = await load('t1')
    const numero = entita.find((e) => e.entityType === 'Incident')!.fields.find((f) => f.name === 'number')!
    expect(numero.labelKey).toBe('reportBuilder.field.number')
  })
})
