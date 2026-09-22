/**
 * LA LETTURA DEL METAMODELLO DEL CLIENTE (22 set 2026).
 *
 * ## Perché
 * `loadMetamodel` e `loadITILTypes` erano il pezzo scoperto di `generator.ts`:
 * sessantotto istruzioni su centoquattro. Sono la porta da cui il metamodello
 * del cliente entra nello schema GraphQL — e la loro intestazione racconta un
 * difetto che è costato caro:
 *
 *   «`mapField` prendeva `enumValues` dalla proprietà INLINE del campo, che è
 *    quella SPEDITA col prodotto. E `addCIField` non scrive mai `enum_values`,
 *    quindi ogni campo enum del CLIENTE arrivava con `enumValues: []`.
 *    Conseguenza: `status: "pizza"` entrava, entrava anche il valore che il
 *    cliente aveva TOLTO, e il form e la scrittura avevano due liste diverse
 *    per lo stesso campo.»
 *
 * Qui si fissa che il vocabolario venga dal nodo AGGANCIATO, e che la
 * personalizzazione del cliente scavalchi quella spedita.
 *
 * E l'altra regola del file: `chain_families` illeggibile **lancia**, non
 * ripiega su una lista vuota — un default inventato cambierebbe in silenzio il
 * calcolo della catena per tutto il tipo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const executeRead = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ executeRead, close })),
}))

const { loadMetamodel, loadITILTypes } = await import('../generator.js')

/** Un `Record` di neo4j finto. */
const rec = (campi: Record<string, unknown>) => ({ get: (k: string) => campi[k] ?? null })
/** Un nodo come lo restituisce il driver. */
const nodo = (props: Record<string, unknown>) => ({ properties: props })

const campo = (over: Record<string, unknown> = {}) => nodo({
  id: 'f1', name: 'stato', label: 'Stato', field_type: 'enum', required: true,
  order: 2, scope: 'tenant', tenant_id: 't1', ...over,
})

const tipo = (over: Record<string, unknown> = {}) => nodo({
  id: 't-vm', name: 'virtual_machine', label: 'VM', icon: 'box', color: '#000',
  scope: 'tenant', tenant_id: 't1', active: true, neo4j_label: 'VirtualMachine', ...over,
})

/** Lo scope dei vocabolari: qui finto, ma con la stessa forma di quello vero. */
const scopeFinto = (overrides: Array<{ id: string; name: string; values: string[] }> = []) => ({
  clause: (v: string) => `WHERE ${v}.scope = 'base'`,
  loadOverrides: vi.fn(async () => new Map(overrides.map((o) => [o.name, o]))),
  applyOverrides: vi.fn(<T extends { enumName: string | null; enumValues: unknown }>(
    rows: readonly T[], m: Map<string, { values: string[] }>,
  ) => rows.map((r) => {
    const o = r.enumName ? m.get(r.enumName) : undefined
    return o ? { ...r, enumValues: o.values } : r
  })),
})

function righe(tipi: Array<Record<string, unknown>>) {
  executeRead.mockImplementation(async (work: (tx: unknown) => unknown) =>
    work({ run: async () => ({ records: tipi.map((t) => rec(t)) }) }))
}

beforeEach(() => {
  vi.clearAllMocks()
  close.mockResolvedValue(undefined)
  executeRead.mockImplementation(async (work: (tx: unknown) => unknown) =>
    work({ run: async () => ({ records: [] }) }))
})

