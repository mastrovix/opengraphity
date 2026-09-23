/**
 * STEP 1 OF THE REPORT BUILDER: «What do you want to analyse?».
 *
 * The user picks the entity a report section is built on. The groups come
 * from the API (a hard-coded list stayed at Incident and Change when the
 * catalog learnt Problem and Service Request), product entities read in the
 * user's language while the customer's own CI types keep their name, each kind
 * has its icon, and the entity already chosen as root is shown pressed — it
 * is how the user sees what the section is about when coming back to step 1.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Node } from '@xyflow/react'
import { ReportQueryBuilder } from './ReportQueryBuilder'
import type { NavigableEntity } from './ReportFlowNodes'

const entity = (entityType: string, label: string, group: NavigableEntity['group'], labelKey: string | null = null): NavigableEntity =>
  ({ entityType, label, labelKey, neo4jLabel: entityType, group, fields: [], relations: [] })

const ENTITIES: NavigableEntity[] = [
  entity('Incident', 'Incident (api)', 'itsm', 'reportBuilder.entity.incident'),
  entity('Change', 'Change (api)', 'itsm', 'reportBuilder.entity.change'),
  entity('Problem', 'Problem', 'itsm'),
  entity('ServiceRequest', 'Service request', 'itsm'),
  entity('Team', 'Team (api)', 'organization', 'reportBuilder.entity.team'),
  entity('User', 'User (api)', 'organization', 'reportBuilder.entity.user'),
  entity('Firewall', 'Perimeter firewall', 'cmdb'),
]

function mount(opts: { entities?: NavigableEntity[]; rootLabel?: string | null } = {}) {
  const onSelectRoot = vi.fn()
  const nodes = opts.rootLabel ? [{ id: 'n1', position: { x: 0, y: 0 }, data: {} } as Node] : []
  const nodeDataMap: Record<string, { entityType: string; neo4jLabel: string; label: string; isResult: boolean; isRoot: boolean }> = opts.rootLabel
    ? { n1: { entityType: opts.rootLabel, neo4jLabel: opts.rootLabel, label: opts.rootLabel, isResult: true, isRoot: true } }
    : {}
  render(<ReportQueryBuilder entities={opts.entities ?? ENTITIES} nodes={nodes} nodeDataMap={nodeDataMap} onSelectRoot={onSelectRoot} />)
  return { onSelectRoot }
}

/** The group box under a group caption. */
const group = (caption: string) => screen.getByText(caption).parentElement as HTMLElement
const names = (el: HTMLElement) => within(el).getAllByRole('button').map((b) => b.textContent)

describe('ReportQueryBuilder', () => {
  it('asks what to analyse and lists the entities in their groups, in the user\'s language', () => {
    mount()
    expect(screen.getByRole('heading', { name: 'What do you want to analyse?' })).toBeInTheDocument()
    expect(screen.getByText('Choose the kind of data this report section is built on.')).toBeInTheDocument()
    expect(names(group('ITSM'))).toEqual(['Incident', 'Change', 'Problem', 'Service request'])
    expect(names(group('Organization'))).toEqual(['Team', 'User'])
    // A CI type of the customer keeps the name the customer gave it.
    expect(names(group('CI'))).toEqual(['Perimeter firewall'])
  })

  it('a group with no entity is not shown, nor is an entity without a known group', () => {
    mount({ entities: [entity('Incident', 'Incident', 'itsm'), entity('Mystery', 'Mystery', undefined)] })
    expect(screen.getByText('ITSM')).toBeInTheDocument()
    expect(screen.queryByText('Organization')).not.toBeInTheDocument()
    expect(screen.queryByText('CI')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mystery' })).not.toBeInTheDocument()
  })

  it('each kind of entity has its own icon; a CI type gets the generic box', () => {
    mount()
    const icon = (name: string) => screen.getByRole('button', { name }).querySelector('svg')
    expect(icon('Incident')).toHaveClass('lucide-circle-alert')
    expect(icon('Change')).toHaveClass('lucide-git-pull-request')
    expect(icon('Problem')).toHaveClass('lucide-bug')
    expect(icon('Service request')).toHaveClass('lucide-clipboard-list')
    expect(icon('Team')).toHaveClass('lucide-users')
    expect(icon('User')).toHaveClass('lucide-user')
    expect(icon('Perimeter firewall')).toHaveClass('lucide-box')
  })

  it('clicking an entity chooses it as the root of the section', async () => {
    const user = userEvent.setup()
    const { onSelectRoot } = mount()
    await user.click(screen.getByRole('button', { name: 'Problem' }))
    expect(onSelectRoot).toHaveBeenCalledWith(ENTITIES[2])
  })

  it('the entity already chosen as root is shown pressed, the others not', () => {
    mount({ rootLabel: 'Change' })
    expect(screen.getByRole('button', { name: 'Change' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Incident' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('with nothing chosen yet no entity is pressed', () => {
    mount()
    for (const b of screen.getAllByRole('button')) expect(b).toHaveAttribute('aria-pressed', 'false')
  })
})
