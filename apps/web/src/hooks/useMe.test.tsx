import { describe, it, expect } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useMe } from './useMe'
import { Providers } from '@/test/utils'
import { meMock, meErrorMock } from '@/test/mocks/gql'
import type { GqlMock } from '@/test/utils'

function renderUseMe(mocks: GqlMock[]) {
  return renderHook(() => useMe(), {
    wrapper: ({ children }) => <Providers mocks={mocks}>{children}</Providers>,
  })
}

describe('useMe', () => {
  it('espone loading finché la query non risponde, poi me/role/permessi', async () => {
    const { result } = renderUseMe([meMock('admin')])
    expect(result.current.loading).toBe(true)
    expect(result.current.me).toBeNull()
    expect(result.current.role).toBeNull()
    expect(result.current.can('admin.users')).toBe(false)

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.me).toMatchObject({ id: 'u-1', email: 'test@acme.com', role: 'admin' })
    expect(result.current.role).toBe('admin')
    expect(result.current.can('admin.users')).toBe(true)
    expect(result.current.error).toBeNull()
  })

  it('le decisioni vengono dai permessi del ruolo, non dal suo nome', async () => {
    const { result } = renderUseMe([meMock('operator')])
    await waitFor(() => expect(result.current.role).toBe('operator'))
    expect(result.current.can('incident.write')).toBe(true)
    expect(result.current.can('admin.users')).toBe(false)
    // «almeno uno di questi»
    expect(result.current.can('admin.users', 'kb.write')).toBe(true)
  })

  it('me null (utente non nel DB) → role null, nessun permesso, nessun errore', async () => {
    const { result } = renderUseMe([meMock(null)])
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.me).toBeNull()
    expect(result.current.role).toBeNull()
    expect(result.current.permissions.size).toBe(0)
    expect(result.current.error).toBeNull()
  })

  it('errore di rete → error valorizzato, me null, nessun permesso di ripiego', async () => {
    const { result } = renderUseMe([meErrorMock('network down')])
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.error?.message).toBe('network down')
    expect(result.current.me).toBeNull()
    expect(result.current.can('workspace.use')).toBe(false)
    expect(typeof result.current.refetch).toBe('function')
  })
})
