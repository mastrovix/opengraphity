/**
 * The topology legend, beyond the names: it lists only what is ON SCREEN, it
 * explains the health colours only while health highlighting is on (a legend
 * entry for colours nobody sees is noise), and it always explains the two
 * signals drawn on nodes (an open incident, a change in progress).
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TopologyLegend } from './TopologyLegend'
import type { TopologyNode } from './TopologyGraph'

const node = (id: string, type: string): TopologyNode => ({
  id, name: id, type, status: null, inMaintenance: false, environment: null, ownerGroup: null, incidentCount: 0, changeCount: 0, health: null,
})

describe('TopologyLegend (more)', () => {
  it('health colours are explained only while health highlighting is on', () => {
    const ciTypes = [{ name: 'server', label: 'Server', icon: 'server', color: '' }]
    const { rerender } = render(<TopologyLegend nodes={[node('a', 'server')]} edges={[]} ciTypes={ciTypes} />)
    expect(screen.queryByText('Health')).not.toBeInTheDocument()
    expect(screen.queryByText('Down')).not.toBeInTheDocument()
    rerender(<TopologyLegend nodes={[node('a', 'server')]} edges={[]} ciTypes={ciTypes} highlightHealth />)
    expect(screen.getByText('Health')).toBeInTheDocument()
    expect(screen.getByText('Down')).toBeInTheDocument()
    expect(screen.getByText('Degraded')).toBeInTheDocument()
  })

  it('without a metamodel the CI types are humanized, each listed once and in order, and the missing icons are reported', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<TopologyLegend nodes={[node('a', 'web_server'), node('b', 'database'), node('c', 'web_server')]} edges={[]} />)
    const names = screen.getAllByText(/Web server|Database/).map((e) => e.textContent)
    expect(names).toEqual(['Database', 'Web server'])
    // Fail-loud: a type without an icon is said, not drawn as a generic box.
    expect(consoleError).toHaveBeenCalledWith('[CI_ICON] CI type with no icon in the metamodel: "web_server"')
    expect(consoleError).toHaveBeenCalledWith('[CI_ICON] CI type with no icon in the metamodel: "database"')
  })

  it('an empty graph shows no node or relationship section, but still explains the signals', () => {
    render(<TopologyLegend nodes={[]} edges={[]} />)
    expect(screen.getByText('Legend')).toBeInTheDocument()
    expect(screen.queryByText('Nodes')).not.toBeInTheDocument()
    expect(screen.queryByText('Relationships')).not.toBeInTheDocument()
    expect(screen.getByText('Signals')).toBeInTheDocument()
    expect(screen.getByText('Active incident')).toBeInTheDocument()
    expect(screen.getByText('Change in progress')).toBeInTheDocument()
  })
})
