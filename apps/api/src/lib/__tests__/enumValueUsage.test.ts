/**
 * lib/enumValueUsage.ts — chi sta usando un valore di un vocabolario
 * (ondata 7 · B7-2 / A-13).
 *
 * Cosa pinna questo test:
 *  - i campi si cercano per NOME del vocabolario, non per id e non per
 *    proprietario del nodo agganciato: la personalizzazione dell'ondata 1 è una
 *    copia per tenant con lo stesso nome, e dal vivo i `USES_ENUM` puntano
 *    tutti ai nodi di UN cliente (C-6) — filtrare troverebbe zero campi su
 *    ogni altro tenant e permetterebbe di togliere un valore ancora in uso;
 *  - `__base__` non è un'etichetta di nodo: i CI sono `ConfigurationItem`;
 *  - la proprietà è lo snake_case del campo, e ci finiscono anche `chain` e
 *    `type` (proprietà riservate ma reali);
 *  - la semantica del ciclo di vita conta come uso.
 */
import { describe, it, expect, vi } from 'vitest'
import { int } from 'neo4j-driver'

vi.mock('../ciLifecycle.js', () => ({
  CI_STATUS_VOCABULARY: 'ci_status',
  lifecyclePolicyReferences: vi.fn(async (_s: unknown, _t: string, value: string) =>
    (value === 'decommissioned' ? ['retired_statuses'] : [])),
}))

const {
  enumValueBindings, countEnumValueUsage, enumValueUsageMessage, replaceEnumValue,
  BASE_TYPE_PLACEHOLDER, BASE_TYPE_LABEL,
} = await import('../enumValueUsage.js')

type Row = Record<string, unknown>
const rec = (m: Row) => ({ keys: Object.keys(m), get: (k: string) => (k in m ? m[k] : null) })

/** Sessione finta: risponde in coda, e registra le query. */
function fakeSession(responses: Row[][]) {
  const queue = [...responses]
  const calls: Array<{ cypher: string; params: Row }> = []
  const run = vi.fn(async (cypher: string, params?: Row) => {
    calls.push({ cypher, params: params ?? {} })
    return { records: (queue.shift() ?? []).map(rec) }
  })
  const tx = { run }
  return {
    calls, run,
    executeRead:  (fn: (t: typeof tx) => unknown) => fn(tx),
    executeWrite: (fn: (t: typeof tx) => unknown) => fn(tx),
  }
}

