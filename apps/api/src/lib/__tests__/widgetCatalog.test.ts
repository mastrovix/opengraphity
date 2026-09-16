/**
 * Il catalogo dei widget dal metamodello (ondata 5 di «Nulla cablato»): tipi
 * e campi del cliente compresi, i numerici per medie e somme, e niente che non
 * diventi una proprietà sicura.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(() => ({ close: vi.fn() })) }))
/**
 * La libreria dei moduli del catalogo (ondata 5): il catalogo la legge per
 * aggiungere i suoi campi alle RICHIESTE. Per difetto vuota; i test che la
 * vogliono la impostano.
 */
const libreria = vi.fn<() => Promise<unknown[]>>(async () => [])
vi.mock('../catalogForm.js', () => ({ formFields: () => libreria() }))
vi.mock('../itilTypes.js', () => ({
  loadITILTypes: vi.fn(async () => [
    { name: 'change', label: 'Change', neo4jLabel: 'Change', fields: [
      { name: 'title', label: 'Title', fieldType: 'string', isSystem: true },
      { name: 'type', label: 'Type', fieldType: 'enum', isSystem: true, enumTypeName: 'change_type', enumValues: ['normal'] },
      { name: 'risk', label: 'Risk', fieldType: 'enum', isSystem: true },
      { name: 'scheduled_start', label: 'Start', fieldType: 'date', isSystem: true },
      { name: 'outcome', label: 'Outcome', fieldType: 'enum', isSystem: false, enumTypeName: 'change_outcome' },
    ] },
    { name: 'incident', label: 'Incident', neo4jLabel: 'Incident', fields: [
      { name: 'priority', label: 'Priority', fieldType: 'enum', isSystem: true },
      { name: 'contact_phone', label: 'Phone', fieldType: 'string', isSystem: false },
      { name: 'downtime_minutes', label: 'Downtime', fieldType: 'number', isSystem: false },
    ] },
    { name: 'service_request', label: 'Service Request', neo4jLabel: 'ServiceRequest', fields: [
      { name: 'priority', label: 'Priority', fieldType: 'enum', isSystem: true },
    ] },
  ]),
}))
vi.mock('@opengraphity/schema-generator', () => ({
  loadMetamodel: vi.fn(async () => [
    { name: 'firewall', label: 'Firewall', neo4jLabel: 'Firewall', scope: 'tenant', fields: [
      { name: 'status', label: 'Status', fieldType: 'enum', isSystem: true, scope: 'base' },
      { name: 'name', label: 'Name', fieldType: 'string', isSystem: true, scope: 'base' },
      { name: 'ramGb', label: 'RAM', fieldType: 'number', isSystem: false, scope: 'tenant' },
      { name: 'bad-name', label: 'Bad', fieldType: 'enum', isSystem: false, scope: 'tenant' },
    ] },
    { name: 'server', label: 'Server', neo4jLabel: 'Server', scope: 'base', fields: [
      { name: 'os', label: 'OS', fieldType: 'enum', isSystem: false, scope: 'base' },
    ] },
  ]),
}))

const { widgetCatalog, clearWidgetCatalogCache } = await import('../widgetCatalog.js')

describe('widgetCatalog', () => {
  it('ticket e CI del cliente, con i loro campi', async () => {
    const catalog = await widgetCatalog('t1')
    expect(catalog.map((e) => `${e.group}:${e.entityType}`)).toEqual(['itsm:change', 'itsm:incident', 'itsm:service_request', 'cmdb:firewall', 'cmdb:server'])
    const change = catalog.find((e) => e.entityType === 'change')!
    // titolo (testo di sistema), data e il `risk` che la change non salva restano fuori
    expect(change.fields.map((f) => f.name)).toEqual(['type', 'outcome', 'aggregate_risk_score'])
    expect(change.fields.find((f) => f.name === 'type')).toMatchObject({ property: 'change_type', groupable: true, custom: false })
    expect(change.fields.find((f) => f.name === 'outcome')).toMatchObject({ custom: true, groupable: true })
    expect(change.fields.find((f) => f.name === 'aggregate_risk_score')).toMatchObject({ numeric: true, groupable: false })
  })

  it('i numerici del cliente servono a medie e somme; i testi del cliente si raggruppano', async () => {
    const catalog = await widgetCatalog('t1')
    const incident = catalog.find((e) => e.entityType === 'incident')!
    expect(incident.fields.find((f) => f.name === 'priority')?.property).toBe('severity')
    expect(incident.fields.find((f) => f.name === 'contact_phone')).toMatchObject({ groupable: true, numeric: false })
    expect(incident.fields.find((f) => f.name === 'downtime_minutes')).toMatchObject({ groupable: false, numeric: true })
    const firewall = catalog.find((e) => e.entityType === 'firewall')!
    expect(firewall.fields.map((f) => [f.name, f.property, f.numeric])).toEqual([['status', 'status', false], ['ramGb', 'ram_gb', true]])
  })
})

/**
 * I campi della libreria dei moduli del catalogo (ondata 5). «Quanti portatili
 * per ambiente» era un filtro e una colonna, ma non un widget: il catalogo si
 * costruiva dal solo metamodello, e la libreria dei moduli non è lì.
 */
describe('widgetCatalog e i campi dei moduli del catalogo', () => {
  const campo = (name: string, fieldType: string, vocabulary: string | null = null) =>
    ({ id: name, name, fieldType, label: name.toUpperCase(), labels: [], help: null, helps: [], required: false,
       vocabulary, validationScript: null, inList: false, createdAt: null, updatedAt: null })

  it('si aggiungono alle RICHIESTE e non agli altri ticket', async () => {
    libreria.mockResolvedValue([campo('ambiente_uso', 'enum', 'environment'), campo('costo_stimato', 'number')])
    clearWidgetCatalogCache()
    const catalog = await widgetCatalog('t1')
    const richiesta = catalog.find((e) => e.entityType === 'service_request')!
    expect(richiesta.fields.find((f) => f.name === 'ambiente_uso')).toMatchObject({ groupable: true, numeric: false, enumTypeName: 'environment', property: 'ambiente_uso' })
    expect(richiesta.fields.find((f) => f.name === 'costo_stimato')).toMatchObject({ groupable: false, numeric: true })
    expect(catalog.find((e) => e.entityType === 'incident')!.fields.map((f) => f.name)).not.toContain('ambiente_uso')
  })

  it('fuori: la selezione multipla (un count su una lista conterebbe le liste), le note, i file e i riferimenti', async () => {
    libreria.mockResolvedValue([
      campo('ambienti_coinvolti', 'multi_enum', 'environment'),
      campo('istruzioni', 'note'), campo('preventivo', 'attachment'), campo('per_chi', 'ref_user'),
      campo('quando', 'date'),
    ])
    clearWidgetCatalogCache()
    const catalog = await widgetCatalog('t1')
    const nomi = catalog.find((e) => e.entityType === 'service_request')!.fields.map((f) => f.name)
    for (const fuori of ['ambienti_coinvolti', 'istruzioni', 'preventivo', 'per_chi', 'quando']) {
      expect(nomi).not.toContain(fuori)
    }
  })

  it('un nome che il metamodello ha già vince: è quello che il ticket scrive davvero', async () => {
    libreria.mockResolvedValue([campo('priority', 'text')])
    clearWidgetCatalogCache()
    const catalog = await widgetCatalog('t1')
    const priority = catalog.find((e) => e.entityType === 'service_request')!.fields.filter((f) => f.name === 'priority')
    expect(priority).toHaveLength(1)
    expect(priority[0]).toMatchObject({ fieldType: 'enum' })
  })
})
