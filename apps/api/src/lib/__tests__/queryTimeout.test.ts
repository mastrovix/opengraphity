/**
 * lib/queryTimeout.ts — the time and row limits of the queries the customer
 * or the model writes (review of 23 Sep 2026).
 */
import { describe, it, expect } from 'vitest'
import { firstRecords, isQueryTimeout } from '../queryTimeout.js'

describe('isQueryTimeout', () => {
  it('knows the server\'s and the driver\'s timeout codes, and nothing else', () => {
    expect(isQueryTimeout({ code: 'Neo.ClientError.Transaction.TransactionTimedOut' })).toBe(true)
    expect(isQueryTimeout({ code: 'Neo.ClientError.Transaction.TransactionTimedOutClientConfiguration' })).toBe(true)
    expect(isQueryTimeout({ code: 'Neo.ClientError.Statement.SyntaxError' })).toBe(false)
    expect(isQueryTimeout(new Error('x'))).toBe(false)
    expect(isQueryTimeout(null)).toBe(false)
  })
})

describe('firstRecords', () => {
  it('an iterable result is read one by one and left at the limit: the rest is never pulled', async () => {
    let pulled = 0
    const result = { async *[Symbol.asyncIterator]() { for (let i = 0; i < 1000; i++) { pulled++; yield i } } }
    await expect(firstRecords<number>(result, 3)).resolves.toEqual({ records: [0, 1, 2], cut: true })
    expect(pulled).toBe(4)
  })

  it('a short iterable result is not cut', async () => {
    const result = { async *[Symbol.asyncIterator]() { yield 'a'; yield 'b' } }
    await expect(firstRecords<string>(result, 3)).resolves.toEqual({ records: ['a', 'b'], cut: false })
  })

  it('a plain result is cut from its records', async () => {
    await expect(firstRecords<number>(Promise.resolve({ records: [1, 2, 3, 4] }), 2)).resolves.toEqual({ records: [1, 2], cut: true })
    await expect(firstRecords<number>({ records: [1] }, 2)).resolves.toEqual({ records: [1], cut: false })
  })
})
