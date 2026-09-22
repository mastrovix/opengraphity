/**
 * Skeletons stand in for content while it loads. Two things matter: the
 * shimmer keyframes are injected into <head> ONCE however many skeletons a
 * page mounts (a list of 50 rows must not add 50 <style> tags), and a card
 * renders exactly the number of placeholder lines asked for, so its height
 * roughly matches the content that replaces it.
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { SkeletonCard, SkeletonLine } from './SkeletonLoader'

const shimmerStyles = () => Array.from(document.head.querySelectorAll('style')).filter((s) => s.textContent?.includes('@keyframes shimmer'))

describe('SkeletonLoader', () => {
  it('injects the shimmer keyframes once, however many skeletons are mounted', () => {
    render(<><SkeletonLine /><SkeletonLine /><SkeletonCard /></>)
    render(<SkeletonCard rows={2} />)
    expect(shimmerStyles()).toHaveLength(1)
  })

  it('a line takes the given size, and defaults to full width', () => {
    const { container } = render(<><SkeletonLine /><SkeletonLine width="40%" height={20} /></>)
    const [full, custom] = Array.from(container.children) as HTMLElement[]
    expect(full!.style.width).toBe('100%')
    expect(full!.style.height).toBe('14px')
    expect(custom!.style.width).toBe('40%')
    expect(custom!.style.height).toBe('20px')
  })

  it('a card draws the requested number of lines, the first taller like a title', () => {
    const { container } = render(<SkeletonCard rows={7} />)
    const lines = Array.from(container.firstElementChild!.children) as HTMLElement[]
    expect(lines).toHaveLength(7)
    expect(lines[0]!.style.height).toBe('16px')
    expect(lines[1]!.style.height).toBe('13px')
    // widths cycle through a fixed set, so row 6 repeats row 1
    expect(lines[5]!.style.width).toBe(lines[0]!.style.width)
  })

  it('a card defaults to three lines', () => {
    const { container } = render(<SkeletonCard />)
    expect(container.firstElementChild!.children).toHaveLength(3)
  })
})
