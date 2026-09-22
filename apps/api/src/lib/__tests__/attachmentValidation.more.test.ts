/**
 * Uploads to a catalog form DRAFT: the one attachment target with no node.
 *
 * Why it matters: a draft skips the existence check, and that check is also
 * the access check ("this ticket is yours"). What keeps the draft path narrow
 * is that it is recognised only by its entity type, that it must say which
 * form field the file answers (so the claim step can bind it), and that a
 * field name on any other upload is refused instead of being stored and then
 * ignored. The UUID is lower-cased so the storage path is one per entity.
 */
import { describe, it, expect } from 'vitest'
import {
  FORM_DRAFT_ENTITY_TYPE,
  validateAttachmentFieldName,
  validateAttachmentTarget,
  entityExistsCypher,
} from '../attachmentValidation.js'
import { ValidationError } from '../errors.js'

const UUID = '6F1A2B3C-4D5E-4F60-8A7B-9C0D1E2F3A4B'

describe('validateAttachmentFieldName', () => {
  it('requires a field name on a form draft upload and returns it', () => {
    expect(validateAttachmentFieldName(FORM_DRAFT_ENTITY_TYPE, 'contract_scan')).toBe('contract_scan')
  })

  it('refuses a draft upload without a valid field name', () => {
    for (const bad of [undefined, null, '', 42, 'Contract', '1abc', 'a', 'x'.repeat(41), 'bad-name']) {
      expect(() => validateAttachmentFieldName(FORM_DRAFT_ENTITY_TYPE, bad), String(bad)).toThrow(ValidationError)
    }
  })

  it('refuses a field name on a non-draft upload, but tolerates an absent or empty one', () => {
    expect(() => validateAttachmentFieldName('incident', 'contract_scan')).toThrow('fieldName is only for form draft uploads')
    // Multipart forms send an empty string for an untouched field: that is "absent".
    expect(validateAttachmentFieldName('incident', '')).toBeNull()
    expect(validateAttachmentFieldName('incident', undefined)).toBeNull()
    expect(validateAttachmentFieldName('incident', 7)).toBeNull()
  })
})

describe('validateAttachmentTarget — drafts and edge input', () => {
  it('accepts a form draft with no labels, so the caller skips the existence check', () => {
    expect(validateAttachmentTarget(FORM_DRAFT_ENTITY_TYPE, UUID)).toEqual({
      entityType: FORM_DRAFT_ENTITY_TYPE,
      entityId: UUID.toLowerCase(),
      labels: [],
    })
  })

  it('refuses a missing entity type and names the draft type among the allowed ones', () => {
    expect(() => validateAttachmentTarget(undefined, UUID)).toThrow('entityType is required')
    expect(() => validateAttachmentTarget('', UUID)).toThrow('entityType is required')
    expect(() => validateAttachmentTarget('toString', UUID)).toThrow(new RegExp(`${FORM_DRAFT_ENTITY_TYPE}\\)$`))
  })

  it('refuses a non-string entity id', () => {
    expect(() => validateAttachmentTarget('incident', 123)).toThrow('entityId must be a UUID')
  })
})

describe('entityExistsCypher', () => {
  it('refuses an empty label list: a draft must never reach the existence query', () => {
    expect(() => entityExistsCypher([])).toThrow(ValidationError)
  })

  it('embeds the extra access condition next to the label predicate', () => {
    expect(entityExistsCypher(['Incident'], 'e.reported_by = $userId'))
      .toContain('WHERE (e:Incident) AND (e.reported_by = $userId)')
  })
})
