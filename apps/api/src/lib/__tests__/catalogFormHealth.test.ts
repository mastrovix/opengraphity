/**
 * Published catalog forms that can no longer be filled in.
 *
 * Why this matters: publishing refuses impossible forms, but a form published
 * BEFORE a rule existed, or one whose library field was deleted afterwards,
 * stays as it is. Without this check the first person to learn about it is the
 * end user opening the request on the portal, who cannot fix it and gives up.
 * The diagnostics page reads this list, so it must:
 *  - name the catalog item and the exact fields to touch;
 *  - report the two failure modes separately (missing from the library /
 *    required but hidden from the portal), because the fix is different;
 *  - not invent problems: drafts, unreadable documents and healthy forms are
 *    not reported;
 *  - stay inside the tenant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Session } from 'neo4j-driver'

const runQuery = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({
  runQuery: (...a: unknown[]) => runQuery(...a),
  runQueryOne: vi.fn(),
  getSession: vi.fn(),
}))
const formFields = vi.fn()
vi.mock('../catalogForm.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../catalogForm.js')>()),
  formFields: (...a: unknown[]) => formFields(...a),
}))

const { catalogFormsToFix } = await import('../catalogFormHealth.js')

const session = {} as Session

/** A library field as `formFields` returns it: only what this check reads matters. */
const field = (name: string, required = false) => ({ name, required })

type Item = { field: string; required?: boolean; endUser?: boolean }
const form = (items: Item[], revision = 1) => JSON.stringify({
  version: 1, revision,
  sections: [{ id: 'main', title: { en: 'Main', it: 'Principale' }, items }],
})

beforeEach(() => {
  vi.clearAllMocks()
  formFields.mockResolvedValue([])
})

describe('catalogFormsToFix', () => {
  it('reads only active items with a form, of THIS tenant', async () => {
    runQuery.mockResolvedValueOnce([])
    await catalogFormsToFix(session, 'tenant-1')
    const [s, cypher, params] = runQuery.mock.calls[0] as [unknown, string, Record<string, unknown>]
    expect(s).toBe(session)
    expect(cypher).toContain('ServiceCatalogItem {tenant_id: $tenantId}')
    expect(cypher).toContain('coalesce(i.active, true) = true')
    expect(params).toEqual({ tenantId: 'tenant-1' })
  })

  it('with no forms at all it does not read the field library', async () => {
    runQuery.mockResolvedValueOnce([])
    await expect(catalogFormsToFix(session, 'tenant-1')).resolves.toEqual([])
    expect(formFields).not.toHaveBeenCalled()
  })

  it('reports fields that are no longer in the library, by item name', async () => {
    runQuery.mockResolvedValueOnce([{ name: 'New laptop', form: form([{ field: 'model' }, { field: 'gone' }, { field: 'also_gone' }]) }])
    formFields.mockResolvedValueOnce([field('model')])
    await expect(catalogFormsToFix(session, 'tenant-1')).resolves.toEqual([
      { item: 'New laptop', reason: 'fieldsMissing', fields: ['gone', 'also_gone'] },
    ])
    expect(formFields).toHaveBeenCalledWith(session, 'tenant-1')
  })

  it('reports a required field that the portal never asks for', async () => {
    // The end user can never submit this form: the server requires a value
    // that the portal does not offer.
    runQuery.mockResolvedValueOnce([{ name: 'Access', form: form([
      { field: 'lib_required', endUser: false },                 // required by the library
      { field: 'item_required', required: true, endUser: false }, // required by the item override
      { field: 'optional_here', required: false, endUser: false }, // the item override wins over the library
      { field: 'shown', endUser: true },
    ]) }])
    formFields.mockResolvedValueOnce([
      field('lib_required', true), field('item_required'), field('optional_here', true), field('shown', true),
    ])
    await expect(catalogFormsToFix(session, 'tenant-1')).resolves.toEqual([
      { item: 'Access', reason: 'requiredNotForEndUser', fields: ['lib_required', 'item_required'] },
    ])
  })

  it('a missing field is reported once, as missing, not again as "not asked"', async () => {
    runQuery.mockResolvedValueOnce([{ name: 'X', form: form([{ field: 'gone', required: true, endUser: false }]) }])
    await expect(catalogFormsToFix(session, 'tenant-1')).resolves.toEqual([
      { item: 'X', reason: 'fieldsMissing', fields: ['gone'] },
    ])
  })

  it('one item can carry both problems, reported as two separate entries', async () => {
    runQuery.mockResolvedValueOnce([{ name: 'Both', form: form([{ field: 'gone' }, { field: 'req', endUser: false }]) }])
    formFields.mockResolvedValueOnce([field('req', true)])
    const out = await catalogFormsToFix(session, 'tenant-1')
    expect(out.map((o) => o.reason)).toEqual(['fieldsMissing', 'requiredNotForEndUser'])
  })

  it('does not invent problems: drafts, empty forms, unreadable documents and healthy forms are skipped', async () => {
    runQuery.mockResolvedValueOnce([
      { name: 'Draft', form: form([{ field: 'gone' }], 0) }, // never published: revision 0
      { name: 'Empty', form: '' },
      { name: 'Corrupt', form: '{not json' },               // parseCatalogForm reports this elsewhere
      { name: 'Healthy', form: form([{ field: 'ok', endUser: false }]) },
    ])
    formFields.mockResolvedValueOnce([field('ok', false)])
    await expect(catalogFormsToFix(session, 'tenant-1')).resolves.toEqual([])
  })
})
