/**
 * THE TOPOLOGY LEGEND names CI types with the metamodel's label and relation
 * types with the one shared rule (D29): it capitalised every word of the
 * internal keys («Database Instance» from `database_instance` by chance,
 * «Hosted On» from `HOSTED_ON`).
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TopologyLegend } from './TopologyLegend'
import type { TopologyNode } from './TopologyGraph'

const node = (id: string, type: string): TopologyNode => ({
  id, name: id, type, status: null, inMaintenance: false, environment: null, ownerGroup: null, incidentCount: 0, changeCount: 0, health: null,
})

describe('TopologyLegend', () => {
  it('a CI type reads with the metamodel label; one the metamodel does not know is humanized', () => {
    render(<TopologyLegend
      nodes={[node('a', 'database_instance'), node('b', 'mystery_box')]}
      edges={[{ source: 'a', target: 'b', type: 'HOSTED_ON' }, { source: 'b', target: 'a', type: 'PARENT_OF' }]}
      ciTypes={[{ name: 'database_instance', label: 'DB instance', icon: 'database', color: '' }]}
    />)
    expect(screen.getByText('DB instance')).toBeInTheDocument()
    expect(screen.getByText('Mystery box')).toBeInTheDocument()
    expect(screen.getByText('Hosted on')).toBeInTheDocument()
    expect(screen.getByText('Parent of')).toBeInTheDocument()
  })
})
