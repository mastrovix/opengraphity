/** The hook behind the narrow layouts (tour of 24 Sep 2026, G47): it follows the window as it resizes. */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useMediaQuery } from './useMediaQuery'

afterEach(() => { vi.unstubAllGlobals() })

describe('useMediaQuery', () => {
  it('answers what the query matches now, and follows its changes', () => {
    let matches = true
    const listeners = new Set<() => void>()
    vi.stubGlobal('matchMedia', (q: string) => ({
      media: q, get matches() { return matches },
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    }))
    const { result, unmount } = renderHook(() => useMediaQuery('(max-width: 1100px)'))
    expect(result.current).toBe(true)
    act(() => { matches = false; listeners.forEach((fn) => fn()) })
    expect(result.current).toBe(false)
    unmount()
    expect(listeners.size).toBe(0)
  })

  it('without matchMedia (a test, a server) it answers false', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(renderHook(() => useMediaQuery('(max-width: 1100px)')).result.current).toBe(false)
  })
})
