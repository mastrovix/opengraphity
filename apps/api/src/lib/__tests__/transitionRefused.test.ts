/**
 * A move the pipeline refused, as an error (wave 7 · B1): the refusal travels
 * with it, so a path can tell an answer that retrying would not change from a
 * failure that it might.
 */
import { describe, it, expect } from 'vitest'
import { GraphQLError } from 'graphql'
import { isFinalRefusal, TransitionRefusedError } from '../transitionRefused.js'

const refusal = { guard: 'named_approval' as const, final: true, code: 'CONFLICT', message: 'Waiting', i18n: { key: 'errors.approval.pendingOnStep', params: { step: 's' } }, extensions: { approvalId: 'apr-1' } }

describe('TransitionRefusedError', () => {
  it('is the GraphQL error a person sees, with its code, key and fields, and carries the refusal', () => {
    const e = new TransitionRefusedError(refusal)
    expect(e).toBeInstanceOf(GraphQLError)
    expect(e.message).toBe('Waiting')
    expect(e.extensions).toEqual({ code: 'CONFLICT', approvalId: 'apr-1', i18n: { key: 'errors.approval.pendingOnStep', params: { step: 's' } } })
    expect(e.refusal).toBe(refusal)
  })

  it('takes another sentence for a log or a job, keeping the refusal', () => {
    const e = new TransitionRefusedError({ guard: 'workflow', final: false, code: 'CONFLICT', message: 'Concurrent transition' }, 'Incident I-1: reopen failed')
    expect(e.message).toBe('Incident I-1: reopen failed')
    expect(e.extensions).toEqual({ code: 'CONFLICT' })
  })
})

describe('isFinalRefusal', () => {
  it('only a final refusal: not one that may be transient, not any other error', () => {
    expect(isFinalRefusal(new TransitionRefusedError(refusal))).toBe(true)
    expect(isFinalRefusal(new TransitionRefusedError({ ...refusal, final: false }))).toBe(false)
    expect(isFinalRefusal(new GraphQLError('Waiting'))).toBe(false)
    expect(isFinalRefusal(new Error('neo4j down'))).toBe(false)
    expect(isFinalRefusal(null)).toBe(false)
  })
})
