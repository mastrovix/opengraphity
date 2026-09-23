/**
 * THE WIDTH A CHART REALLY HAS (D5).
 *
 * A time axis shows as many labels as its width holds, so the width is read
 * before the first paint and again whenever the element is resized; the
 * observer goes away with the element. An element with no width (a hidden
 * tab, jsdom) gives `undefined`, and the charts keep their default
 * behaviour; so does a hook whose element was never attached.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, renderHook, screen, act } from '@testing-library/react'
import { useElementWidth } from './useElementWidth'

let resize: (() => void) | null = null
const observed: Element[] = []
const disconnect = vi.fn()

class RecordingObserver {
  constructor(cb: () => void) { resize = cb }
  observe(el: Element) { observed.push(el) }
  disconnect() { disconnect() }
}

function Chart() {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  return <div ref={ref} data-testid="chart">{width === undefined ? 'no width' : `${width}px`}</div>
}

// The test setup defines ResizeObserver as writable but not configurable: it is swapped by assignment.
const realObserver = globalThis.ResizeObserver
const installRecordingObserver = () => { globalThis.ResizeObserver = RecordingObserver as unknown as typeof ResizeObserver }

afterEach(() => {
  globalThis.ResizeObserver = realObserver
  vi.restoreAllMocks()
  resize = null
  observed.length = 0
  disconnect.mockReset()
})

const withWidth = (width: number) =>
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width } as DOMRect)

describe('useElementWidth', () => {
  it('reads the width before the first paint, rounded', () => {
    installRecordingObserver()
    withWidth(480.4)
    render(<Chart />)
    expect(screen.getByTestId('chart')).toHaveTextContent('480px')
    expect(observed).toEqual([screen.getByTestId('chart')])
  })

  it('follows the element when it is resized, and stops observing when it goes away', () => {
    installRecordingObserver()
    const rect = withWidth(480)
    const { unmount } = render(<Chart />)
    rect.mockReturnValue({ width: 300 } as DOMRect)
    act(() => { resize!() })
    expect(screen.getByTestId('chart')).toHaveTextContent('300px')
    unmount()
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('an element with no width gives no width', () => {
    installRecordingObserver()
    withWidth(0)
    render(<Chart />)
    expect(screen.getByTestId('chart')).toHaveTextContent('no width')
  })

  it('an element never attached is neither measured nor observed', () => {
    installRecordingObserver()
    const { result } = renderHook(() => useElementWidth<HTMLDivElement>())
    expect(result.current[1]).toBeUndefined()
    expect(result.current[0].current).toBeNull()
    expect(observed).toEqual([])
  })
})
