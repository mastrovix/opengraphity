/**
 * THE SCRIPT HELP next to the formula and validation boxes.
 *
 * Why these behaviours matter to an administrator writing a script:
 *  - the help starts closed and opens on demand: it must not push the box
 *    they are typing in off the screen;
 *  - it lists the fields by TECHNICAL name (`input.<name>`), which is what the
 *    script must use, with the label only to recognise them; and it says so
 *    when the library has no field yet, instead of an empty box;
 *  - formula examples appear only where a formula is possible, and «Insert»
 *    sends the example to the RIGHT box: a validation example inserted into a
 *    formula would be a script that never refuses anything.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ScriptHelp } from '../ScriptHelp'

const FIELDS = [
  { name: 'unit_cost', label: 'Unit cost' },
  { name: 'quantity', label: '' },
]

function open(props: Partial<Parameters<typeof ScriptHelp>[0]> = {}) {
  const onInserisci = vi.fn()
  const user = userEvent.setup()
  render(<ScriptHelp campi={FIELDS} conFormula onInserisci={onInserisci} {...props} />)
  return { user, onInserisci, toggle: screen.getByRole('button', { name: 'Examples and available fields' }) }
}

describe('ScriptHelp', () => {
  it('starts closed and toggles open and closed', async () => {
    const { user, toggle } = open()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Fields you can read')).not.toBeInTheDocument()

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/You reference a field by its technical name/)).toBeInTheDocument()
    expect(screen.getByText(/arrives as null/)).toBeInTheDocument()

    await user.click(toggle)
    expect(screen.queryByText('Fields you can read')).not.toBeInTheDocument()
  })

  it('lists the readable fields by technical name, with the label only when there is one', async () => {
    const { user, toggle } = open()
    await user.click(toggle)
    expect(screen.getByText('input.unit_cost')).toBeInTheDocument()
    expect(screen.getByText('· Unit cost', { exact: false })).toBeInTheDocument()
    const qty = screen.getByText('input.quantity')
    // An empty label must not leave a dangling "·" next to the name.
    expect(qty.parentElement).toHaveTextContent(/^input\.quantity$/)
  })

  it('says the library has no field yet instead of showing an empty list', async () => {
    const { user, toggle } = open({ campi: [] })
    await user.click(toggle)
    expect(screen.getByText('The library has no field yet.')).toBeInTheDocument()
  })

  it('inserts a formula example into the formula box and a validation example into the validation box', async () => {
    const { user, toggle, onInserisci } = open()
    await user.click(toggle)
    expect(screen.getByText('Formulas')).toBeInTheDocument()
    expect(screen.getByText('Validation scripts')).toBeInTheDocument()

    const inserts = screen.getAllByRole('button', { name: 'Insert' })
    // Five formula examples first, then five validation examples.
    expect(inserts).toHaveLength(10)
    await user.click(inserts[0]!)
    expect(onInserisci).toHaveBeenLastCalledWith('formula', 'return input.unit_cost * input.quantity')
    await user.click(inserts[5]!)
    expect(onInserisci).toHaveBeenLastCalledWith('validation', "if (value < 0) throw new Error('It cannot be negative')")
  })

  it('offers no formula example where a formula is not possible', async () => {
    const { user, toggle } = open({ conFormula: false })
    await user.click(toggle)
    expect(screen.queryByText('Formulas')).not.toBeInTheDocument()
    expect(screen.getByText('Validation scripts')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Insert' })).toHaveLength(5)
  })
})
