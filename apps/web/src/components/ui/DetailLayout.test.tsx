import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DetailLayout } from './DetailLayout'

describe('DetailLayout', () => {
  it('lays out its two children with the side width as a CSS variable', () => {
    render(<DetailLayout sideWidth={340}><div>main</div><aside>side</aside></DetailLayout>)
    const grid = screen.getByTestId('detail-layout')
    expect(grid).toHaveClass('og-detail')
    expect(grid).not.toHaveClass('og-detail-side-first')
    expect(grid.style.getPropertyValue('--og-detail-side')).toBe('340px')
    expect(grid.children).toHaveLength(2)
    expect(grid.children[0]).toHaveTextContent('main')
    expect(grid.children[1]).toHaveTextContent('side')
  })

  it('puts the fixed column first when asked, and takes a gap', () => {
    render(<DetailLayout sideWidth={220} sideFirst gap={20}><nav>list</nav><div>editor</div></DetailLayout>)
    const grid = screen.getByTestId('detail-layout')
    expect(grid).toHaveClass('og-detail', 'og-detail-side-first')
    expect(grid.style.getPropertyValue('--og-detail-side')).toBe('220px')
    expect(grid).toHaveStyle({ gap: '20px' })
  })

  it('without a gap leaves the one of the class, and a style is merged last', () => {
    render(<DetailLayout sideWidth={300} style={{ marginTop: 8 }}><div>a</div><div>b</div></DetailLayout>)
    const grid = screen.getByTestId('detail-layout')
    expect(grid.style.gap).toBe('')
    expect(grid).toHaveStyle({ marginTop: '8px' })
  })

  // 26 Sep 2026: the tabs inside the main column pushed its first card down, below the side column's.
  it('a head sits above the grid, as wide as the main column, so both columns start level', () => {
    render(<DetailLayout sideWidth={340} head={<div role="tablist">tabs</div>}><div>main</div><aside>side</aside></DetailLayout>)
    const head = screen.getByTestId('detail-layout-head')
    const grid = screen.getByTestId('detail-layout')
    expect(head).toHaveClass('og-detail-head')
    expect(head.style.getPropertyValue('--og-detail-side')).toBe('340px')
    expect(head.nextElementSibling).toBe(grid)
    expect(grid).not.toContainElement(screen.getByRole('tablist'))
  })

  it('the head of a layout with the fixed column first leaves room on the other side, with the gap asked', () => {
    render(<DetailLayout sideWidth={220} sideFirst gap={20} head={<p>tabs</p>}><nav>list</nav><div>editor</div></DetailLayout>)
    const head = screen.getByTestId('detail-layout-head')
    expect(head).toHaveClass('og-detail-head', 'og-detail-head-side-first')
    expect(head.style.getPropertyValue('--og-detail-gap')).toBe('20px')
  })

  it('without a head nothing is drawn above the grid', () => {
    render(<DetailLayout sideWidth={340}><div>main</div><aside>side</aside></DetailLayout>)
    expect(screen.queryByTestId('detail-layout-head')).not.toBeInTheDocument()
  })

  // 26 Sep 2026: stacking followed the window (no idea of the 210px menu); now the room of the page.
  it('head and grid sit in a frame the columns measure themselves against (a size container)', () => {
    render(<DetailLayout sideWidth={340} head={<p>tabs</p>}><div>main</div><aside>side</aside></DetailLayout>)
    const frame = screen.getByTestId('detail-layout').parentElement!
    expect(frame).toHaveClass('og-detail-frame')
    expect(frame).toContainElement(screen.getByTestId('detail-layout-head'))
  })
})
