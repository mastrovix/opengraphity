/**
 * I RESOLVER CHE NASCONO DAL METAMODELLO DEL CLIENTE (22 set 2026).
 *
 * ## Perché non c'erano
 * `resolvers/dynamic-ci.ts` stava al 14,6%. È la fabbrica: per ogni tipo di CI
 * che il cliente ha disegnato costruisce una lista, un dettaglio e tre
 * mutation, coi NOMI che ha scelto lui. Non è codice che si legge una volta —
 * è codice che genera l'API di ogni cliente, e quello che fa di sbagliato lo
 * fa su tutti i tipi insieme.
 *
 * ## Le tre decisioni verificate qui
 *  1. **un tipo che non è un tipo si RIFIUTA**: un filtro che non riconosce un
 *     nome e lo ignora mostrerebbe proprio i CI che si voleva togliere;
 *  2. **i campi filtrabili dipendono dai tipi CERCATI**: cinque comuni a tutti
 *     più le proprietà dei tipi davvero interrogati — «costruttore = Dell» su
 *     un tipo che ha il costruttore, e fuori da quei tipi il campo non esiste;
 *  3. **il tenant sta in ogni query**, comprese quelle generate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

const txRun = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({
    executeRead: (fn: (tx: unknown) => unknown) => fn({ run: txRun }),
    close,
  })),
  toNumber: (v: unknown) => (v == null ? 0 : Number(v)),
}))
vi.mock('../ci-utils.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withSession: (fn: (s: unknown) => unknown) => fn({
    executeRead: (w: (tx: unknown) => unknown) => w({ run: txRun }),
  }),
}))

const cacheGet = vi.fn(() => undefined)
const cacheSet = vi.fn()
vi.mock('../../../lib/cache.js', () => ({ cache: { get: (...a: unknown[]) => cacheGet(...a), set: (...a: unknown[]) => cacheSet(...a) } }))

vi.mock('../../../lib/ciMetamodelForTenant.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  impactRelPatternForTenant: vi.fn(async () => 'DEPENDS_ON|RUNS_ON'),
}))

// Le fabbriche vicine hanno i loro test: qui interessa che vengano CHIAMATE
// con il tipo giusto e registrate sotto il nome giusto.
vi.mock('../ciMutations.js', () => ({
  buildCreateMutation: vi.fn((t: { name: string }) => ({ finta: 'create', tipo: t.name })),
  buildUpdateMutation: vi.fn((t: { name: string }) => ({ finta: 'update', tipo: t.name })),
  buildDeleteMutation: vi.fn((t: { name: string }) => ({ finta: 'delete', tipo: t.name })),
}))
vi.mock('../ciFieldResolvers.js', () => ({
  buildFieldResolvers: vi.fn(() => ({ ownerGroup: vi.fn() })),
  mapTeamProps: vi.fn((p: Record<string, unknown>) => ({ id: p['id'] })),
}))
vi.mock('../itilTypeResolvers.js', () => ({
  mapITILField: vi.fn(), fetchITILTypeById: vi.fn(),
  buildITILTypesResolver: vi.fn(() => vi.fn()), buildITILTypeFieldsResolver: vi.fn(() => vi.fn()),
  buildITILFieldValueCountResolver: vi.fn(() => vi.fn()), buildITILMutations: vi.fn(() => ({})),
}))
vi.mock('../ciTypeMetamodel.js', () => ({
  requireMetamodelPermission: vi.fn(), buildCITypesResolver: vi.fn(() => vi.fn()),
  buildBaseCITypeResolver: vi.fn(() => vi.fn()), buildMetamodelMutations: vi.fn(() => ({})),
  ciTypeDeletionImpact: vi.fn(), ciFieldValueCount: vi.fn(),
}))

const { buildDynamicCIResolvers, dynamicCIRootFields } = await import('../dynamic-ci.js')

const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'operator', permissions: new Set() } as never

const campo = (name: string, isSystem = false) => ({ name, isSystem, fieldType: 'text' })
const TIPI = [
  { name: 'virtual_machine', neo4jLabel: 'VirtualMachine', fields: [campo('id', true), campo('vendor'), campo('ramGb')], relations: [] },
  { name: 'printer', neo4jLabel: 'Printer', fields: [campo('id', true), campo('tray')], relations: [] },
] as never as Parameters<typeof buildDynamicCIResolvers>[0]

const rec = (campi: Record<string, unknown>) => ({ get: (k: string) => campi[k] ?? null })

async function codice(fn: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await fn(); return { code: 'NESSUN RIFIUTO', message: '' } } catch (e) {
    const g = e as GraphQLError
    return { code: String(g.extensions?.['code'] ?? 'THROWN'), message: g.message }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  close.mockResolvedValue(undefined)
  cacheGet.mockReturnValue(undefined)
  txRun.mockResolvedValue({ records: [] })
})

const R = () => buildDynamicCIResolvers(TIPI) as {
  Query: Record<string, (a: unknown, b: never, c: never) => Promise<never>>
  Mutation: Record<string, unknown>
}

// ══════════════════════════════════════════════════════════════════════════════
describe('la fabbrica: i nomi li sceglie il cliente', () => {
  it('per ogni tipo nascono lista, dettaglio e tre mutation', () => {
    const r = R()
    expect(Object.keys(r.Query)).toEqual(expect.arrayContaining([
      'virtualMachines', 'virtual_machine', 'printers', 'printer', 'allCIs', 'ciById', 'blastRadius',
    ]))
    expect(Object.keys(r.Mutation)).toEqual(expect.arrayContaining([
      'createVirtualMachine', 'updateVirtualMachine', 'deleteVirtualMachine',
      'createPrinter', 'updatePrinter', 'deletePrinter',
    ]))
  })

  it('`dynamicCIRootFields` elenca ESATTAMENTE quei nomi: la policy non li può scrivere a mano', () => {
    const campi = dynamicCIRootFields(TIPI)
    for (const n of ['Query.virtualMachines', 'Query.virtual_machine', 'Mutation.createPrinter', 'Mutation.deleteVirtualMachine']) {
      expect(campi.has(n), n).toBe(true)
    }
    // E la lista combacia con quello che la fabbrica genera davvero.
    const r = R()
    for (const k of Object.keys(r.Query)) {
      // Fuori: le query GENERICHE (non nascono da un tipo) e quelle del
      // metamodello e dei tipi ITIL, che hanno una policy loro.
      if (!/^(virtualMachines|virtual_machine|printers|printer)$/.test(k)) continue
      expect(campi.has(`Query.${k}`), k).toBe(true)
    }
  })

  it('ogni mutation riceve il SUO tipo, non quello di un altro', () => {
    const r = R()
    expect(r.Mutation['createPrinter']).toEqual({ finta: 'create', tipo: 'printer' })
    expect(r.Mutation['updateVirtualMachine']).toEqual({ finta: 'update', tipo: 'virtual_machine' })
  })
})

describe('allCIs — un tipo che non è un tipo si RIFIUTA', () => {
  it('un nome sconosciuto in `ciTypes` è un errore, non un filtro ignorato', async () => {
    const r = await codice(() => R().Query['allCIs']!(null, { ciTypes: ['stampanti'] } as never, ctx))
    expect(r.code).toBe('BAD_USER_INPUT')
    expect(r.message).toContain('"stampanti" is not a CI type of this tenant')
    expect(txRun).not.toHaveBeenCalled()
  })

  it('e lo stesso per `excludeCiTypes`: ignorarlo mostrerebbe proprio i CI da togliere', async () => {
    expect((await codice(() => R().Query['allCIs']!(null, { excludeCiTypes: ['boh'] } as never, ctx))).code)
      .toBe('BAD_USER_INPUT')
  })

  it('si accetta il nome del tipo o la sua etichetta, senza badare alle maiuscole', async () => {
    for (const nome of ['printer', 'Printer', 'PRINTER']) {
      txRun.mockClear()
      await R().Query['allCIs']!(null, { ciTypes: [nome] } as never, ctx)
      expect(String(txRun.mock.calls[0]![0])).toContain('n:Printer')
      expect(String(txRun.mock.calls[0]![0])).not.toContain('n:VirtualMachine')
    }
  })

  it('escludendo tutto non si interroga il database: lista vuota e basta', async () => {
    const out = await R().Query['allCIs']!(null, { excludeCiTypes: ['printer', 'virtual_machine'] } as never, ctx)
    expect(out).toEqual({ items: [], total: 0 })
    expect(txRun).not.toHaveBeenCalled()
  })
})

describe('allCIs — i campi filtrabili dipendono dai tipi CERCATI', () => {
  it('cercando dentro un tipo preciso si può filtrare su una SUA proprietà', async () => {
    const filtro = JSON.stringify({ rules: [{ field: 'vendor', operator: 'equals', value: 'Dell' }] })
    const r = await codice(() => R().Query['allCIs']!(null, { ciTypes: ['virtual_machine'], filters: filtro } as never, ctx))
    expect(r.code).toBe('NESSUN RIFIUTO')
  })

  it('fuori da quei tipi quel campo non esiste, e il filtro si rifiuta', async () => {
    const filtro = JSON.stringify({ rules: [{ field: 'vendor', operator: 'equals', value: 'Dell' }] })
    const r = await codice(() => R().Query['allCIs']!(null, { ciTypes: ['printer'], filters: filtro } as never, ctx))
    expect(r.code).not.toBe('NESSUN RIFIUTO')
  })

  it('i campi comuni si filtrano sempre', async () => {
    const filtro = JSON.stringify({ rules: [{ field: 'name', operator: 'contains', value: 'srv' }] })
    expect((await codice(() => R().Query['allCIs']!(null, { ciTypes: ['printer'], filters: filtro } as never, ctx))).code)
      .toBe('NESSUN RIFIUTO')
  })
})

describe('le letture generate', () => {
  it('il tenant è in ogni query, e le due sessioni si chiudono', async () => {
    // La prima lettura non restituisce righe, la seconda il conteggio: cosi'
    // non si passa dal mappatore, che qui non e' il punto.
    txRun.mockResolvedValueOnce({ records: [] })
    txRun.mockResolvedValueOnce({ records: [rec({ total: 0 })] })
    await R().Query['virtualMachines']!(null, {} as never, ctx)
    for (const [cypher, params] of txRun.mock.calls as Array<[string, Record<string, unknown>]>) {
      expect(String(cypher)).toContain('tenant_id: $tenantId')
      expect(params['tenantId']).toBe('t1')
    }
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('la riga porta già le squadre: il field resolver non rifà la query', async () => {
    txRun.mockResolvedValueOnce({ records: [rec({
      props: { id: 'ci1', name: 'VM-01', vendor: 'Dell' },
      ogProps: { id: 'team-1' }, sgProps: null,
    })] })
    txRun.mockResolvedValueOnce({ records: [rec({ total: 1 })] })
    const out = await R().Query['virtualMachines']!(null, {} as never, ctx) as unknown as { items: Array<Record<string, unknown>>; total: number }
    expect(out.total).toBe(1)
    expect(out.items[0]).toMatchObject({
      id: 'ci1', name: 'VM-01', vendor: 'Dell', type: 'virtual_machine',
      _ownerGroup: { id: 'team-1' }, _supportGroup: null, _prefetched: true,
    })
  })

  it('un CI che non c\'è è null, non un oggetto a metà', async () => {
    expect(await R().Query['virtual_machine']!(null, { id: 'x' } as never, ctx)).toBeNull()
    expect(await R().Query['ciById']!(null, { id: 'x' } as never, ctx)).toBeNull()
  })

  it('`ciById` riconosce il tipo dall\'etichetta e mappa con QUEL tipo', async () => {
    txRun.mockResolvedValue({ records: [rec({ props: { id: 'p1', name: 'HP-01', tray: 3 }, label: 'Printer' })] })
    expect(await R().Query['ciById']!(null, { id: 'p1' } as never, ctx))
      .toMatchObject({ id: 'p1', type: 'printer', tray: 3 })
  })

  it('un\'etichetta che non è di nessun tipo noto si scarta invece di uscire monca', async () => {
    txRun.mockResolvedValue({ records: [rec({ props: { id: 'x' }, label: 'Sconosciuto' })] })
    expect(await R().Query['ciById']!(null, { id: 'x' } as never, ctx)).toBeNull()
  })

  it('la lista usa la cache per trenta secondi, e una lettura in cache non interroga il grafo', async () => {
    cacheGet.mockReturnValue({ items: [], total: 7 } as never)
    expect(await R().Query['virtualMachines']!(null, {} as never, ctx)).toEqual({ items: [], total: 7 })
    expect(txRun).not.toHaveBeenCalled()
  })
})

describe('blastRadius — le relazioni dell\'impatto sono quelle del CLIENTE', () => {
  it('il pattern arriva dal metamodello, non da una lista scritta qui', async () => {
    await R().Query['blastRadius']!(null, { id: 'ci1' } as never, ctx)
    expect(String(txRun.mock.calls[0]![0])).toContain('[:DEPENDS_ON|RUNS_ON*1..5]')
  })

  it('ogni impattato esce con la distanza e con il padre sul cammino più corto', async () => {
    txRun.mockResolvedValue({ records: [rec({
      props: { id: 'p1', name: 'HP-01' }, label: 'Printer', distance: 2, parentProps: { id: 'mid' },
    })] })
    const out = await R().Query['blastRadius']!(null, { id: 'ci1' } as never, ctx) as unknown as Array<Record<string, unknown>>
    expect(out[0]).toMatchObject({ distance: 2, parentId: 'mid' })
    expect((out[0]!['ci'] as Record<string, unknown>)['type']).toBe('printer')
  })

  it('senza padre il padre è la radice: un vicino diretto viene da lì', async () => {
    txRun.mockResolvedValue({ records: [rec({ props: { id: 'p1' }, label: 'Printer', distance: 1, parentProps: null })] })
    const out = await R().Query['blastRadius']!(null, { id: 'ci1' } as never, ctx) as unknown as Array<Record<string, unknown>>
    expect(out[0]!['parentId']).toBe('ci1')
  })
})
