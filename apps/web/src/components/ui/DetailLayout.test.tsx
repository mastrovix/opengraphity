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
})
