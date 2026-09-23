/**
 * WHICH WORKFLOW AN UNPINNED CATALOG ITEM FOLLOWS: the tie-breaks.
 *
 * `iterPerCategoria` repeats the engine's choice (`initialStepSelection`) and
 * the panel shows its answer as the item's workflow. If the two disagree, the
 * dropdown says one thing and a new request does another. The rule: a
 * workflow of the item's own category beats a generic one; between equals the
 * highest version wins, whatever order the list arrives in; a switched-off one
 * never applies. The companion `__tests__/ItineraryPanel.test.tsx` covers
 * assigning, switching on and duplicating.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const { ItineraryPanel, iterPerCategoria } = await import('./ItineraryPanel')

const workflow = (id: string, category: string | null, version: number, active = true) =>
  ({ id, name: `Workflow ${id}`, entityType: 'service_request', category, active, version })

const WORKFLOWS = [
  workflow('generic-v1', null, 1), workflow('hw-v1', 'hardware', 1), workflow('generic-v3', null, 3),
  workflow('hw-v2', 'hardware', 2), workflow('hw-off', 'hardware', 9, false),
]

beforeEach(() => {
  apolloFinto.reset()
})

describe('iterPerCategoria', () => {
  it('the item\'s own category beats a generic workflow, and the highest version wins, in any order', () => {
    expect(iterPerCategoria(WORKFLOWS, 'hardware')?.id).toBe('hw-v2')
    expect(iterPerCategoria([...WORKFLOWS].reverse(), 'hardware')?.id).toBe('hw-v2')
  })

  it('without a workflow of its category, the newest generic one; a switched-off one never applies', () => {
    expect(iterPerCategoria(WORKFLOWS, 'software')?.id).toBe('generic-v3')
    expect(iterPerCategoria(WORKFLOWS, null)?.id).toBe('generic-v3')
    expect(iterPerCategoria([workflow('hw-off', 'hardware', 9, false)], 'hardware')).toBeNull()
  })
})

describe('ItineraryPanel', () => {
  it('an unpinned item shows the newest workflow of its own category', () => {
    apolloFinto.risposte['GetWorkflowList'] = { workflowDefinitions: WORKFLOWS }
    apolloFinto.risposte['GetCatalogItemsWithWorkflow'] = { serviceCatalogItems: [
      { id: 'i-laptop', name: 'New laptop', category: 'hardware', active: true, workflowDefinitionId: null, workflowDefinitionName: null },
      { id: 'i-access', name: 'App access', category: null, active: true, workflowDefinitionId: null, workflowDefinitionName: null },
    ] }
    renderWithProviders(<ItineraryPanel />)
    const menuOf = (item: string) => within(screen.getByRole('cell', { name: item }).closest('tr') as HTMLElement).getByRole('combobox')
    expect(menuOf('New laptop')).toHaveValue('hw-v2')
    expect(menuOf('App access')).toHaveValue('generic-v3')
  })
})
