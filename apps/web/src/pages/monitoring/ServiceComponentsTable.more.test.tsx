/**
 * Components table: the "your change was overwritten" notice is dismissed by
 * the user, and only by the user (revisione 2 · C-2). If Close stops working
 * the warning sits over the table for the rest of the session; if the notice
 * came back by itself on the next poll it would cry wolf every 15 seconds.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { ServiceComponentsTable } from './ServiceComponentsTable'
import { GET_SERVICE_IMPACT_PREVIEW } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { mapDetail, preview } from '@/test/mocks/services'
import type { ServiceMapDetail } from '@/types/services'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))

const detail = (over: Record<string, unknown> = {}) => mapDetail(over) as unknown as ServiceMapDetail

const previewMock: GqlMock = {
  request: { query: GET_SERVICE_IMPACT_PREVIEW, variables: () => true },
  result: { data: { serviceImpactPreview: preview() } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

const table = (map: ServiceMapDetail) => <ServiceComponentsTable map={map} canEdit ciTypeLabel={(type) => type} onReload={() => {}} />

describe('ServiceComponentsTable: overwritten notice', () => {
  it('Close dismisses the notice, and the next poll with the same values does not bring it back', async () => {
    const { user, rerender } = renderWithProviders(table(detail()), { mocks: [previewMock] })
    const weight = screen.getByLabelText('Weight of db-01')
    await user.clear(weight)
    await user.type(weight, '9')

    // Another administrator saved 7 on the same component.
    const nodes = (mapDetail().nodes as Record<string, unknown>[]).map((n) => (n.ci as { id: string }).id === 'db-01' ? { ...n, weight: 7 } : n)
    rerender(table(detail({ nodes, version: 4 })))
    const notice = await screen.findByTestId('components-overwritten')

    await user.click(within(notice).getByRole('button', { name: 'Close' }))
    expect(screen.queryByTestId('components-overwritten')).not.toBeInTheDocument()

    // Polling returns a fresh object with the same saved values: nothing new to say.
    rerender(table(detail({ nodes: nodes.map((n) => ({ ...n })), version: 4 })))
    expect(screen.queryByTestId('components-overwritten')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Weight of db-01')).toHaveValue(7)
  })
})
