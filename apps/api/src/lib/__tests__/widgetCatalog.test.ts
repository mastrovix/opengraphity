/**
 * Il catalogo dei widget dal metamodello (ondata 5 di «Nulla cablato»): tipi
 * e campi del cliente compresi, i numerici per medie e somme, e niente che non
 * diventi una proprietà sicura.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(() => ({ close: vi.fn() })) }))
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

const { widgetCatalog } = await import('../widgetCatalog.js')

describe('widgetCatalog', () => {
  it('ticket e CI del cliente, con i loro campi', async () => {
    const catalog = await widgetCatalog('t1')
    expect(catalog.map((e) => `${e.group}:${e.entityType}`)).toEqual(['itsm:change', 'itsm:incident', 'cmdb:firewall', 'cmdb:server'])
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
