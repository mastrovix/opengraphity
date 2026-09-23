/**
 * "New CI type" creates a GraphQL type, queries, mutations and a Neo4j label
 * from the technical name. If the dialog stopped normalising the name, stopped
 * blocking a name already taken (which would silently merge the new type into
 * an existing one), closed itself when saving failed (losing what the user
 * typed), or reopened with the previous type's values, the admin would either
 * corrupt the metamodel or think the save had misbehaved.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '@/test/utils'

const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }))

import { CreateTypeDialog } from './CreateTypeDialog'

beforeEach(() => { toastError.mockReset() })

const nameInput = () => screen.getByLabelText(/Technical name/)
const labelInput = () => screen.getByLabelText(/Label \(display name\)/)
const createBtn = () => screen.getByRole('button', { name: 'Create the type' })

describe('CreateTypeDialog', () => {
  it('normalises the technical name to snake_case as the user types', async () => {
    renderWithProviders(<CreateTypeDialog open onClose={vi.fn()} onSave={vi.fn()} />)
    await userEvent.type(nameInput(), 'My-Type 2')
    expect(nameInput()).toHaveValue('my_type_2')
  })

  it('refuses to create without a name and a label', async () => {
    const onSave = vi.fn()
    renderWithProviders(<CreateTypeDialog open onClose={vi.fn()} onSave={onSave} />)
    await userEvent.click(createBtn())
    expect(toastError).toHaveBeenCalledWith('Name and label are required')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('a name already taken is flagged at once and the create button is disabled', async () => {
    renderWithProviders(<CreateTypeDialog open onClose={vi.fn()} onSave={vi.fn()} existingTypes={[{ name: 'server', scope: 'base' }]} />)
    await userEvent.type(nameInput(), 'server')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(nameInput()).toHaveAttribute('aria-invalid', 'true')
    expect(nameInput()).toHaveAttribute('aria-describedby', screen.getByRole('alert').id)
    expect(createBtn()).toBeDisabled()
  })

  it('saves the whole form (icon and colour included) and closes on success', async () => {
    const onClose = vi.fn()
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderWithProviders(<CreateTypeDialog open onClose={onClose} onSave={onSave} />)
    await userEvent.type(nameInput(), 'firewall_box')
    await userEvent.type(labelInput(), 'Firewall box')
    await userEvent.selectOptions(screen.getByLabelText('Icon'), 'shield')
    fireEvent.change(screen.getByLabelText('Colour'), { target: { value: '#112233' } })
    await userEvent.click(createBtn())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onSave).toHaveBeenCalledWith({ name: 'firewall_box', label: 'Firewall box', icon: 'shield', color: '#112233' })
  })

  // The icons offered are the registry's own list (tour of 23 Sep 2026): the
  // pickers kept their own, and one of them offered icons drawn as the red «?».
  it('every icon offered is drawn as itself', async () => {
    renderWithProviders(<CreateTypeDialog open onClose={vi.fn()} onSave={vi.fn()} />)
    const offered = Array.from((screen.getByLabelText('Icon') as HTMLSelectElement).options, (o) => o.value)
    expect(offered.length).toBeGreaterThan(0)
    for (const icon of offered) {
      await userEvent.selectOptions(screen.getByLabelText('Icon'), icon)
      expect(screen.getByRole('img', { name: icon })).toBeInTheDocument()
    }
  })

  it('stays open with the typed values when the save fails, and re-enables the button', async () => {
    const onClose = vi.fn()
    let reject!: (e: Error) => void
    const onSave = vi.fn(() => new Promise<void>((_, r) => { reject = r }))
    renderWithProviders(<CreateTypeDialog open onClose={onClose} onSave={onSave} />)
    await userEvent.type(nameInput(), 'x_type')
    await userEvent.type(labelInput(), 'X')
    await userEvent.click(createBtn())
    // While saving, the button says so and cannot be clicked twice.
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled()
    reject(new Error('already notified'))
    await waitFor(() => expect(createBtn()).toBeEnabled())
    expect(onClose).not.toHaveBeenCalled()
    expect(nameInput()).toHaveValue('x_type')
  })

  it('reopening starts from an empty form', async () => {
    const props = { onClose: vi.fn(), onSave: vi.fn() }
    const { rerender } = renderWithProviders(<CreateTypeDialog open {...props} />)
    await userEvent.type(nameInput(), 'old_type')
    rerender(<CreateTypeDialog open={false} {...props} />)
    rerender(<CreateTypeDialog open {...props} />)
    expect(nameInput()).toHaveValue('')
  })

  it('cancel closes the dialog', async () => {
    const onClose = vi.fn()
    renderWithProviders(<CreateTypeDialog open onClose={onClose} onSave={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
  })
})
