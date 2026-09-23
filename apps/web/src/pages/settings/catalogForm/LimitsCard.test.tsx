/**
 * THE LIMITS OF THE CATALOG FORMS, shown above the field library.
 *
 * They are a technical ceiling — library fields, fields per form, rows per
 * table — that the server enforces. The card exists so that the ceiling is
 * seen BEFORE it stops someone: how much of the library is used, turning to
 * the warning colour near the top, and the place to raise it. What must not
 * regress: a value outside what the server accepts must be refused here with
 * the range spelled out (not sent to fail), what is saved must be the three
 * numbers typed, and a refused save must not close the boxes as if it worked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

/*
 * Apollo Client 4 calls a mutation's `onError` AND then rejects its promise
 * (`react/hooks/useMutation.js`); the shared fake resolves instead. Here a
 * refused save rejects, as it does in the app — and a refusal the card forgot
 * to catch fails the run as an unhandled rejection.
 */
vi.mock('@apollo/client/react', async () => {
  const { moduloApollo } = await import('@/test/apolloFinto')
  const base = moduloApollo()
  type Execute = (o?: Record<string, unknown>) => Promise<{ data?: unknown; errors?: Error[] }>
  return {
    ...base,
    useMutation: (doc: Parameters<typeof base.useMutation>[0], opts?: Parameters<typeof base.useMutation>[1]) => {
      const [execute, state] = base.useMutation(doc, opts) as unknown as [Execute, unknown]
      const likeApollo4 = async (o?: Record<string, unknown>) => {
        const r = await execute(o)
        if (r.errors?.[0]) throw r.errors[0]
        return r
      }
      return [likeApollo4, state]
    },
  }
})
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { LimitsCard } = await import('./LimitsCard')

const LIMITS = { maxLibraryFields: 120, maxFieldsPerForm: 40, maxTableRows: 50, libraryFieldsUsed: 12, min: 10, max: 500 }

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset()
  toast.error.mockReset()
  apolloFinto.risposte['GetCatalogFormLimits'] = { catalogFormLimits: LIMITS }
})

const box = (name: string) => screen.getByRole('spinbutton', { name })

describe('LimitsCard', () => {
  it('shows nothing until the limits are known', () => {
    apolloFinto.risposte['GetCatalogFormLimits'] = undefined
    renderWithProviders(<LimitsCard />)
    expect(screen.queryByText('Limits')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Change the limits' })).toBeNull()
  })

  it('says how much of the library is used, and the ceilings per form and per table', () => {
    renderWithProviders(<LimitsCard />)
    expect(screen.getByText('Limits')).toBeInTheDocument()
    const usage = screen.getByText('12 of 120 library fields')
    expect(usage).toHaveStyle({ color: 'var(--color-slate)' })
    expect(screen.getByText('up to 40 fields per form')).toBeInTheDocument()
    expect(screen.getByText('up to 50 rows per table')).toBeInTheDocument()
  })

  it('from 80% of the library the usage turns to the warning colour', () => {
    apolloFinto.risposte['GetCatalogFormLimits'] = { catalogFormLimits: { ...LIMITS, libraryFieldsUsed: 96 } }
    renderWithProviders(<LimitsCard />)
    expect(screen.getByText('96 of 120 library fields')).toHaveStyle({ color: 'var(--color-warning)' })
  })

  it('«Change the limits» opens three boxes with the current values and the range; the same button cancels', async () => {
    const { user } = renderWithProviders(<LimitsCard />)
    await user.click(screen.getByRole('button', { name: 'Change the limits' }))
    expect(box('Fields in the library')).toHaveValue(120)
    expect(box('Fields in one form')).toHaveValue(40)
    expect(box('Rows per table')).toHaveValue(50)
    expect(screen.getByText(/A whole number between 10 and 500/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('spinbutton')).toBeNull()
  })

  it('refuses a value out of range, not whole or empty, saying the range, and sends nothing', async () => {
    const { user } = renderWithProviders(<LimitsCard />)
    await user.click(screen.getByRole('button', { name: 'Change the limits' }))
    for (const [name, value] of [['Fields in the library', '1000'], ['Fields in one form', '12.5'], ['Rows per table', '']] as const) {
      await user.clear(box(name))
      if (value !== '') await user.type(box(name), value)
      await user.click(screen.getByRole('button', { name: 'Save' }))
      expect(toast.error).toHaveBeenLastCalledWith('A limit is a whole number between 10 and 500.')
      // Put it back, so the next box is the only wrong one.
      await user.clear(box(name))
      await user.type(box(name), '100')
    }
    expect(toast.error).toHaveBeenCalledTimes(3)
    expect(apolloFinto.chiamate['SetCatalogFormLimits']).toBeUndefined()
  })

  it('saves the three numbers typed, closes and reads the limits again', async () => {
    apolloFinto.esiti['SetCatalogFormLimits'] = { data: { setCatalogFormLimits: { ...LIMITS, maxLibraryFields: 200 } } }
    const { user } = renderWithProviders(<LimitsCard />)
    await user.click(screen.getByRole('button', { name: 'Change the limits' }))
    await user.clear(box('Fields in the library'))
    await user.type(box('Fields in the library'), '200')
    await user.clear(box('Rows per table'))
    await user.type(box('Rows per table'), '10')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Limits saved'))
    expect(apolloFinto.chiamata('SetCatalogFormLimits')).toEqual({ maxLibraryFields: 200, maxFieldsPerForm: 40, maxTableRows: 10 })
    await waitFor(() => expect(screen.queryByRole('spinbutton')).toBeNull())
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a refused save keeps the boxes open with what was typed', async () => {
    apolloFinto.esiti['SetCatalogFormLimits'] = { error: new Error('Only an administrator can change the limits') }
    const { user } = renderWithProviders(<LimitsCard />)
    await user.click(screen.getByRole('button', { name: 'Change the limits' }))
    await user.clear(box('Fields in one form'))
    await user.type(box('Fields in one form'), '60')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Only an administrator can change the limits'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(box('Fields in one form')).toHaveValue(60)
  })
})
