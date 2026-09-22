/**
 * THE FORMULA AND VALIDATION BOXES of a library field (catalogue forms).
 *
 * Why these behaviours matter to an administrator:
 *  - the formula box is offered only where a computed value makes sense; a
 *    formula on a field type that cannot be computed would be saved and
 *    silently ignored;
 *  - «Test» really runs the formula on the values typed as JSON, and says why
 *    when it cannot (bad JSON, a script error, no value): without it the only
 *    way to find a broken formula is a customer filling the form;
 *  - an example from the help is APPENDED, never replacing what was written:
 *    looking at an example must not cost the script being written;
 *  - a stale test result disappears as soon as the formula changes, so the
 *    administrator never reads «= 42» next to a formula that no longer gives 42.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const runFormula = vi.hoisted(() => vi.fn())
vi.mock('@opengraphity/web-core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runFormula,
}))

const { ScriptFields } = await import('../ScriptFields')

/** The component is controlled: the harness keeps the two scripts like the field editor does. */
function Harness({ canCompute = true, initialFormula = '', initialScript = '', campi }: {
  canCompute?: boolean; initialFormula?: string; initialScript?: string
  campi?: { name: string; label: string }[]
}) {
  const [formula, setFormula] = useState(initialFormula)
  const [script, setScript] = useState(initialScript)
  return (
    <>
      <ScriptFields formula={formula} onFormula={setFormula} canCompute={canCompute}
        validationScript={script} onValidationScript={setScript} campiLeggibili={campi} />
      <pre data-testid="formula">{formula}</pre>
      <pre data-testid="script">{script}</pre>
    </>
  )
}

const formulaBox = () => screen.getByLabelText('Formula (computed field)')
const scriptBox = () => screen.getByLabelText('Validation script')
const testButton = () => screen.getByRole('button', { name: 'Test' })

beforeEach(() => { runFormula.mockReset() })

describe('ScriptFields — which boxes are offered', () => {
  it('a field type that cannot be computed gets only the validation box, and no formula examples', async () => {
    const user = userEvent.setup()
    render(<Harness canCompute={false} />)
    expect(screen.queryByLabelText('Formula (computed field)')).not.toBeInTheDocument()
    expect(scriptBox()).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Examples and available fields' }))
    // Only validation examples: offering a formula example here would insert
    // code into a box that does not exist.
    expect(screen.queryByText('Formulas')).not.toBeInTheDocument()
    expect(screen.getByText('Validation scripts')).toBeInTheDocument()
    expect(screen.getByText('The library has no field yet.')).toBeInTheDocument()
  })

  it('the Test controls appear only once there is a formula to test', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    expect(screen.queryByRole('button', { name: 'Test' })).not.toBeInTheDocument()
    await user.type(formulaBox(), 'return 1')
    expect(screen.getByTestId('formula')).toHaveTextContent('return 1')
    expect(testButton()).toBeInTheDocument()
    expect(screen.getByText('Test values (JSON)')).toBeInTheDocument()
  })

  it('typing a validation script reaches the parent', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.type(scriptBox(), 'throw 1')
    expect(screen.getByTestId('script')).toHaveTextContent('throw 1')
  })
})

