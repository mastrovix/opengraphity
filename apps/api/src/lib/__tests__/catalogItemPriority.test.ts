/**
 * catalogItemPriority — the configuration diagnostics about catalog items.
 *
 * The portal opens no request from an item without a priority, and an item
 * whose legacy category matched no Dictionary value creates requests without a
 * category. The admin learns about both only from these lists: if they leaked
 * another tenant's items, or dropped the legacy value, the admin could not tell
 * which item to fix or what it used to say.
 */
import { describe, it, expect, vi } from 'vitest'
import { catalogItemsWithoutPriority, catalogItemsWithLegacyCategory } from '../catalogItemPriority.js'

function fakeSession(rows: Array<Record<string, unknown>>) {
  const run = vi.fn(async (_q: string, _p: Record<string, unknown>) => ({ records: rows.map((r) => ({ get: (k: string) => r[k] })) }))
  const session = { executeRead: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ run })) }
  return { session: session as never, run }
}

describe('catalogItemsWithoutPriority', () => {
  it('returns the names of the tenant\'s active items with no priority', async () => {
    const { session, run } = fakeSession([{ name: 'Laptop' }, { name: 'VPN access' }])
    await expect(catalogItemsWithoutPriority(session, 't1')).resolves.toEqual(['Laptop', 'VPN access'])
    const [cypher, params] = run.mock.calls[0]!
    expect(params).toEqual({ tenantId: 't1' })
    // An empty string is "no priority" too, and inactive items are not the admin's problem.
    expect(cypher).toContain("ci.priority IS NULL OR ci.priority = ''")
    expect(cypher).toContain('coalesce(ci.active, true) = true')
  })

  it('an empty list when every item is fine', async () => {
    const { session } = fakeSession([])
    await expect(catalogItemsWithoutPriority(session, 't1')).resolves.toEqual([])
  })
})

describe('catalogItemsWithLegacyCategory', () => {
  it('returns each item with the category text it used to have', async () => {
    const { session, run } = fakeSession([{ name: 'Laptop', legacy: 'Hardwer' }])
    await expect(catalogItemsWithLegacyCategory(session, 't2')).resolves.toEqual([{ name: 'Laptop', legacy: 'Hardwer' }])
    const [cypher, params] = run.mock.calls[0]!
    expect(params).toEqual({ tenantId: 't2' })
    expect(cypher).toContain('ci.legacy_category IS NOT NULL')
  })
})
