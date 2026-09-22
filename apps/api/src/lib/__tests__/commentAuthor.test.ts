/**
 * Who wrote a comment when it is not a person.
 *
 * Why these behaviours matter: comments written by monitoring or by an
 * automation rule have no user, and the ticket page used to show them as
 * "Unknown user". A comment WITH a user must never be relabelled as a machine,
 * and the edit/delete trace must show nothing rather than an empty name.
 */
import { describe, it, expect } from 'vitest'
import { commentAuthorKind, commentAuthorLabel, commentTrace } from '../commentAuthor.js'

describe('commentAuthorKind', () => {
  it('a comment with a user is a person, whatever its author fields say', () => {
    expect(commentAuthorKind({ author_id: 'monitoring', author_label: 'Rule' }, true)).toBeNull()
  })

  it('recognises monitoring and automation by their actor id', () => {
    expect(commentAuthorKind({ author_id: 'monitoring' }, false)).toBe('monitoring')
    expect(commentAuthorKind({ author_id: 'automation' }, false)).toBe('automation')
  })

  it('a rule name as author label means an automation', () => {
    expect(commentAuthorKind({ author_id: 'x', author_label: 'Escalate P1' }, false)).toBe('automation')
  })

  it('an empty or non-string label, and no known actor, is unknown', () => {
    expect(commentAuthorKind({ author_label: '' }, false)).toBeNull()
    expect(commentAuthorKind({ author_label: 42 }, false)).toBeNull()
    expect(commentAuthorKind({}, false)).toBeNull()
  })
})

describe('commentAuthorLabel', () => {
  it('returns the label only when it is a non-empty string', () => {
    expect(commentAuthorLabel({ author_label: 'Escalate P1' })).toBe('Escalate P1')
    expect(commentAuthorLabel({ author_label: '' })).toBeNull()
    expect(commentAuthorLabel({ author_label: 7 })).toBeNull()
    expect(commentAuthorLabel({})).toBeNull()
  })
})

describe('commentTrace', () => {
  it('maps the snapshot of who edited and deleted', () => {
    expect(commentTrace({
      edited_at: '2026-09-01T10:00:00Z', edited_by_name: 'Ada',
      deleted_at: '2026-09-02T10:00:00Z', deleted_by_name: 'Bob',
    })).toEqual({
      editedAt: '2026-09-01T10:00:00Z', editedByName: 'Ada',
      deletedAt: '2026-09-02T10:00:00Z', deletedByName: 'Bob',
    })
  })

  it('an untouched comment has no trace; empty strings and non-strings count as absent', () => {
    expect(commentTrace({ edited_at: '', edited_by_name: null, deleted_at: 5 })).toEqual({
      editedAt: null, editedByName: null, deletedAt: null, deletedByName: null,
    })
  })
})
