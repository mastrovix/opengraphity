/**
 * THE INTEGRITY PANEL of the platform console (wave 7 · A3).
 *
 * What it must make plain:
 *  1. the check reads the whole graph: it runs only on "Check", never on load;
 *  2. a clean graph says so, with when and how long;
 *  3. edges between tenants are an alert with the total and a row per group;
 *  4. a failure is said on the page, never swallowed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({ crossTenantEdges: vi.fn() }))
vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  api,
}))
vi.mock('./keycloak', () => ({ keycloak: { token: 'tok' } }))

const { IntegrityPanel } = await import('./IntegrityPanel')

beforeEach(() => { api.crossTenantEdges.mockReset() })
afterEach(cleanup)

describe('IntegrityPanel', () => {
  it('does not read the graph on load: only on Check', async () => {
    api.crossTenantEdges.mockResolvedValue({ total: 0, groups: [], checkedAt: '2026-09-24T08:00:00.000Z', durationMs: 3120 })
    render(<IntegrityPanel />)
    expect(api.crossTenantEdges).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Check' }))
    expect((await screen.findByRole('status')).textContent).toMatch(/No relationship between different tenants\. Checked at .* in 3\.1 s\./)
    expect(api.crossTenantEdges).toHaveBeenCalledTimes(1)
  })

  it('edges between tenants: an alert with the total and a row per group', async () => {
    api.crossTenantEdges.mockResolvedValue({
      total: 1203, checkedAt: '2026-09-24T08:00:00.000Z', durationMs: 2900,
      groups: [{ fromTenant: 'acme', toTenant: 'globex', type: 'AFFECTS', fromLabels: ['Incident'], toLabels: ['ConfigurationItem', 'Server'], count: 1203 }],
    })
    render(<IntegrityPanel />)
    await userEvent.click(screen.getByRole('button', { name: 'Check' }))
    expect((await screen.findByRole('alert')).textContent).toContain('1,203 relationship(s) join two different tenants')
    const row = within(screen.getByRole('table', { name: 'Relationships between tenants' })).getByText('AFFECTS').closest('tr')!
    expect(within(row).getAllByRole('cell').map((c) => c.textContent)).toEqual(['acme', 'Incident', 'AFFECTS', 'ConfigurationItem:Server', 'globex', '1,203'])
  })

  it('a failure is said on the page, and the button comes back', async () => {
    api.crossTenantEdges.mockRejectedValue(new Error('platform identity required'))
    render(<IntegrityPanel />)
    await userEvent.click(screen.getByRole('button', { name: 'Check' }))
    expect((await screen.findByRole('alert')).textContent).toContain('platform identity required')
    expect((screen.getByRole('button', { name: 'Check' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
