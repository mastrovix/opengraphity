import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDebounced } from './useDebounced'

describe('useDebounced', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('parte dal valore iniziale', () => {
    const { result } = renderHook(() => useDebounced('a', 300))
    expect(result.current).toBe('a')
  })

  it('aggiorna solo dopo il ritardo, e solo con l\'ultimo valore digitato', () => {
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 300), { initialProps: { v: '' } })
    rerender({ v: 'w' })
    rerender({ v: 'we' })
    act(() => { vi.advanceTimersByTime(200) })
    expect(result.current).toBe('')          // non ancora trascorsi 300 ms dall'ultima modifica
    rerender({ v: 'web' })
    act(() => { vi.advanceTimersByTime(200) })
    expect(result.current).toBe('')          // il timer è ripartito con "web"
    act(() => { vi.advanceTimersByTime(100) })
    expect(result.current).toBe('web')       // i valori intermedi non sono mai stati emessi
  })

  it('allo smontaggio non emette più nulla', () => {
    const { result, rerender, unmount } = renderHook(({ v }) => useDebounced(v, 300), { initialProps: { v: 'a' } })
    rerender({ v: 'b' })
    unmount()
    act(() => { vi.advanceTimersByTime(300) })
    expect(result.current).toBe('a')
  })
})
