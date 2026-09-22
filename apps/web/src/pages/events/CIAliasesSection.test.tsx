/**
 * THE ALIASES OF A CI: the names the monitoring tools use for it.
 *
 * An alarm whose resource matches an alias is linked to the CI on its own.
 * What breaks for an operator if this section regresses:
 *  - a CI with no alias must SAY so: otherwise nobody knows why its alarms
 *    arrive as orphans;
 *  - adding an alias trims the value (a pasted «web-01 » never matches) and
 *    sends the chosen kind; a refused alias keeps what was typed;
 *  - deleting asks first — an alias removed by mistake silently orphans every
 *    future alarm of that CI — and a cancelled confirmation deletes nothing;
 *  - an origin the web does not know is shown as it is, not hidden (G-EVT-8);
 *  - who may not edit sees the list and nothing to change it with.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { CIAliasesSection } = await import('./CIAliasesSection')

const CI = { id: 'ci-1', name: 'web-01' }

const alias = (over: Record<string, unknown> = {}) => ({
  id: 'al-1', ciId: 'ci-1', kind: 'hostname', value: 'web-01.acme.local', source: 'manual', createdAt: '2026-09-01T10:00:00Z', ...over,
})

const serve = (aliases: unknown[]) => { apolloFinto.risposte['GetCIAliases'] = { ciAliases: aliases } }

const valueBox = () => screen.getByLabelText('Value')
const addButton = () => screen.getByRole('button', { name: 'Add' })

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset()
  toast.error.mockReset()
})

describe('CIAliasesSection — what it shows', () => {
  it('as a card: titled with the CI, and an empty list says what that means', () => {
    serve([])
    renderWithProviders(<CIAliasesSection ci={CI} canEdit={false} variant="card" />)
    expect(apolloFinto.chiamata('GetCIAliases')).toEqual({ ciId: 'ci-1' })
    // The card starts open.
    expect(screen.getByText('No aliases: the source will not recognise this CI on its own.')).toBeInTheDocument()
    expect(screen.getByText('Aliases of CI web-01')).toBeInTheDocument()
    // Read-only: no form, no bin.
    expect(screen.queryByLabelText('Value')).not.toBeInTheDocument()
  })

  it('inline, inside the CI health: its own title and hint', () => {
    serve([])
    renderWithProviders(<CIAliasesSection ci={CI} canEdit variant="inline" />)
    expect(screen.getByText('Aliases')).toBeInTheDocument()
    expect(screen.getByText(/The names the monitoring tools use for this CI/)).toBeInTheDocument()
    expect(screen.getByText(/^No aliases/)).toBeInTheDocument()
  })

  it('each alias shows its kind, value and translated origin; an unknown origin is shown raw', () => {
    serve([
      alias(),
      alias({ id: 'al-2', kind: 'ip', value: '10.0.0.5', source: 'discovery' }),
      alias({ id: 'al-3', kind: 'external_id', value: 'EXT-9', source: 'cmdb_import' }),
    ])
    renderWithProviders(<CIAliasesSection ci={CI} canEdit={false} variant="card" />)
    expect(screen.getByText('10.0.0.5')).toBeInTheDocument()
    expect(screen.getByText('IP')).toBeInTheDocument()
    expect(screen.getByText('External ID')).toBeInTheDocument()
    expect(screen.getByText('discovery')).toHaveAttribute('title', expect.stringMatching(/^Source: discovery · added on /))
    expect(screen.getByText('cmdb_import')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Delete alias/ })).not.toBeInTheDocument()
  })

  it('a failed load shows the error with a retry, and no «no aliases»', async () => {
    apolloFinto.erroriQuery['GetCIAliases'] = new Error('graph down')
    const { user } = renderWithProviders(<CIAliasesSection ci={CI} canEdit variant="inline" />)
    expect(screen.getByText(/graph down/)).toBeInTheDocument()
    expect(screen.queryByText(/^No aliases/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })
})

describe('CIAliasesSection — adding', () => {
  it('an empty value cannot be added', async () => {
    serve([])
    const { user } = renderWithProviders(<CIAliasesSection ci={CI} canEdit variant="card" />)
    expect(addButton()).toBeDisabled()
    await user.type(valueBox(), '   ')
    expect(addButton()).toBeDisabled()
  })

  it('the value is trimmed and sent with the chosen kind; the field empties and the list reloads', async () => {
    serve([])
    const { user } = renderWithProviders(<CIAliasesSection ci={CI} canEdit variant="card" />)
    await user.selectOptions(screen.getByLabelText('Kind'), 'ip')
    await user.type(valueBox(), ' 10.0.0.7 ')
    await user.click(addButton())
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Alias created'))
    expect(apolloFinto.chiamata('CreateCIAlias')).toEqual({ ciId: 'ci-1', kind: 'ip', value: '10.0.0.7' })
    expect(valueBox()).toHaveValue('')
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a refused alias is reported and the value stays for a fix', async () => {
    serve([])
    apolloFinto.esiti['CreateCIAlias'] = { error: new Error('alias already used by db-02') }
    const { user } = renderWithProviders(<CIAliasesSection ci={CI} canEdit variant="inline" />)
    await user.type(valueBox(), 'web-01')
    await user.click(addButton())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Action failed: alias already used by db-02'))
    expect(valueBox()).toHaveValue('web-01')
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe('CIAliasesSection — deleting', () => {
  it('asks first, naming kind and value; confirming deletes and reloads', async () => {
    serve([alias()])
    const { user } = renderWithProviders(<CIAliasesSection ci={CI} canEdit variant="card" />)
    await user.click(screen.getByRole('button', { name: 'Delete alias web-01.acme.local' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('hostname: web-01.acme.local')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Alias deleted'))
    expect(apolloFinto.chiamata('DeleteCIAlias')).toEqual({ id: 'al-1' })
    expect(apolloFinto.refetch).toHaveBeenCalled()
    // The bin is usable again once the deletion is over.
    expect(screen.getByRole('button', { name: 'Delete alias web-01.acme.local' })).toBeEnabled()
  })

  it('a cancelled confirmation deletes nothing', async () => {
    serve([alias()])
    const { user } = renderWithProviders(<CIAliasesSection ci={CI} canEdit variant="card" />)
    await user.click(screen.getByRole('button', { name: 'Delete alias web-01.acme.local' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(apolloFinto.chiamate['DeleteCIAlias']).toBeUndefined()
  })

  it('a failed deletion is reported, not announced as done', async () => {
    serve([alias()])
    apolloFinto.esiti['DeleteCIAlias'] = { error: new Error('not found') }
    const { user } = renderWithProviders(<CIAliasesSection ci={CI} canEdit variant="card" />)
    await user.click(screen.getByRole('button', { name: 'Delete alias web-01.acme.local' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Action failed: not found'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Delete alias web-01.acme.local' })).toBeEnabled()
  })
})
