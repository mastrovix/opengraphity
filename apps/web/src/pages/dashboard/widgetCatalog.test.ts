/**
 * Verifica «Cosa resta cablato», ondata 5: il pannello dei widget offre i campi
 * del catalogo del cliente — numerici per medie e somme, gli altri per contare.
 */
import { describe, it, expect } from 'vitest'
import { groupByFieldsFor, type WidgetCatalogEntity } from './useWidgetConfig'

const field = (name: string, groupable: boolean, numeric: boolean) =>
  ({ name, label: name, fieldType: numeric ? 'number' : 'enum', enumValues: [], enumTypeName: null, groupable, numeric, custom: true })

describe('groupByFieldsFor', () => {
  const firewall: WidgetCatalogEntity = { entityType: 'firewall', label: 'Firewall', group: 'cmdb', fields: [field('zona', true, false), field('ramGb', false, true)] }
  it('conteggio per campo: i raggruppabili; media e somma: i numerici', () => {
    expect(groupByFieldsFor(firewall, 'count_by_field').map((f) => f.name)).toEqual(['zona'])
    expect(groupByFieldsFor(firewall, 'avg_field').map((f) => f.name)).toEqual(['ramGb'])
    expect(groupByFieldsFor(firewall, 'sum_field').map((f) => f.name)).toEqual(['ramGb'])
    expect(groupByFieldsFor(undefined, 'count_by_field')).toEqual([])
  })
})
