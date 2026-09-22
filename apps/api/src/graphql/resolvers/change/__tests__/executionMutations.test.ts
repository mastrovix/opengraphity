/**
 * The three GraphQL mutations of the deployment / review phases are a thin
 * binding over `completeTask`, but the binding is where a mix-up would hide:
 * if `completeDeployment` routed to the `review` kind, a deployer clicking
 * "deployed" would close the post-implementation review instead, and the
 * change would skip a phase with no error. And `completeDeployment` has no
 * result in the schema: it must never forward one, or a stale client value
 * would be validated against a result list the deployment kind does not have.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const completeTask = vi.fn(async (kind: string, changeId: string, ciId: string, result: string | undefined) => ({ kind, changeId, ciId, result }))
vi.mock('../taskKinds.js', () => ({
  completeTask: (...a: [string, string, string, string | undefined, unknown]) => completeTask(...a),
}))

const { completeValidationTest, completeDeployment, completeReview } = await import('../executionMutations.js')

const ctx = { tenantId: 't1', userId: 'u1' } as never

beforeEach(() => { completeTask.mockClear() })

describe('change execution mutations', () => {
  it('completeValidationTest completes the validation task of that CI with the chosen result', async () => {
    await expect(completeValidationTest(null, { changeId: 'chg-1', ciId: 'ci-1', result: 'pass' }, ctx))
      .resolves.toEqual({ kind: 'validation', changeId: 'chg-1', ciId: 'ci-1', result: 'pass' })
  })

  it('completeDeployment completes the deployment task and never forwards a result', async () => {
    // A stray `result` from the client must not reach the deployment kind.
    const args = { changeId: 'chg-1', ciId: 'ci-2', result: 'fail' } as unknown as { changeId: string; ciId: string }
    await expect(completeDeployment(null, args, ctx))
      .resolves.toEqual({ kind: 'deployment', changeId: 'chg-1', ciId: 'ci-2', result: undefined })
  })

  it('completeReview completes the review task with the chosen result', async () => {
    await expect(completeReview(null, { changeId: 'chg-9', ciId: 'ci-3', result: 'successful' }, ctx))
      .resolves.toEqual({ kind: 'review', changeId: 'chg-9', ciId: 'ci-3', result: 'successful' })
  })

  it('passes the caller context through, so tenant scoping and the team check happen in completeTask', async () => {
    await completeReview(null, { changeId: 'chg-9', ciId: 'ci-3', result: 'successful' }, ctx)
    expect(completeTask.mock.calls[0]![4]).toBe(ctx)
  })

  it('a failure of completeTask (e.g. NOT_FOUND) reaches the client unchanged', async () => {
    completeTask.mockRejectedValueOnce(new Error('ValidationTest not found'))
    await expect(completeValidationTest(null, { changeId: 'c', ciId: 'x', result: 'pass' }, ctx)).rejects.toThrow('not found')
  })
})
