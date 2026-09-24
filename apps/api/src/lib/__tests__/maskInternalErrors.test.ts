/** Giro nel browser del 14 set 2026 (#6): «Expected parameter(s): tenantId» in un toast. */
import { describe, it, expect, vi } from 'vitest'
import { GraphQLError } from 'graphql'
import { maskDriverError } from '../maskInternalErrors.js'

const driverError = Object.assign(new Error('Expected parameter(s): tenantId'), { name: 'Neo4jError', code: 'Neo.ClientError.Statement.ParameterMissing' })

describe('maskDriverError', () => {
  it('un errore del driver (anche come causa) diventa generico con riferimento; il testo vero va nel log', () => {
    const log = vi.fn()
    const wrapped = new GraphQLError('Expected parameter(s): tenantId', { originalError: driverError })
    const out = maskDriverError({ message: 'Expected parameter(s): tenantId', extensions: { code: 'INTERNAL_SERVER_ERROR' } }, wrapped, log)
    expect(out.message).not.toContain('tenantId')
    expect(out.message).toMatch(/reference [0-9a-f]{8}/)
    const ref = (out.extensions!['i18n'] as { params: { ref: string } }).params.ref
    expect(log).toHaveBeenCalledWith({ ref, message: 'Expected parameter(s): tenantId' })
  })

  /*
   * Wave 7 · A2: a request the database stopped at one of its limits is not
   * an internal error — the person can narrow it, and is told so. The texts
   * are Neo4j 5.26.29's, from the probe of 24 Sep 2026; the error arrives
   * wrapped (GraphQLError → QueryError → Neo4jError).
   */
  it('a request stopped at the time limit says so, with its key and the reference of the log line', () => {
    const log = vi.fn()
    const neo = Object.assign(new Error('The transaction has been terminated.'), { name: 'Neo4jError', code: 'Neo.ClientError.Transaction.TransactionTimedOutClientConfiguration' })
    const query = Object.assign(new Error(neo.message), { name: 'QueryError', code: neo.code, cause: neo })
    const out = maskDriverError({ message: neo.message }, new GraphQLError(neo.message, { originalError: query }), log)
    const i18n = out.extensions!['i18n'] as { key: string; params: { ref: string } }
    expect(i18n.key).toBe('errors.queryTimeout')
    expect(out.message).toBe(`The database stopped this request because it took too long (reference ${i18n.params.ref}). Narrow it — a filter, a shorter period — and try again.`)
    expect(log).toHaveBeenCalledWith({ ref: i18n.params.ref, message: neo.message })
  })

  it('a request stopped at the per-transaction memory limit says so; the pool-wide limit stays an internal error', () => {
    const memory = (message: string) => new GraphQLError(message, { originalError: Object.assign(new Error(message), { name: 'Neo4jError', code: 'Neo.TransientError.General.MemoryPoolOutOfMemoryError' }) })
    const own = maskDriverError({ message: 'x' }, memory('The allocation of an extra 2.0 MiB would use more than the limit 1.0 GiB. db.memory.transaction.max threshold reached'), vi.fn())
    expect((own.extensions!['i18n'] as { key: string }).key).toBe('errors.queryMemoryLimit')
    const pool = maskDriverError({ message: 'x' }, memory('... dbms.memory.transaction.total.max threshold reached'), vi.fn())
    expect((pool.extensions!['i18n'] as { key: string }).key).toBe('errors.internalDatabase')
  })

  it('i nostri errori passano come sono', () => {
    const log = vi.fn()
    const f = { message: 'Team or User not found', extensions: { code: 'NOT_FOUND' } }
    expect(maskDriverError(f, new GraphQLError('Team or User not found'), log)).toBe(f)
    expect(log).not.toHaveBeenCalled()
  })
})
