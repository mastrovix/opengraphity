/**
 * The rules that name a deleted field go with it (review of 23 Sep 2026).
 *
 * What matters: requirement rules by `field_name`, visibility rules whether
 * the field triggers them or is their target, only in the tenant and the
 * type, and the count comes back for the Audit Log.
 */
import { describe, it, expect, vi } from 'vitest'
import { deleteFieldRulesOf } from '../fieldRulesOfField.js'

describe('deleteFieldRulesOf', () => {
  it('deletes requirement and visibility rules naming the field, scoped to tenant and type, and counts them', async () => {
    const run = vi.fn(async () => ({ records: [{ get: () => 3 }] }))
    await expect(deleteFieldRulesOf({ run } as never, 't1', 'incident', 'origin')).resolves.toBe(3)
    const [cypher, params] = run.mock.calls[0]! as unknown as [string, Record<string, unknown>]
    expect(cypher).toContain('FieldRequirementRule {tenant_id: $tenantId, entity_type: $entityType, field_name: $fieldName}')
    expect(cypher).toContain('FieldVisibilityRule {tenant_id: $tenantId, entity_type: $entityType}')
    expect(cypher).toContain('vis.trigger_field = $fieldName OR vis.target_field = $fieldName')
    expect(cypher).toContain('DETACH DELETE r')
    expect(params).toEqual({ tenantId: 't1', entityType: 'incident', fieldName: 'origin' })
  })

  it('no rules → 0', async () => {
    const run = vi.fn(async () => ({ records: [{ get: () => 0 }] }))
    await expect(deleteFieldRulesOf({ run } as never, 't1', 'incident', 'origin')).resolves.toBe(0)
  })
})
