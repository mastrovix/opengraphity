/**
 * THE SERVICE REQUEST DESIGNER: one page, three tabs — the form of a
 * catalog item, the tenant's field library, and the workflow each item
 * follows.
 *
 * They are three steps of the same job (whoever composes a form finds out
 * halfway that a new field is needed), but they stay separate tabs because
 * they need different permissions. The panels have their own tests; this one
 * pins the page: it opens on the designer, and each tab shows its own panel
 * and only that one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))

const { CatalogFormsPage } = await import('./CatalogFormsPage')

/** The designer with no catalog item yet: it says where items are added. */
const DESIGNER_EMPTY = 'There is no active catalog item to build a form for. Add one in Admin → Service catalog.'
const LIBRARY_INTRO = /^A field is defined once and reused by every form\./
const WORKFLOW_INTRO = /^A WORKFLOW is the road a request travels/

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetServiceCatalogAdmin'] = { serviceCatalogItems: [] }
  apolloFinto.risposte['GetFormFields'] = { formFields: [] }
  apolloFinto.risposte['GetCatalogItemsWithWorkflow'] = { serviceCatalogItems: [] }
  apolloFinto.risposte['GetWorkflowList'] = { workflowDefinitions: [] }
})

describe('CatalogFormsPage', () => {
  it('opens on the form designer, under the title and what the page is for', () => {
    renderWithProviders(<CatalogFormsPage />)
    expect(screen.getByRole('heading', { name: 'Service Request Designer' })).toBeInTheDocument()
    expect(screen.getByText(/^Here you decide what a service request asks \(the form\)/)).toBeInTheDocument()
    expect(screen.getByRole('tablist', { name: 'Service Request Designer' })).toBeInTheDocument()
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Designer', 'Field library', 'Workflow'])
    expect(screen.getByRole('tab', { name: 'Designer' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(DESIGNER_EMPTY)).toBeInTheDocument()
    expect(screen.queryByText(LIBRARY_INTRO)).toBeNull()
  })

  it('each tab shows its own panel, and only that one', async () => {
    const { user } = renderWithProviders(<CatalogFormsPage />)
    await user.click(screen.getByRole('tab', { name: 'Field library' }))
    expect(screen.getByRole('tab', { name: 'Field library' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(LIBRARY_INTRO)).toBeInTheDocument()
    expect(screen.queryByText(DESIGNER_EMPTY)).toBeNull()

    await user.click(screen.getByRole('tab', { name: 'Workflow' }))
    expect(screen.getByText(WORKFLOW_INTRO)).toBeInTheDocument()
    expect(screen.queryByText(LIBRARY_INTRO)).toBeNull()

    await user.click(screen.getByRole('tab', { name: 'Designer' }))
    expect(screen.getByText(DESIGNER_EMPTY)).toBeInTheDocument()
    expect(screen.queryByText(WORKFLOW_INTRO)).toBeNull()
  })
})
