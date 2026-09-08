import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { gql } from '@apollo/client'
import { toast } from 'sonner'
import { useMutationWithToast, errorMessage, type MutationWithToastOptions } from './useMutationWithToast'
import { renderWithProviders, type GqlMock } from '@/test/utils'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

const RENAME = gql`mutation Rename($id: ID!, $name: String!) { rename(id: $id, name: $name) { id name } }`
type Data = { rename: { id: string; name: string } }
type Vars = { id: string; name: string }

function Harness(props: MutationWithToastOptions<Data, Vars>) {
  const [rename, { loading }] = useMutationWithToast<Data, Vars>(RENAME, props)
  return (
    <button type="button" disabled={loading} onClick={() => void rename({ variables: { id: '1', name: 'Nuovo' } })}>
      {loading ? 'saving' : 'rename'}
    </button>
  )
}

const okMock: GqlMock = {
  request: { query: RENAME, variables: { id: '1', name: 'Nuovo' } },
  result: { data: { rename: { __typename: 'Thing', id: '1', name: 'Nuovo' } } },
}
const koMock: GqlMock = {
  request: { query: RENAME, variables: { id: '1', name: 'Nuovo' } },
  result: { errors: [{ message: 'Nome già in uso' }] },
}

beforeEach(() => { vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear() })

describe('useMutationWithToast', () => {
  it('successo: toast.success(stringa), onSuccess con i dati, poi refetch', async () => {
    const calls: string[] = []
    const onSuccess = vi.fn(() => calls.push('onSuccess'))
    const refetch   = vi.fn(() => { calls.push('refetch'); return Promise.resolve() })
    const { user } = renderWithProviders(<Harness successMessage="Rinominato" onSuccess={onSuccess} refetch={refetch} />, { mocks: [okMock] })
    await user.click(screen.getByRole('button'))
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1))
    expect(toast.success).toHaveBeenCalledWith('Rinominato')
    expect(onSuccess).toHaveBeenCalledWith({ rename: expect.objectContaining({ id: '1', name: 'Nuovo' }) })
    expect(calls).toEqual(['onSuccess', 'refetch'])
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('successMessage può derivare dal payload; senza successMessage nessun toast', async () => {
    const { user, rerender } = renderWithProviders(<Harness successMessage={(d) => `Ora si chiama ${d.rename.name}`} />, { mocks: [okMock, okMock] })
    await user.click(screen.getByRole('button'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Ora si chiama Nuovo'))

    vi.mocked(toast.success).mockClear()
    rerender(<Harness />)
    await user.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('rename'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('errore GraphQL: toast.error con il messaggio del server, poi onError; niente onSuccess/refetch', async () => {
    const onError = vi.fn(); const onSuccess = vi.fn(); const refetch = vi.fn()
    const { user } = renderWithProviders(<Harness onError={onError} onSuccess={onSuccess} refetch={refetch} successMessage="no" />, { mocks: [koMock] })
    await user.click(screen.getByRole('button'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Nome già in uso'))
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Nome già in uso' }))
    expect(onSuccess).not.toHaveBeenCalled()
    expect(refetch).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('errore di rete: toast.error con il messaggio dell\'errore', async () => {
    const netMock: GqlMock = { request: { query: RENAME, variables: { id: '1', name: 'Nuovo' } }, error: new Error('Failed to fetch') }
    const { user } = renderWithProviders(<Harness />, { mocks: [netMock] })
    await user.click(screen.getByRole('button'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to fetch'))
  })
})

describe('errorMessage', () => {
  it.each([
    [new Error('boom'), 'boom'],
    [{ message: 'like-error' }, 'like-error'],
    ['plain', 'plain'],
    [42, '42'],
    [null, 'null'],
  ])('%s → "%s"', (input, expected) => {
    expect(errorMessage(input)).toBe(expected)
  })
})
