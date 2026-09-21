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

  it('i nostri errori passano come sono', () => {
    const log = vi.fn()
    const f = { message: 'Team or User not found', extensions: { code: 'NOT_FOUND' } }
    expect(maskDriverError(f, new GraphQLError('Team or User not found'), log)).toBe(f)
    expect(log).not.toHaveBeenCalled()
  })
})
