import { describe, it, expect } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useMe, ALL_ROLES } from './useMe'
import { Providers } from '@/test/utils'
import { meMock, meErrorMock } from '@/test/mocks/gql'
import type { GqlMock } from '@/test/utils'

function renderUseMe(mocks: GqlMock[]) {
  return renderHook(() => useMe(), {
    wrapper: ({ children }) => <Providers mocks={mocks}>{children}</Providers>,
  })
}

describe('useMe', () => {
  it('espone loading finché la query non risponde, poi me/role/isAdmin', async () => {
    const { result } = renderUseMe([meMock('admin')])
    expect(result.current.loading).toBe(true)
    expect(result.current.me).toBeNull()
    expect(result.current.role).toBeNull()
    expect(result.current.isAdmin).toBe(false)

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.me).toMatchObject({ id: 'u-1', email: 'test@acme.com', role: 'admin' })
    expect(result.current.role).toBe('admin')
    expect(result.current.isAdmin).toBe(true)
    expect(result.current.error).toBeNull()
  })

  it.each(['operator', 'viewer', 'end_user'])('ruolo %s → isAdmin false', async (role) => {
    const { result } = renderUseMe([meMock(role)])
    await waitFor(() => expect(result.current.role).toBe(role))
    expect(result.current.isAdmin).toBe(false)
  })

  it('me null (utente non nel DB) → role null, nessun errore', async () => {
    const { result } = renderUseMe([meMock(null)])
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.me).toBeNull()
    expect(result.current.role).toBeNull()
    expect(result.current.isAdmin).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('errore di rete → error valorizzato, me null, nessun ruolo di ripiego', async () => {
    const { result } = renderUseMe([meErrorMock('network down')])
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.error?.message).toBe('network down')
    expect(result.current.me).toBeNull()
    expect(result.current.isAdmin).toBe(false)
    expect(typeof result.current.refetch).toBe('function')
  })

  it('ALL_ROLES è la lista chiusa dei 4 ruoli accettati dall\'API', () => {
    expect(ALL_ROLES).toEqual(['admin', 'operator', 'viewer', 'end_user'])
  })
})
