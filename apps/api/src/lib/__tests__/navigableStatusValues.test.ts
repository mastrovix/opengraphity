/**
 * Personalizzazioni, ondata 8 — A8-4 (B-11, parziale): i valori dello STATO
 * offerti dal costruttore di report sono i PASSI del workflow del cliente.
 *
 * `navigableGraph` aveva due liste fisse: per gli incident `open, assigned,
 * in_progress, resolved, closed` (dove `open` non è un passo di nessun
 * workflow) e per le change `draft, pending_approval, approved, in_progress,
 * completed, failed, cancelled` (di cui solo un paio esistono). Risultato: un
 * filtro di report sullo stato offriva valori che il grafo non contiene e non
 * offriva quelli veri — né i passi aggiunti dal cliente.
 *
 * Nessun ripiego sulla lista di fabbrica: senza workflow la tendina resta
 * vuota e il costruttore mostra un campo di testo libero, invece di suggerire
 * stati inesistenti.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const session = { close: vi.fn().mockResolvedValue(undefined), executeRead: vi.fn() }
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(() => session) }))
vi.mock('@opengraphity/schema-generator', () => ({ toPascalCase: (s: string) => s }))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const steps = vi.fn<(s: unknown, t: string, e: string) => Promise<Array<{ name: string; stepOrder: number | null }>>>()
vi.mock('../workflowHelpers.js', () => ({ getWorkflowSteps: (s: unknown, t: string, e: string) => steps(s, t, e) }))

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

beforeEach(() => {
  vi.clearAllMocks()
  // nessun tipo CI dal metamodello: interessano le entità fisse
  session.executeRead.mockResolvedValue({ records: [] })
  steps.mockImplementation(async (_s, _t, entityType) => STEPS[entityType] ?? [])
})

const statusOf = (entities: Array<{ entityType: string; fields: Array<{ name: string; enumValues: string[] }> }>, entityType: string) =>
  entities.find((e) => e.entityType === entityType)!.fields.find((f) => f.name === 'status')!.enumValues

describe('getNavigableEntities — lo stato viene dal workflow del tenant', () => {
  it('Incident e Change offrono i passi del cliente, in ordine di flusso', async () => {
    const entities = await getNavigableEntities('c-two') as never as Array<{ entityType: string; fields: Array<{ name: string; enumValues: string[] }> }>
    expect(statusOf(entities, 'Incident')).toEqual(['nuovo', 'sistemato', 'archiviato', 'su_misura'])
    expect(statusOf(entities, 'Change')).toEqual(['valutazione', 'archiviata'])
    expect(steps).toHaveBeenCalledWith(session, 'c-two', 'incident')
    expect(steps).toHaveBeenCalledWith(session, 'c-two', 'change')
  })

  it('i valori di fabbrica non compaiono più: `open` non è un passo di nessun workflow', async () => {
    const entities = await getNavigableEntities('c-two') as never as Array<{ entityType: string; fields: Array<{ name: string; enumValues: string[] }> }>
    expect(statusOf(entities, 'Incident')).not.toContain('open')
    expect(statusOf(entities, 'Change')).not.toContain('pending_approval')
  })

  // c-one ha DUE definizioni incident attive (base e «Security»): l'unione dei
  // passi ripete i nomi in comune, e una tendina con «resolved» due volte è
  // peggio di una lista fissa. Trovato dal vivo.
  it('due definizioni attive della stessa entità → nomi senza ripetizioni', async () => {
    steps.mockImplementation(async (_s, _t, entityType) => entityType === 'incident'
      ? [...STEPS['incident']!, { name: 'nuovo', stepOrder: 1 }, { name: 'sistemato', stepOrder: 5 }, { name: 'revisione_sicurezza', stepOrder: 2 }]
      : STEPS[entityType] ?? [])
    const entities = await getNavigableEntities('c-one') as never as Array<{ entityType: string; fields: Array<{ name: string; enumValues: string[] }> }>
    expect(statusOf(entities, 'Incident')).toEqual(['nuovo', 'revisione_sicurezza', 'sistemato', 'archiviato', 'su_misura'])
  })

  it('entità senza workflow (Team, User, ChangeTask) non vengono toccate', async () => {
    const entities = await getNavigableEntities('c-two') as never as Array<{ entityType: string; fields: Array<{ name: string; enumValues: string[] }> }>
    expect(statusOf(entities, 'ChangeTask')).toEqual(['pending', 'in_progress', 'completed', 'failed', 'skipped', 'rejected'])
    expect(steps).toHaveBeenCalledTimes(2)
  })

  it('tenant senza workflow → tendina vuota (testo libero) e un warn, non la lista di fabbrica', async () => {
    steps.mockResolvedValue([])
    const entities = await getNavigableEntities('c-three') as never as Array<{ entityType: string; fields: Array<{ name: string; enumValues: string[] }> }>
    expect(statusOf(entities, 'Incident')).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'c-three', entityType: 'Incident' }),
      expect.stringContaining('Nessun passo di workflow'),
    )
  })
})