describe('ScriptFields — «Test» runs the formula', () => {
  const testValues = () => screen.getByRole('textbox', { name: 'Test values (JSON)' })

  it('runs the formula on the JSON values and shows the result', async () => {
    runFormula.mockResolvedValue({ value: 300 })
    const user = userEvent.setup()
    render(<Harness initialFormula="return input.cost * 3" />)
    await user.clear(testValues())
    await user.click(testValues())
    await user.paste('{"cost": 100}')
    await user.click(testButton())
    expect(await screen.findByRole('status')).toHaveTextContent('= 300')
    expect(runFormula).toHaveBeenCalledWith('return input.cost * 3', { cost: 100 })
  })

  it('a formula that returns nothing says «no value» instead of an empty «=»', async () => {
    runFormula.mockResolvedValue({ value: null })
    const user = userEvent.setup()
    render(<Harness initialFormula="return null" />)
    await user.click(testButton())
    expect(await screen.findByRole('status')).toHaveTextContent('= no value')
  })

  it('undefined is «no value» as well', async () => {
    runFormula.mockResolvedValue({})
    const user = userEvent.setup()
    render(<Harness initialFormula="return" />)
    await user.click(testButton())
    expect(await screen.findByRole('status')).toHaveTextContent('= no value')
  })

  it('a script error is shown as it is, without the «=» of a result', async () => {
    runFormula.mockResolvedValue({ error: 'ReferenceError: foo is not defined' })
    const user = userEvent.setup()
    render(<Harness initialFormula="return foo" />)
    await user.click(testButton())
    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('ReferenceError: foo is not defined')
    expect(status.textContent).not.toMatch(/^=/)
  })

  it.each([
    ['not JSON', '{cost: 1'],
    ['an array', '[1, 2]'],
    ['null', 'null'],
    ['a number', '42'],
  ])('test values that are %s are refused before running anything', async (_label, typed) => {
    const user = userEvent.setup()
    render(<Harness initialFormula="return 1" />)
    await user.clear(testValues())
    await user.click(testValues())
    await user.paste(typed)
    await user.click(testButton())
    expect(await screen.findByRole('status')).toHaveTextContent('The test values must be a JSON object')
    // The sandbox is never reached with an input the formula could not read.
    expect(runFormula).not.toHaveBeenCalled()
  })

  it('changing the formula clears the old result', async () => {
    runFormula.mockResolvedValue({ value: 1 })
    const user = userEvent.setup()
    render(<Harness initialFormula="return 1" />)
    await user.click(testButton())
    expect(await screen.findByRole('status')).toHaveTextContent('= 1')
    await user.type(formulaBox(), '0')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('the Test button is disabled while the formula runs', async () => {
    let resolve!: (v: { value: number }) => void
    runFormula.mockReturnValue(new Promise((r) => { resolve = r }))
    const user = userEvent.setup()
    render(<Harness initialFormula="return 2" />)
    await user.click(testButton())
    // A second click while the sandbox works would start a second run.
    expect(testButton()).toBeDisabled()
    resolve({ value: 2 })
    expect(await screen.findByRole('status')).toHaveTextContent('= 2')
    expect(testButton()).toBeEnabled()
  })
})

describe('ScriptFields — inserting an example from the help', () => {
  const openHelp = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('button', { name: 'Examples and available fields' }))

  /** The «Insert» button next to the example explained by `text`. */
  const insertFor = (text: string) => {
    const explanation = screen.getByText(text)
    return within(explanation.parentElement!).getByRole('button', { name: 'Insert' })
  }

  it('into an empty formula, the example becomes the formula', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await openHelp(user)
    await user.click(insertFor('Multiply two fields.'))
    expect(screen.getByTestId('formula').textContent).toBe('return input.unit_cost * input.quantity')
  })

  it('into a formula already written, the example is appended on a new line', async () => {
    const user = userEvent.setup()
    render(<Harness initialFormula={'const x = 1\n\n'} />)
    await openHelp(user)
    await user.click(insertFor('Multiply two fields.'))
    // Trailing blank lines are folded, the existing code is kept.
    expect(screen.getByTestId('formula').textContent).toBe('const x = 1\nreturn input.unit_cost * input.quantity')
  })

  it('an inserted example clears a stale test result', async () => {
    runFormula.mockResolvedValue({ value: 5 })
    const user = userEvent.setup()
    render(<Harness initialFormula="return 5" />)
    await user.click(testButton())
    expect(await screen.findByRole('status')).toBeInTheDocument()
    await openHelp(user)
    await user.click(insertFor('Multiply two fields.'))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('a validation example goes into the validation box, empty or not', async () => {
    const user = userEvent.setup()
    render(<Harness campi={[{ name: 'budget', label: 'Budget' }, { name: 'code', label: '' }]} />)
    await openHelp(user)
    // The readable fields are listed with their technical name.
    expect(screen.getByText('input.budget')).toBeInTheDocument()
    expect(screen.getByText('input.code')).toBeInTheDocument()
    await user.click(insertFor('Refuse a negative number.'))
    expect(screen.getByTestId('script').textContent).toBe("if (value < 0) throw new Error('It cannot be negative')")
    await user.click(insertFor('Compare with another field of the form.'))
    expect(screen.getByTestId('script').textContent).toBe(
      "if (value < 0) throw new Error('It cannot be negative')\nif (value > input.budget) throw new Error('Above the approved budget')")
    // The formula is untouched.
    expect(screen.getByTestId('formula').textContent).toBe('')
  })
})
