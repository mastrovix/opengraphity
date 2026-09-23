/**
 * THE ALIASES OF A CI, WHILE A CHANGE IS ON ITS WAY.
 *
 * A deletion or an addition takes a moment. Before G-EVT-9 the bin had no
 * state: two clicks sent two deletions, the second fell on the alias just
 * deleted, and a red error followed a green «deleted». So while one alias is
 * being deleted, its bin turns into a spinner and EVERY bin is off; while an
 * alias is being added, the form is locked with a spinner on its button; and
 * while the list loads it says so instead of «no aliases».
 * The rest of the section is covered by `CIAliasesSection.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { CIAliasesSection } from './CIAliasesSection'

// An operation named in `held` never answers: the query stays in flight, the change on its way.
const held = vi.hoisted(() => new Set<string>())
vi.mock('@apollo/client/react', async () => {
  const { nomeOperazione, moduloApollo, apolloFinto: finto } = await import('@/test/apolloFinto')
  const m = moduloApollo()
  type Doc = Parameters<typeof m.useMutation>[0]
  type Opts = Parameters<typeof m.useMutation>[1]
  return {
    ...m,
    useQuery: (doc: Doc, opts?: Opts) => {
      const r = m.useQuery(doc, opts)
      return held.has(nomeOperazione(doc)) ? { ...r, data: undefined, loading: true } : r
    },
    useMutation: (doc: Doc, opts?: Opts) => {
      const nome = nomeOperazione(doc)
      const [fn, r] = m.useMutation(doc, opts)
      if (!held.has(nome)) return [fn, r] as const
      const pending = (o: { variables?: Record<string, unknown> } = {}) => {
        ;(finto.chiamate[nome] ??= []).push(o.variables)
        return new Promise(() => {})
      }
      return [pending, { ...r, loading: true }] as const
    },
  }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const CI = { id: 'ci-1', name: 'web-01' }
const alias = (id: string, value: string) => ({ id, ciId: 'ci-1', kind: 'hostname', value, source: 'manual', createdAt: '2026-09-01T10:00:00Z' })

beforeEach(() => {
  apolloFinto.reset()
  held.clear()
  apolloFinto.risposte['GetCIAliases'] = { ciAliases: [alias('al-1', 'web-01.acme.local'), alias('al-2', '10.0.0.7')] }
})

describe('CIAliasesSection while a change is on its way', () => {
  it('while the aliases load it says so, not «no aliases»', () => {
    held.add('GetCIAliases')
    renderWithProviders(<CIAliasesSection ci={CI} canEdit={false} variant="card" />)
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByText(/^No aliases/)).toBeNull()
  })

  it('while an alias is being deleted its bin is a spinner and no bin can be pressed again', async () => {
    held.add('DeleteCIAlias')
    const { user } = renderWithProviders(<CIAliasesSection ci={CI} canEdit variant="card" />)
    await user.click(screen.getByRole('button', { name: 'Delete alias web-01.acme.local' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Delete the alias?' })).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(apolloFinto.chiamata('DeleteCIAlias')).toEqual({ id: 'al-1' }))
    const first = screen.getByRole('button', { name: 'Delete alias web-01.acme.local' })
    const second = screen.getByRole('button', { name: 'Delete alias 10.0.0.7' })
    await waitFor(() => expect(first).toBeDisabled())
    expect(second).toBeDisabled()
    expect(first.querySelector('.animate-spin')).not.toBeNull()
    expect(second.querySelector('.animate-spin')).toBeNull()
    expect(apolloFinto.chiamate['DeleteCIAlias']).toHaveLength(1)
  })

  it('while an alias is being added the form is locked, with a spinner on its button', () => {
    held.add('CreateCIAlias')
    renderWithProviders(<CIAliasesSection ci={CI} canEdit variant="inline" />)
    const add = screen.getByRole('button', { name: 'Add' })
    expect(add).toBeDisabled()
    expect(add.querySelector('.animate-spin')).not.toBeNull()
    expect(screen.getByLabelText('Value')).toBeDisabled()
    expect(screen.getByLabelText('Kind')).toBeDisabled()
  })
})
