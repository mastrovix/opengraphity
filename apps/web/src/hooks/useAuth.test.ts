/**
 * Logout must go through Keycloak and come back to the app root of the SAME
 * origin (tenant host): redirecting elsewhere would land the user on another
 * tenant's login, or leave the Keycloak session alive.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useAuth } from './useAuth'

const logout = vi.fn()
vi.mock('../lib/keycloak', () => ({ keycloak: { logout: (opts: unknown) => logout(opts) } }))

describe('useAuth', () => {
  it('logout ends the Keycloak session and returns to the origin root', () => {
    const { result } = renderHook(() => useAuth())
    result.current.logout()
    expect(logout).toHaveBeenCalledWith({ redirectUri: `${window.location.origin}/` })
  })
})
