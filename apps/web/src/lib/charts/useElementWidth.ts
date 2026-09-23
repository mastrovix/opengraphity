/**
 * THE WIDTH A CHART REALLY HAS (D5, tour of 23 Sep 2026).
 *
 * A time axis shows as many labels as its width holds (`passoEtichette` in
 * echartsOptions): the same «per month» chart has room for all its months in
 * a full-width widget and for one in three at half width. The width is read
 * before the first paint and again whenever the element is resized.
 *
 * `undefined` while the element has no width (not laid out yet, a hidden
 * tab, a test in jsdom): the charts then keep their default behaviour.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

export function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number | undefined] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      const w = Math.round(el.getBoundingClientRect().width)
      setWidth(w > 0 ? w : undefined)
    }
    read()
    const observer = new ResizeObserver(read)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}
