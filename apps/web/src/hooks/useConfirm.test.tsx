import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConfirmProvider, useConfirm, type ConfirmOptions } from './useConfirm'
import { ConfirmModal } from '@/components/ui/ConfirmModal'

function Harness({ options, onResult }: { options: ConfirmOptions; onResult: (ok: boolean) => void }) {
  const confirm = useConfirm()
  return <button type="button" onClick={() => void confirm(options).then(onResult)}>ask</button>
}

function setup(options: ConfirmOptions) {
  const onResult = vi.fn()
  const user = userEvent.setup()
  render(<ConfirmProvider><Harness options={options} onResult={onResult} /></ConfirmProvider>)
  return { onResult, user }
}

describe('useConfirm + ConfirmModal', () => {
  it('fuori da ConfirmProvider lancia (nessun no-op silenzioso)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Harness options={{ title: 'x' }} onResult={() => {}} />))
      .toThrow('useConfirm() richiede un <ConfirmProvider> a monte')
  })

  it('apre un dialog con titolo e corpo di default, il focus iniziale è su Annulla', async () => {
    const { user } = setup({ title: 'Eliminare?' })
    await user.click(screen.getByText('ask'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAccessibleName('Eliminare?')
    expect(screen.getByText('This action cannot be undone.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus())
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
  })

  it('Conferma → true e il dialog si chiude', async () => {
    const { onResult, user } = setup({ title: 'Procedere?', body: 'Dettagli', confirmLabel: 'Vai' })
    await user.click(screen.getByText('ask'))
    await user.click(await screen.findByRole('button', { name: 'Vai' }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('Annulla → false', async () => {
    const { onResult, user } = setup({ title: 'Procedere?', cancelLabel: 'No grazie' })
    await user.click(screen.getByText('ask'))
    await user.click(await screen.findByRole('button', { name: 'No grazie' }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false))
  })

  it('Escape → false', async () => {
    const { onResult, user } = setup({ title: 'Procedere?' })
    await user.click(screen.getByText('ask'))
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('il bottone di chiusura (X) → false', async () => {
    const { onResult, user } = setup({ title: 'Procedere?' })
    await user.click(screen.getByText('ask'))
    await user.click(await screen.findByRole('button', { name: 'Close' }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false))
  })

  it('danger → bottone "Delete" rosso', async () => {
    const { user } = setup({ title: 'Eliminare?', danger: true })
    await user.click(screen.getByText('ask'))
    const del = await screen.findByRole('button', { name: 'Delete' })
    expect(del).toHaveStyle({ backgroundColor: 'var(--color-danger)' })
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
  })

  it('una seconda richiesta mentre una è pendente risolve la prima come "no"', async () => {
    const first = vi.fn(); const second = vi.fn()
    const user = userEvent.setup()
    function Two() {
      const confirm = useConfirm()
      return (
        <>
          <button type="button" onClick={() => void confirm({ title: 'Uno' }).then(first)}>one</button>
          <button type="button" onClick={() => void confirm({ title: 'Due' }).then(second)}>two</button>
        </>
      )
    }
    render(<ConfirmProvider><Two /></ConfirmProvider>)
    await user.click(screen.getByText('one'))
    await screen.findByRole('dialog', { name: 'Uno' })
    await user.click(screen.getByText('two'))
    await waitFor(() => expect(first).toHaveBeenCalledWith(false))
    expect(screen.getByRole('dialog', { name: 'Due' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(second).toHaveBeenCalledWith(true))
  })
})

describe('ConfirmModal diretto', () => {
  it('loading disabilita entrambi i bottoni; open=false non renderizza nulla', () => {
    const { rerender } = render(<ConfirmModal open title="T" loading onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled()
    rerender(<ConfirmModal open={false} title="T" onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