// ══════════════════════════════════════════════════════════════════════════════
describe('loadMetamodel', () => {
  it('nessun tipo: lista vuota, e la sessione si chiude lo stesso', async () => {
    expect(await loadMetamodel('t1', scopeFinto() as never)).toEqual([])
    expect(close).toHaveBeenCalled()
  })

  it('un tipo esce coi nomi dello schema, non con quelli del grafo', async () => {
    righe([{ t: tipo(), typeFieldData: [], baseFieldData: [], relations: [], systemRelations: [] }])
    const [vm] = await loadMetamodel('t1', scopeFinto() as never)
    expect(vm).toMatchObject({
      id: 't-vm', name: 'virtual_machine', neo4jLabel: 'VirtualMachine',
      tenantId: 't1', scope: 'tenant', active: true,
      validationScript: null, serviceRole: null, chainFamilies: [],
    })
  })

  it('A·3.3: il vocabolario viene dal nodo AGGANCIATO, non dalla proprietà spedita', async () => {
    righe([{
      t: tipo(),
      // Il campo porta ANCHE una lista inline: è quella spedita, e non deve vincere.
      typeFieldData: [{ props: campo({ enum_values: '["spedito_a","spedito_b"]' }), enumId: 'e1', enumName: 'ci_status', enumValues: ['agganciato_a', 'agganciato_b'] }],
      baseFieldData: [], relations: [], systemRelations: [],
    }])
    const [vm] = await loadMetamodel('t1', scopeFinto() as never)
    expect(vm!.fields[0]!.enumValues).toEqual(['agganciato_a', 'agganciato_b'])
  })

  it('…e la personalizzazione del CLIENTE scavalca quella agganciata', async () => {
    righe([{
      t: tipo(),
      typeFieldData: [{ props: campo(), enumId: 'e1', enumName: 'ci_status', enumValues: ['base_1', 'base_2'] }],
      baseFieldData: [], relations: [], systemRelations: [],
    }])
    const scope = scopeFinto([{ id: 'e9', name: 'ci_status', values: ['suo_1'] }])
    const [vm] = await loadMetamodel('t1', scope as never)
    // Senza, «il valore che il cliente aveva TOLTO» continuava a entrare.
    expect(vm!.fields[0]!.enumValues).toEqual(['suo_1'])
    expect(scope.loadOverrides).toHaveBeenCalledWith(expect.anything(), 't1')
  })

  it('un vocabolario come stringa JSON si apre lo stesso', async () => {
    righe([{
      t: tipo(),
      typeFieldData: [{ props: campo(), enumId: 'e1', enumName: 'x', enumValues: '["a","b"]' }],
      baseFieldData: [], relations: [], systemRelations: [],
    }])
    const [vm] = await loadMetamodel('t1', scopeFinto() as never)
    expect(vm!.fields[0]!.enumValues).toEqual(['a', 'b'])
  })

  it('i valori assenti prendono il loro difetto, non `undefined`', async () => {
    righe([{
      t: tipo(),
      typeFieldData: [{ props: nodo({ id: 'f', name: 'n', label: 'N', field_type: 'string', scope: 'base', tenant_id: 'system' }), enumId: null, enumName: null, enumValues: null }],
      baseFieldData: [], relations: [], systemRelations: [],
    }])
    const [vm] = await loadMetamodel('t1', scopeFinto() as never)
    expect(vm!.fields[0]).toMatchObject({
      required: false, defaultValue: null, enumValues: [], order: 0,
      validationScript: null, visibilityScript: null, defaultScript: null, isSystem: false,
    })
  })

  it('le righe senza campo si buttano: un OPTIONAL MATCH a vuoto non è un campo', async () => {
    righe([{
      t: tipo(),
      typeFieldData: [{ props: null, enumId: null, enumName: null, enumValues: null }],
      baseFieldData: [], relations: [], systemRelations: [],
    }])
    const [vm] = await loadMetamodel('t1', scopeFinto() as never)
    expect(vm!.fields).toEqual([])
  })

  it('i campi BASE vengono prima di quelli del tipo, e un doppione si tiene una volta sola', async () => {
    // Stesso nome in entrambi: vince il primo dopo l'ordinamento, e il secondo
    // sparisce — altrimenti lo schema avrebbe due campi omonimi e non si
    // assemblerebbe affatto.
    righe([{
      t: tipo(),
      baseFieldData: [{ props: campo({ id: 'b1', name: 'stato', order: 1 }), enumId: null, enumName: null, enumValues: null }],
      typeFieldData: [
        { props: campo({ id: 'f2', name: 'stato', order: 5 }), enumId: null, enumName: null, enumValues: null },
        { props: campo({ id: 'f3', name: 'vendor', order: 3 }), enumId: null, enumName: null, enumValues: null },
      ],
      relations: [], systemRelations: [],
    }])
    const [vm] = await loadMetamodel('t1', scopeFinto() as never)
    expect(vm!.fields.map((f) => [f.id, f.name])).toEqual([['b1', 'stato'], ['f3', 'vendor']])
  })

  it('le righe vuote di relazioni si buttano, e le relazioni escono ORDINATE', async () => {
    righe([{
      t: tipo(), typeFieldData: [], baseFieldData: [],
      relations: [
        null,
        nodo({ id: 'r2', name: 'b', label: 'B', relationship_type: 'B_ON', target_type: 's', cardinality: 'many', direction: 'out', order: 5 }),
        nodo({ id: 'r1', name: 'a', label: 'A', relationship_type: 'A_ON', target_type: 's', cardinality: 'many', direction: 'out', order: 1 }),
      ],
      systemRelations: [null],
    }])
    const [vm] = await loadMetamodel('t1', scopeFinto() as never)
    expect(vm!.relations.map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(vm!.systemRelations).toEqual([])
  })

  it('relazioni e relazioni di sistema escono coi nomi dello schema', async () => {
    righe([{
      t: tipo(),
      typeFieldData: [], baseFieldData: [],
      relations: [nodo({ id: 'r1', name: 'dipende', label: 'Dipende', relationship_type: 'DEPENDS_ON', target_type: 'server', cardinality: 'many', direction: 'out', order: 1 })],
      systemRelations: [nodo({ id: 's1', name: 'owner', label: 'Owner', relationship_type: 'OWNED_BY', target_type: 'Team', cardinality: 'one', direction: 'out', order: 0 })],
    }])
    const [vm] = await loadMetamodel('t1', scopeFinto() as never)
    expect(vm!.relations[0]).toMatchObject({ relationshipType: 'DEPENDS_ON', targetType: 'server' })
    expect(vm!.systemRelations[0]).toMatchObject({ relationshipType: 'OWNED_BY' })
  })
})

describe('chain_families — illeggibile LANCIA, non ripiega', () => {
  const conChain = (valore: unknown) => righe([{
    t: tipo({ chain_families: valore }),
    typeFieldData: [], baseFieldData: [], relations: [], systemRelations: [],
  }])

  it('assente: nessuna famiglia', async () => {
    conChain(null)
    expect((await loadMetamodel('t1', scopeFinto() as never))[0]!.chainFamilies).toEqual([])
  })

  it('lista o stringa JSON: si legge', async () => {
    conChain(['rete'])
    expect((await loadMetamodel('t1', scopeFinto() as never))[0]!.chainFamilies).toEqual(['rete'])
    conChain('["rete","storage"]')
    expect((await loadMetamodel('t1', scopeFinto() as never))[0]!.chainFamilies).toEqual(['rete', 'storage'])
  })

  it('JSON rotto, o che non è una lista, o di un tipo inatteso: si LANCIA', async () => {
    // Un default inventato cambierebbe in silenzio il calcolo della catena
    // per tutto il tipo.
    conChain('{non json')
    await expect(loadMetamodel('t1', scopeFinto() as never)).rejects.toThrow()
    conChain('{"a":1}')
    await expect(loadMetamodel('t1', scopeFinto() as never)).rejects.toThrow(/is not an array/)
    conChain(42)
    await expect(loadMetamodel('t1', scopeFinto() as never)).rejects.toThrow(/unexpected type/)
  })
})

describe('loadITILTypes', () => {
  it('nessun tipo ITIL: lista vuota', async () => {
    expect(await loadITILTypes('t1', scopeFinto() as never)).toEqual([])
    expect(close).toHaveBeenCalled()
  })

  it('un tipo ITIL porta i suoi campi col vocabolario personalizzato', async () => {
    // I tipi ITIL hanno una forma loro: `fieldData`, non `typeFieldData`, e
    // nessuna relazione (non sono CI, sono i tipi di ticket).
    righe([{
      t: tipo({ scope: 'itil', name: 'incident' }),
      fieldData: [{ props: campo({ name: 'priority' }), enumId: 'e1', enumName: 'priority', enumValues: ['p1'] }],
    }])
    const scope = scopeFinto([{ id: 'e9', name: 'priority', values: ['bassa', 'alta'] }])
    const [inc] = await loadITILTypes('t1', scope as never)
    expect(inc!.name).toBe('incident')
    expect(inc!.fields[0]!.enumValues).toEqual(['bassa', 'alta'])
  })
})

/**
 * I DUE RICONOSCITORI, e il ramo che non deve mai scattare (22 set 2026).
 *
 * `isCIFieldType` è la porta documentata dell'API: il disegnatore offre solo i
 * cinque tipi buoni, ma l'API è una via che usano script e integrazioni, e un
 * tipo sconosciuto faceva fallire l'ASSEMBLAGGIO dello schema — cioè ogni
 * query dell'intero tenant — con un motivo che non diceva nemmeno quale campo.
 *
 * `cloneReservedNames` è la copia che la verifica dei nomi fa prima di
 * aggiungere i suoi: senza, sporcherebbe la cache del chiamante e il secondo
 * tenant si vedrebbe rifiutare i nomi del primo.
 */
describe('i riconoscitori dei tipi di campo', () => {
  it('i cinque buoni passano, tutto il resto no', async () => {
    const { isCIFieldType, CI_FIELD_TYPES } = await import('../generator.js')
    expect([...CI_FIELD_TYPES].sort()).toEqual(['boolean', 'date', 'enum', 'number', 'string'])
    for (const t of CI_FIELD_TYPES) expect(isCIFieldType(t), t).toBe(true)
    for (const storto of ['text', 'json', '', null, 42, undefined]) {
      expect(isCIFieldType(storto), String(storto)).toBe(false)
    }
  })
})

describe('cloneReservedNames', () => {
  it('è una COPIA: la verifica aggiunge i suoi nomi e non sporca la cache del chiamante', async () => {
    const { cloneReservedNames, emptyReservedNames } = await import('../nameValidation.js')
    const originale = emptyReservedNames()
    originale.types.set('Incident', 'base')
    originale.queryFields.set('incidents', 'base')
    originale.mutationFields.set('createIncident', 'base')

    const copia = cloneReservedNames(originale)
    copia.types.set('VirtualMachine', 'tenant')
    copia.queryFields.set('virtualMachines', 'tenant')
    copia.mutationFields.set('createVirtualMachine', 'tenant')

    // L'originale non si è mosso: il tenant dopo non eredita i nomi di questo.
    expect([...originale.types.keys()]).toEqual(['Incident'])
    expect([...originale.queryFields.keys()]).toEqual(['incidents'])
    expect([...originale.mutationFields.keys()]).toEqual(['createIncident'])
    // E la copia porta entrambi.
    expect(copia.types.get('Incident')).toBe('base')
    expect(copia.types.get('VirtualMachine')).toBe('tenant')
  })
})