describe('enumValueBindings', () => {
  it('cerca i campi per NOME del vocabolario, con l\'isolamento sul TIPO; `__base__` → ConfigurationItem; proprietà in snake_case', async () => {
    const s = fakeSession([[
      { label: BASE_TYPE_PLACEHOLDER, typeName: '__base__', fieldName: 'status' },
      { label: 'DatabaseInstance', typeName: 'database_instance', fieldName: 'instanceType' },
    ]])
    const out = await enumValueBindings(s as never, 'acme', 'ci_status')
    expect(out).toEqual([
      { label: BASE_TYPE_LABEL, property: 'status', fieldName: 'status', typeName: '__base__' },
      { label: 'DatabaseInstance', property: 'instance_type', fieldName: 'instanceType', typeName: 'database_instance' },
    ])
    const { cypher, params } = s.calls[0]!
    expect(cypher).toContain('USES_ENUM]->(e:EnumTypeDefinition {name: $name})')
    // Il proprietario del nodo agganciato NON filtra: dal vivo i campi
    // condivisi puntano ai nodi di un solo cliente (C-6), e filtrarlo
    // permetterebbe di togliere un valore ancora in uso su ogni altro tenant.
    expect(cypher).not.toContain("e.tenant_id IN [$tenantId, 'system']")
    expect(cypher).toContain("t.scope IN ['base', 'itil'] OR t.tenant_id = $tenantId")
    // `__base__` è `active = false` per costruzione (dal vivo) e porta il
    // campo `status`: un filtro sull'attivo escluderebbe proprio lui.
    expect(cypher).not.toMatch(/coalesce\(t\.active/)
    expect(params).toEqual({ tenantId: 'acme', name: 'ci_status' })
  })

  it('`chain` e `type` sono proprietà riservate ma REALI: contarle deve funzionare', async () => {
    const s = fakeSession([[
      { label: BASE_TYPE_PLACEHOLDER, typeName: '__base__', fieldName: 'chain' },
      { label: 'Change', typeName: 'change', fieldName: 'type' },
    ]])
    await expect(enumValueBindings(s as never, 'acme', 'ci_chain')).resolves.toEqual([
      { label: BASE_TYPE_LABEL, property: 'chain', fieldName: 'chain', typeName: '__base__' },
      { label: 'Change', property: 'type', fieldName: 'type', typeName: 'change' },
    ])
  })

  it('un\'etichetta non valida è un errore, non un\'interpolazione a occhi chiusi', async () => {
    const s = fakeSession([[{ label: 'Bad Label; MATCH (n) DETACH DELETE n', typeName: 'x', fieldName: 'y' }]])
    await expect(enumValueBindings(s as never, 'acme', 'ci_status')).rejects.toThrow(/invalid Neo4j label/)
  })
})

describe('countEnumValueUsage', () => {
  it('conta i record per tipo e aggiunge la semantica del ciclo di vita fra gli usi', async () => {
    const s = fakeSession([
      [{ label: BASE_TYPE_PLACEHOLDER, typeName: '__base__', fieldName: 'status' }],
      // le due forme in cui `count(...)` può arrivare: `Integer` del driver e
      // `number` normale. Il convertitore è `toNumber` di @opengraphity/neo4j,
      // uno solo — un `.toNumber()` a mano è il difetto che ha rotto
      // `deleteEnumType`.
      [{ value: 'decommissioned', n: int(12) }, { value: 'expired', n: 49 }],
    ])
    const out = await countEnumValueUsage(s as never, 'acme', 'ci_status', ['decommissioned', 'expired', 'mai_usato'])
    expect(out).toEqual([
      { value: 'decommissioned', records: [{ typeName: '__base__', fieldName: 'status', count: 12 }], policyLists: ['retired_statuses'], matrices: [], configSites: [], total: 13 },
      { value: 'expired',        records: [{ typeName: '__base__', fieldName: 'status', count: 49 }], policyLists: [], matrices: [], configSites: [], total: 49 },
    ])
    expect(s.calls[1]!.cypher).toContain('MATCH (n:ConfigurationItem {tenant_id: $tenantId})')
    expect(s.calls[1]!.cypher).toContain('WHERE n.status IN $values')
  })

  it('nessun valore da controllare → nessuna query', async () => {
    const s = fakeSession([])
    await expect(countEnumValueUsage(s as never, 'acme', 'ci_status', [])).resolves.toEqual([])
    expect(s.run).not.toHaveBeenCalled()
  })

  it('un vocabolario che non è `ci_status` non passa dalla semantica del ciclo di vita', async () => {
    const s = fakeSession([
      [{ label: 'Incident', typeName: 'incident', fieldName: 'severity' }],
      [{ value: 'blocker', n: 3 }],
    ])
    const out = await countEnumValueUsage(s as never, 'acme', 'severity', ['blocker'])
    expect(out).toEqual([{ value: 'blocker', records: [{ typeName: 'incident', fieldName: 'severity', count: 3 }], policyLists: [], matrices: [], configSites: [], total: 3 }])
  })
})

describe('enumValueUsageMessage', () => {
  it('dice quanti record, dove, e la via d\'uscita', () => {
    const msg = enumValueUsageMessage('ci_status', [
      { value: 'decommissioned', records: [{ typeName: '__base__', fieldName: 'status', count: 12 }], policyLists: ['retired_statuses'], matrices: [], configSites: [], total: 13 },
    ])
    expect(msg).toContain('The dictionary "ci_status" cannot lose these values')
    expect(msg).toContain('"decommissioned" is still used by 12 __base__.status, the alarm policy (retired_statuses)')
    expect(msg).toContain('replacements: [{from: "…", to: "…"}]')
  })
})

describe('replaceEnumValue', () => {
  it('riscrive i record e le liste della policy nella transazione del chiamante', async () => {
    const policy = { ignore_lifecycle_statuses: ['decommissioned'], retired_statuses: ['inactive', 'decommissioned'], maintenance_statuses: ['maintenance'] }
    const s = fakeSession([
      [{ label: BASE_TYPE_PLACEHOLDER, typeName: '__base__', fieldName: 'status' }],
      [{ n: 12 }],
      [{ raw: JSON.stringify(policy) }],
      [],
    ])
    await expect(replaceEnumValue(s as never, 'acme', 'ci_status', 'decommissioned', 'dismesso')).resolves.toBe(12)
    expect(s.calls[1]!.cypher).toContain('SET n.status = $to')
    expect(s.calls[1]!.params).toMatchObject({ tenantId: 'acme', from: 'decommissioned', to: 'dismesso' })
    expect(JSON.parse(s.calls[3]!.params['policy'] as string)).toEqual({
      ignore_lifecycle_statuses: ['dismesso'],
      retired_statuses:          ['inactive', 'dismesso'],
      maintenance_statuses:      ['maintenance'],
    })
  })

  it('policy che non cita il valore → non la riscrive', async () => {
    const s = fakeSession([
      [{ label: BASE_TYPE_PLACEHOLDER, typeName: '__base__', fieldName: 'status' }],
      [{ n: 0 }],
      [{ raw: JSON.stringify({ retired_statuses: ['inactive'] }) }],
    ])
    await replaceEnumValue(s as never, 'acme', 'ci_status', 'decommissioned', 'dismesso')
    expect(s.calls.some((c) => c.cypher.includes('SET t.event_policy'))).toBe(false)
  })
})

/**
 * Revisione delle otto ondate · C·N-7 / D·N-2 — i due buchi del conteggio.
 *
 * 1. I vocabolari **di dominio** non hanno `USES_ENUM` (non sono campi del
 *    metamodello: sono proprietà sui nodi ITIL). Togliere un valore da
 *    `urgency` era quindi permesso «con zero usi», con migliaia di incident che
 *    lo portavano: il conteggio dava una fiducia che non aveva una base.
 * 2. Le **matrici di dominio** — che l'ondata 7 ha creato, e che si rompono
 *    esattamente così — non erano fra gli usi. Misurato dal vivo: aggiunto
 *    `estremo` a `impact`, completata la matrice `priority`, e poi tolto
 *    `estremo` → accettato senza una parola, lasciando due celle che puntano a
 *    un valore che non esiste più.
 */
describe('il conteggio copre i vocabolari di dominio e le matrici', () => {
  it('`urgency` non ha USES_ENUM, ma i suoi record si contano (Incident, Problem)', async () => {
    const s = fakeSession([
      [],                                        // nessun campo agganciato con USES_ENUM
      [{ value: 'urgente', n: 1200 }],           // Incident.urgency
      [{ value: 'urgente', n: 14 }],             // Problem.urgency
      [],                                        // matrici: nessuna salvata
    ])
    const out = await countEnumValueUsage(s as never, 'acme', 'urgency', ['urgente'])
    expect(out[0]!.records).toEqual([
      { typeName: 'Incident', fieldName: 'urgency', count: 1200 },
      { typeName: 'Problem',  fieldName: 'urgency', count: 14 },
    ])
    expect(out[0]!.total).toBe(1214)
    expect(s.calls[1]!.cypher).toContain('MATCH (n:Incident {tenant_id: $tenantId})')
    expect(s.calls[1]!.cypher).toContain('WHERE n.urgency IN $values')
  })

  it('una cella della matrice che cita il valore è un uso, e il messaggio la nomina', async () => {
    const s = fakeSession([
      [],                                        // nessun USES_ENUM
      [], [], [], [], [],                        // i cinque binding dichiarati di `priority`: nessun record
      [{ kind: 'priority', entries: JSON.stringify({ 'low|low': 'low', 'high|high': 'p1' }) }],
    ])
    const out = await countEnumValueUsage(s as never, 'acme', 'priority', ['p1'])
    expect(out[0]!.matrices).toEqual(['priority (cell "high|high")'])
    expect(out[0]!.total).toBe(1)
    expect(enumValueUsageMessage('priority', out)).toContain('the priority (cell "high|high") matrix')
  })

  it('una CHIAVE della matrice che cita il valore è un uso (il caso misurato dal vivo)', async () => {
    const s = fakeSession([
      [],
      [], [], [],                                // i tre binding dichiarati di `impact`
      // Le matrici che citano `impact` (ingresso in `priority`, uscita in
      // `service_impact`) si leggono in UNA query.
      [
        { kind: 'priority',       entries: JSON.stringify({ 'estremo|low': 'high', 'low|low': 'low' }) },
        { kind: 'service_impact', entries: JSON.stringify({ mission_critical: 'estremo' }) },
      ],
    ])
    const out = await countEnumValueUsage(s as never, 'acme', 'impact', ['estremo'])
    expect(out[0]!.matrices).toEqual([
      'priority (chiave "estremo|low")',
      'service_impact (cell "mission_critical")',
    ])
  })
})

describe('replaceEnumValue riscrive anche matrici e severity_map', () => {
  it('le CHIAVI e le CELLE della matrice (senza questo, la rinomina rompeva la matrice)', async () => {
    const s = fakeSession([
      [],                                        // nessun USES_ENUM
      [], [], [],                                // i tre binding dichiarati di `impact`: nessun record
      [{ raw: JSON.stringify({ severity_map: { info: { impact: 'low', urgency: 'low' }, warning: { impact: 'high', urgency: 'low' }, critical: { impact: 'high', urgency: 'high' } } }) }],
      [],                                        // la scrittura della policy
      [{ kind: 'priority', entries: JSON.stringify({ 'high|low': 'medium', 'low|low': 'low' }) }],
      [],                                        // la scrittura della matrice
    ])
    await replaceEnumValue(s as never, 'acme', 'impact', 'high', 'alto')

    const policy = JSON.parse(s.calls.find((c) => c.cypher.includes('SET t.event_policy'))!.params['policy'] as string) as {
      severity_map: Record<string, { impact: string; urgency: string }>
    }
    // La mappa delle severità: l'impatto rinominato, l'urgenza no (è un altro
    // vocabolario) — era il vicolo cieco C·N-4.
    expect(policy.severity_map['warning']).toEqual({ impact: 'alto', urgency: 'low' })
    expect(policy.severity_map['critical']).toEqual({ impact: 'alto', urgency: 'high' })

    const matrix = JSON.parse(s.calls.find((c) => c.cypher.includes('SET m.entries'))!.params['entries'] as string) as Record<string, string>
    expect(matrix).toEqual({ 'alto|low': 'medium', 'low|low': 'low' })
  })

  it('una matrice che non cita il valore non viene riscritta', async () => {
    const s = fakeSession([
      [], [], [], [],
      [{ raw: null }],
      [{ kind: 'priority', entries: JSON.stringify({ 'low|low': 'low' }) }],
    ])
    await replaceEnumValue(s as never, 'acme', 'impact', 'high', 'alto')
    expect(s.calls.some((c) => c.cypher.includes('SET m.entries'))).toBe(false)
  })
})

/**
 * LE SEDI DI CONFIGURAZIONE (terza revisione · G1).
 *
 * Il danno era silenzioso: rinominando `critical`, la regola «Incident
 * security critico → SecOps» non scattava mai più perché `evaluateConditions`
 * restituiva `false`. Nessun errore, nessun log, e il conteggio diceva zero —
 * quindi anche la RIMOZIONE del valore passava senza una parola.
 *
 * Questa sessione finta SMISTA SUL CYPHER invece di rispondere in coda: la
 * coda è comoda ma cieca, ed è il motivo per cui due test della rinomina
 * dell'ondata 3 non riscrivevano un solo record senza accorgersene.
 */
describe('il perimetro della configurazione', () => {
  interface Scena {
    conditions?: Row[]      // righe di BusinessRule (l'unica sede a condizioni della scena)
    scalar?: Record<string, Row[]>   // righe per PROPRIETA, cosi ogni sede ha le sue
    thresholds?: Row[]      // righe del Tenant
    portal?: Row[]          // righe del Tenant: le severità offerte nel portale
  }

  function smistante(scena: Scena) {
    const scritture: Array<{ cypher: string; params: Row }> = []
    const run = vi.fn(async (cypher: string, params?: Row) => {
      const p = params ?? {}
      if (/SET n\./.test(cypher)) { scritture.push({ cypher, params: p }); return { records: [rec({ n: int(1) })] } }
      if (cypher.includes('USES_ENUM'))            return { records: [] }              // nessun campo CI
      if (cypher.includes(':DomainMatrix'))        return { records: [] }              // nessuna matrice
      if (cypher.includes('AS raw, n.entity_type')) {
        // Solo BusinessRule: AutoTrigger ha la stessa forma, e rispondere a
        // entrambe raddoppierebbe ogni conteggio senza provare niente in piu.
        return { records: (cypher.includes(':BusinessRule') ? (scena.conditions ?? []) : []).map(rec) }
      }
      if (cypher.includes('risk_band_thresholds AS raw')) return { records: (scena.thresholds ?? []).map(rec) }
      if (cypher.includes('portal_severity_options AS raw')) return { records: (scena.portal ?? []).map(rec) }
      const scal = /RETURN n\.([a-z_]+) AS value/.exec(cypher)
      if (scal) return { records: (scena.scalar?.[scal[1]!] ?? []).map(rec) }
      return { records: [] }
    })
    const tx = { run }
    return {
      run, scritture,
      executeRead:  (fn: (t: typeof tx) => unknown) => fn(tx),
      executeWrite: (fn: (t: typeof tx) => unknown) => fn(tx),
    }
  }

  const REGOLA = {
    id: 'br-1', name: 'Incident security critico → SecOps', entityType: 'incident',
    raw: JSON.stringify([
      { field: 'severity', operator: 'equals', value: 'critical' },
      { field: 'category', operator: 'equals', value: 'security' },
    ]),
  }

  it('una condizione di regola che cita il valore lo rende NON rimovibile, e il messaggio nomina la regola', async () => {
    const s = smistante({ conditions: [REGOLA] })
    const out = await countEnumValueUsage(s as never, 'acme', 'severity', ['critical'])
    expect(out).toHaveLength(1)
    expect(out[0]!.configSites).toEqual(['the conditions of a Business Rule «Incident security critico → SecOps»'])
    expect(out[0]!.total).toBe(1)
    expect(enumValueUsageMessage('severity', out)).toContain('Business Rule')
  })

  it('e la rinomina riscrive il JSON della condizione, lasciando in pace le altre', async () => {
    const s = smistante({ conditions: [REGOLA] })
    await replaceEnumValue(s as never, 'acme', 'severity', 'critical', 'critico')
    const w = s.scritture.find((c) => c.cypher.includes('SET n.conditions'))
    expect(w, 'la condizione non è stata riscritta').toBeDefined()
    expect(JSON.parse(String(w!.params['raw']))).toEqual([
      { field: 'severity', operator: 'equals', value: 'critico' },
      { field: 'category', operator: 'equals', value: 'security' },   // intatta
    ])
  })

  it('un campo governato da un ALTRO vocabolario non viene toccato', async () => {
    const s = smistante({ conditions: [REGOLA] })
    // `category` non è `severity`: rinominando severity, la seconda condizione resta.
    const out = await countEnumValueUsage(s as never, 'acme', 'severity', ['security'])
    expect(out).toEqual([])
  })

  it('`status` si risolve con l\'entità della regola', async () => {
    const regola = { id: 'br-2', name: 'R', entityType: 'change',
      raw: JSON.stringify([{ field: 'status', operator: 'equals', value: 'draft' }]) }
    const perChange = await countEnumValueUsage(smistante({ conditions: [regola] }) as never, 'acme', 'status_change', ['draft'])
    expect(perChange).toHaveLength(1)
    const perIncident = await countEnumValueUsage(smistante({ conditions: [regola] }) as never, 'acme', 'status_incident', ['draft'])
    expect(perIncident).toEqual([])
  })

  it('un `value` NUMERICO non è un valore di vocabolario e viene ignorato', async () => {
    // `BusinessRule.priority` dal vivo vale 1.0/2.0/3.0: è l'ordine della regola.
    const regola = { id: 'br-3', name: 'R', entityType: 'incident',
      raw: JSON.stringify([{ field: 'priority', operator: 'equals', value: 2 }]) }
    const out = await countEnumValueUsage(smistante({ conditions: [regola] }) as never, 'acme', 'priority', ['2'])
    expect(out).toEqual([])
  })

  it('un JSON corrotto nelle condizioni non fa esplodere il conteggio', async () => {
    const s = smistante({ conditions: [{ id: 'br-4', name: 'R', entityType: 'incident', raw: '{' }] })
    await expect(countEnumValueUsage(s as never, 'acme', 'severity', ['critical'])).resolves.toEqual([])
  })

  /** IL CRITICO: le soglie delle fasce di rischio. */
  it('le soglie delle fasce di rischio contano come uso, e la rinomina le riscrive', async () => {
    const thresholds = [{ raw: JSON.stringify([
      { band: 'low', upTo: 30 }, { band: 'medium', upTo: 60 }, { band: 'high', upTo: 100 },
    ]) }]
    const out = await countEnumValueUsage(smistante({ thresholds }) as never, 'acme', 'risk_band', ['low'])
    expect(out).toHaveLength(1)
    expect(out[0]!.configSites).toEqual(['the risk band thresholds'])

    const s = smistante({ thresholds })
    await replaceEnumValue(s as never, 'acme', 'risk_band', 'low', 'basso')
    const w = s.scritture.find((c) => c.cypher.includes('SET n.risk_band_thresholds'))
    expect(w, 'le soglie non sono state riscritte: e il critico della terza revisione').toBeDefined()
    expect(JSON.parse(String(w!.params['raw']))).toEqual([
      { band: 'basso', upTo: 30 }, { band: 'medium', upTo: 60 }, { band: 'high', upTo: 100 },
    ])
  })

  /** Verifica «Cosa resta cablato», ondata 1: le severità offerte nel portale. */
  it('le severità offerte nel portale contano come uso, e la rinomina le riscrive con le etichette', async () => {
    const portal = [{ raw: JSON.stringify([
      { value: 'critical', labels: { en: 'It stops my work' } }, { value: 'low', labels: {} },
    ]) }]
    const out = await countEnumValueUsage(smistante({ portal }) as never, 'acme', 'severity', ['critical'])
    expect(out[0]!.configSites).toEqual(['the severities offered in the self-service portal'])

    const s = smistante({ portal })
    await replaceEnumValue(s as never, 'acme', 'severity', 'critical', 'p1')
    const w = s.scritture.find((c) => c.cypher.includes('SET n.portal_severity_options'))
    expect(w, 'le severità del portale non sono state riscritte').toBeDefined()
    expect(JSON.parse(String(w!.params['raw']))).toEqual([
      { value: 'p1', labels: { en: 'It stops my work' } }, { value: 'low', labels: {} },
    ])
  })

  it('una sede scalare col vocabolario nominato da un altro campo si tiene solo se combacia', async () => {
    // FieldVisibilityRule {trigger_field: 'category', trigger_value: 'hardware'}
    const scalar = { trigger_value: [{ value: 'hardware', field: 'category', name: 'Mostra il modello' }] }
    const conCategory = await countEnumValueUsage(smistante({ scalar }) as never, 'acme', 'category', ['hardware'])
    expect(conCategory).toHaveLength(1)
    expect(conCategory[0]!.configSites[0]).toContain('visibility')
    // Con un altro vocabolario la stessa riga non conta: `trigger_field` dice «category».
    const conAltro = await countEnumValueUsage(smistante({ scalar }) as never, 'acme', 'environment', ['hardware'])
    expect(conAltro).toEqual([])
  })
})

