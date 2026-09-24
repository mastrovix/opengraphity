/**
 * `ciInputFromFields` on the value shapes the main suite does not send.
 *
 * The CI detail form posts every custom field as TEXT, but the dynamic group
 * criteria and API clients post real JSON values. Both must land on the CI in
 * the type the field declares:
 *  - a value that is already typed (a JSON number, a JSON boolean) passes as
 *    is — re-parsing it as text would reject `8443` as "not a number";
 *  - the text "false" is the boolean false, not a truthy string: otherwise
 *    unticking "HA" in the form would store a value that reads as enabled;
 *  - an update with no customFields at all touches only the base fields, so
 *    renaming a CI never wipes its custom fields.
 */
import { describe, it, expect, vi } from 'vitest'
import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(), toNumber: (v: unknown) => Number(v) }))
vi.mock('../ci-utils.js', () => ({ withSession: vi.fn() }))
vi.mock('../ciMutations.js', () => ({ updateCIRecord: vi.fn() }))

const { ciInputFromFields } = await import('../cmdb.js')

function field(name: string, fieldType: string, label = '') {
  return { id: name, name, label, fieldType, required: false, defaultValue: null, enumValues: [], order: 0, scope: 'tenant', tenantId: 't1', isSystem: false }
}
const SERVER = {
  id: 'ct-srv', name: 'server', label: '', neo4jLabel: 'Server',
  fields: [field('ports', 'number', 'Ports'), field('ha', 'boolean'), field('owner', 'string')],
} as unknown as CITypeWithDefinitions

describe('ciInputFromFields — value shapes', () => {
  it('no customFields: only the base fields that were sent, nulls dropped', () => {
    expect(ciInputFromFields({ name: 'srv-01', status: undefined, notes: null as unknown as string, description: 'db host' }, SERVER))
      .toEqual({ name: 'srv-01', description: 'db host' })
  })

  it('the infrastructure flag of every CI travels as a boolean, false included (24 Sep 2026)', () => {
    expect(ciInputFromFields({ isInfrastructure: true }, SERVER)).toEqual({ isInfrastructure: true })
    expect(ciInputFromFields({ isInfrastructure: false }, SERVER)).toEqual({ isInfrastructure: false })
    expect(ciInputFromFields({ isInfrastructure: null }, SERVER)).toEqual({})
  })

  it('already-typed JSON values pass through untouched', () => {
    expect(ciInputFromFields({ customFields: JSON.stringify({ ports: 8443, ha: false, owner: null }) }, SERVER))
      .toEqual({ ports: 8443, ha: false, owner: null })
  })

  it('the text "false" becomes boolean false', () => {
    expect(ciInputFromFields({ customFields: JSON.stringify({ ha: 'false' }) }, SERVER)).toEqual({ ha: false })
  })

  it('a text field keeps its text, even when it looks like a number', () => {
    expect(ciInputFromFields({ customFields: JSON.stringify({ owner: '42' }) }, SERVER)).toEqual({ owner: '42' })
  })

  it('a blank number is rejected, not stored as 0', () => {
    // Number('  ') is 0: the explicit blank check is what keeps it out.
    expect(() => ciInputFromFields({ customFields: JSON.stringify({ ports: '  ' }) }, SERVER)).toThrow(/Ports: " {2}" is not a number/)
  })

  it('an unknown key on a type without a label names the type by its name', () => {
    expect(() => ciInputFromFields({ customFields: JSON.stringify({ rack: 'A1' }) }, SERVER)).toThrow(/is not a field of type "server"/)
  })

  it('JSON null as customFields is refused as not an object', () => {
    expect(() => ciInputFromFields({ customFields: 'null' }, SERVER)).toThrow(/must be a JSON object/)
  })
})
