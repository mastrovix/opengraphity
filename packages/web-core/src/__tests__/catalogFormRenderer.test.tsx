/**
 * THE CATALOG FORM RENDERER, one for two applications.
 *
 * It lives in this package because a catalog form is filled in from TWO
 * places — the workspace and the portal — and the two used to have different
 * renderers, the portal's poorer (only `select` and `input`: no text area, no
 * sections, no conditionals). With rich forms two renderers drift in a week,
 * and the drift shows where it hurts most: the end user fills in a different
 * form from the one the administrator drew.
 *
 * What is shared is structure and BEHAVIOUR: section order, field types,
 * visibility conditions, errors, what is reported back. The LOOK is not: this
 * component writes no colour and no size, it emits `og-form-*` classes and
 * each application dresses them with its own scale — the web is a dense
 * console, the portal is for people who spend two minutes a year there.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within, cleanup } from '@testing-library/react'
import type { CatalogFormDefinition } from '@opengraphity/types'
import { CatalogFormRenderer, type CatalogFormFieldView } from '../CatalogFormRenderer.js'

// `globals` is off in this package's vitest config, so testing-library does
// not register its own cleanup: without this every test would see the DOM of
// the ones before it.
afterEach(cleanup)

const field = (name: string, fieldType = 'text', over: Partial<CatalogFormFieldView> = {}): CatalogFormFieldView =>
  ({ name, fieldType, label: name, required: false, ...over })

const form = (items: Array<Record<string, unknown>>, section: Record<string, unknown> = {}): CatalogFormDefinition =>
  ({ version: 1, revision: 1, sections: [{ id: 's1', title: { it: 'Dati', en: 'Data' }, items, ...section }] } as unknown as CatalogFormDefinition)

/** Renders with sensible defaults and gives back the onChange spy. */
function draw(over: Partial<Parameters<typeof CatalogFormRenderer>[0]> = {}) {
  const onChange = vi.fn()
  const props = {
    definition: form([{ field: 'titolo' }]),
    fields: [field('titolo')],
    answers: {},
    onChange,
    ...over,
  } as Parameters<typeof CatalogFormRenderer>[0]
  const utils = render(<CatalogFormRenderer {...props} />)
  return { onChange, ...utils }
}

describe('sections', () => {
  it('a section gets a heading, and the heading names the section for a screen reader', () => {
    draw({ definition: form([{ field: 'titolo' }], { description: { it: 'Compila tutto' } }) })
    const section = screen.getByRole('region', { name: 'Dati' })
    expect(within(section).getByRole('heading', { name: 'Dati' })).toBeTruthy()
    expect(section.textContent).toContain('Compila tutto')
  })

  it('the title and the description follow the language asked for', () => {
    draw({
      definition: form([{ field: 'titolo' }], { title: { it: 'Dati', en: 'Data' } }),
      language: 'en',
    })
    expect(screen.getByRole('heading', { name: 'Data' })).toBeTruthy()
  })

  it('a section whose condition is false disappears entirely', () => {
    draw({
      definition: form([{ field: 'titolo' }], { visibleWhen: { rules: [{ field: 'tipo', operator: 'equals', value: 'hw' }] } }),
      answers: {},
    })
    expect(screen.queryByRole('heading', { name: 'Dati' })).toBeNull()
  })

  it('a section left with nothing to show does not leave a dangling title', () => {
    draw({
      definition: form([{ field: 'seriale', visibleWhen: { rules: [{ field: 'tipo', operator: 'equals', value: 'hw' }] } }]),
      fields: [field('seriale')],
      answers: { tipo: 'sw' },
    })
    expect(screen.queryByRole('heading', { name: 'Dati' })).toBeNull()
  })
})

describe('fields', () => {
  it('a text field is an input, labelled, that reports what is typed', async () => {
    const { onChange } = draw({ fields: [field('titolo', 'text', { label: 'Titolo' })] })
    const input = screen.getByLabelText('Titolo') as HTMLInputElement
    expect(input.type).toBe('text')
    const { default: userEvent } = await import('@testing-library/user-event')
    await userEvent.type(input, 'X')
    expect(onChange).toHaveBeenCalledWith('titolo', 'X')
  })

  it('clearing a field reports null, not an empty string', () => {
    // The API tells "left empty" from "never asked" by null; an empty string
    // would write an empty property onto the ticket.
    const { onChange } = draw({ fields: [field('titolo')], answers: { titolo: 'x' } })
    const input = screen.getByLabelText('titolo')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    ;(input as HTMLInputElement).value = ''
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onChange.mock.calls.every(([, v]) => v === null || v === '')).toBe(true)
  })

  it('a number field asks for the DECIMAL keyboard, not the letters one', () => {
    // On a phone `type="number"` alone opens the letters keyboard, and the
    // browser then refuses the letters silently: the owner typed
    // "Pppplkmmmmm" into a Number field and saw nothing appear. The field was
    // not broken — but there was no way to tell.
    draw({ definition: form([{ field: 'quantita' }]), fields: [field('quantita', 'number')] })
    const input = screen.getByLabelText('quantita') as HTMLInputElement
    expect(input.type).toBe('number')
    expect(input.inputMode).toBe('decimal')
  })

  it.each([
    ['textarea', 'textarea'],
    ['date',     'input'],
    ['datetime', 'input'],
  ])('a %s field renders as the right control', (fieldType, tag) => {
    draw({ definition: form([{ field: 'f' }]), fields: [field('f', fieldType)] })
    expect(screen.getByLabelText('f').tagName.toLowerCase()).toBe(tag)
  })

  it('an enum offers an empty choice first, then the options', () => {
    draw({
      definition: form([{ field: 'tipo' }]),
      fields: [field('tipo', 'enum', { options: [{ value: 'hw', label: 'Hardware' }, { value: 'sw', label: 'Software' }] })],
      emptyChoiceLabel: 'Scegli…',
    })
    const options = within(screen.getByLabelText('tipo')).getAllByRole('option') as HTMLOptionElement[]
    expect(options.map((o) => o.textContent)).toEqual(['Scegli…', 'Hardware', 'Software'])
    expect(options[0]!.value).toBe('')
  })

  it('a boolean is a three-way choice: yes, no, and "not answered"', () => {
    // Two radio buttons cannot express "the person has not answered", and a
    // checkbox would make every unanswered boolean a false.
    draw({ definition: form([{ field: 'urgente' }]), fields: [field('urgente', 'boolean')], yesLabel: 'Sì', noLabel: 'No', emptyChoiceLabel: '—' })
    const options = within(screen.getByLabelText('urgente')).getAllByRole('option') as HTMLOptionElement[]
    expect(options.map((o) => [o.value, o.textContent])).toEqual([['', '—'], ['true', 'Sì'], ['false', 'No']])
  })

  it('a multi-select is a GROUP of checkboxes, named by its own label', () => {
    // The label cannot point at a single control here, so it carries an id
    // the group uses with aria-labelledby: without it the group had no name
    // for a screen reader, with only the required asterisk as a hint.
    draw({
      definition: form([{ field: 'tag' }]),
      fields: [field('tag', 'multi_enum', { options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] })],
      answers: { tag: ['a'] },
    })
    const group = screen.getByRole('group', { name: 'tag' })
    const boxes = within(group).getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes.map((b) => b.checked)).toEqual([true, false])
  })

  it('ticking and unticking a multi-select reports the whole list', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const { onChange } = draw({
      definition: form([{ field: 'tag' }]),
      fields: [field('tag', 'multi_enum', { options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] })],
      answers: { tag: ['a'] },
    })
    const boxes = within(screen.getByRole('group', { name: 'tag' })).getAllByRole('checkbox')
    await userEvent.click(boxes[1]!)
    expect(onChange).toHaveBeenLastCalledWith('tag', ['a', 'b'])
    await userEvent.click(boxes[0]!)
    expect(onChange).toHaveBeenLastCalledWith('tag', [])
  })

  it('a NOTE is not a field: no label, no control, nothing to fill in', () => {
    draw({ definition: form([{ field: 'istruzioni' }]), fields: [field('istruzioni', 'note', { label: 'Porta il badge' })] })
    expect(screen.getByText('Porta il badge')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('a field the form names but the library does not have is REPORTED, not silently dropped', () => {
    // The API prevents it, but if it happened the silence would be worse:
    // the person would submit a form missing a question nobody can see.
    draw({ definition: form([{ field: 'sparito' }]), fields: [] })
    expect(screen.getByRole('alert').textContent).toBe('sparito')
  })
})

describe('required, help and errors', () => {
  it('a required field is marked, and the marker has a readable name', () => {
    draw({ fields: [field('titolo', 'text', { required: true })], requiredLabel: 'obbligatorio' })
    expect(screen.getByLabelText('obbligatorio')).toBeTruthy()
    expect((screen.getByLabelText('titolo*') as HTMLInputElement).required).toBe(true)
  })

  it('the FORM can require a field the library does not, and vice versa', () => {
    // The same field can be mandatory in one request and optional in another.
    draw({ definition: form([{ field: 'titolo', required: true }]), fields: [field('titolo', 'text', { required: false })] })
    expect((screen.getByRole('textbox') as HTMLInputElement).required).toBe(true)

    draw({ definition: form([{ field: 'titolo', required: false }]), fields: [field('titolo', 'text', { required: true })] })
    expect((screen.getAllByRole('textbox')[1] as HTMLInputElement).required).toBe(false)
  })

  it('the form\'s help wins over the library\'s: the same field needs different words in two requests', () => {
    draw({
      definition: form([{ field: 'titolo', help: { it: 'Quello del modulo' } }]),
      fields: [field('titolo', 'text', { help: 'Quello della libreria' })],
      language: 'it',
    })
    expect(screen.getByText('Quello del modulo')).toBeTruthy()
    expect(screen.queryByText('Quello della libreria')).toBeNull()
  })

  it('an error is announced, marks the control invalid, and is tied to it', () => {
    draw({ fields: [field('titolo')], errors: { titolo: 'Campo obbligatorio' } })
    const input = screen.getByLabelText('titolo')
    const error = screen.getByRole('alert')
    expect(error.textContent).toBe('Campo obbligatorio')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toContain(error.id)
  })

  it('help and error are both tied to the control when both are there', () => {
    draw({ fields: [field('titolo', 'text', { help: 'Spiegazione' })], errors: { titolo: 'Sbagliato' } })
    const describedBy = screen.getByLabelText('titolo').getAttribute('aria-describedby')!.split(' ')
    expect(describedBy).toHaveLength(2)
    for (const id of describedBy) expect(document.getElementById(id)).not.toBeNull()
  })

  it('with no error there is no aria-invalid and no describedby', () => {
    draw({ fields: [field('titolo')] })
    const input = screen.getByLabelText('titolo')
    expect(input.getAttribute('aria-invalid')).toBeNull()
    expect(input.getAttribute('aria-describedby')).toBeNull()
  })
})

describe('read-only and computed fields', () => {
  it('a read-only field shows the VALUE, not a disabled box', () => {
    // A greyed-out box says "you could type here, but no"; the value says
    // what is there, which is the only thing the reader cares about.
    draw({ definition: form([{ field: 'centro', readOnly: true }]), fields: [field('centro')], answers: { centro: 'IT-01' } })
    expect(screen.getByText('IT-01')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('a read-only field with no value yet shows a dash, not an empty box', () => {
    draw({ definition: form([{ field: 'centro', readOnly: true }]), fields: [field('centro')], answers: {} })
    expect(screen.getByText('—')).toBeTruthy()
  })

  it('a computed field is read-only and carries the badge that says where the value comes from', () => {
    draw({
      definition: form([{ field: 'totale' }]),
      fields: [field('totale', 'number', { formula: 'a * 2' })],
      answers: { totale: 42 },
      computedLabel: 'calcolato',
    })
    expect(screen.getByText('42')).toBeTruthy()
    expect(screen.getByText('calcolato')).toBeTruthy()
    expect(screen.queryByRole('spinbutton')).toBeNull()
  })

  it('a boolean and a list are rendered readably, not as "true" and "a,b"', () => {
    draw({
      definition: form([{ field: 'flag', readOnly: true }, { field: 'tag', readOnly: true }]),
      fields: [field('flag', 'boolean'), field('tag', 'multi_enum')],
      answers: { flag: true, tag: ['a', 'b'] },
      yesLabel: 'Sì', noLabel: 'No',
    })
    expect(screen.getByText('Sì')).toBeTruthy()
    expect(screen.getByText('a, b')).toBeTruthy()
  })

  it('a failed formula says so INSTEAD of the value: an empty field would look like missing data', () => {
    const { container } = draw({
      definition: form([{ field: 'totale' }]),
      fields: [field('totale', 'number', { formula: 'boom(' })],
      answers: {},
    })
    // The formula error arrives from the runner; here we pin that the value
    // slot is where it would go, and that nothing is editable meanwhile.
    expect(container.querySelector('.og-form-computed, .og-form-error')).not.toBeNull()
    expect(screen.queryByRole('spinbutton')).toBeNull()
  })
})

describe('visibility and the end user', () => {
  it('a field appears when its condition becomes true', () => {
    const def = form([
      { field: 'tipo' },
      { field: 'seriale', visibleWhen: { rules: [{ field: 'tipo', operator: 'equals', value: 'hw' }] } },
    ])
    const fields = [field('tipo'), field('seriale')]
    const { unmount } = draw({ definition: def, fields, answers: { tipo: 'sw' } })
    expect(screen.queryByLabelText('seriale')).toBeNull()
    unmount()
    draw({ definition: def, fields, answers: { tipo: 'hw' } })
    expect(screen.getByLabelText('seriale')).toBeTruthy()
  })

  it('a field not offered to the portal is hidden only for the end user', () => {
    const def = form([{ field: 'titolo' }, { field: 'interno', endUser: false }])
    const fields = [field('titolo'), field('interno')]
    const { unmount } = draw({ definition: def, fields, endUser: true })
    expect(screen.queryByLabelText('interno')).toBeNull()
    unmount()
    draw({ definition: def, fields, endUser: false })
    expect(screen.getByLabelText('interno')).toBeTruthy()
  })

  it('disabled disables every control at once', () => {
    draw({
      definition: form([{ field: 'titolo' }, { field: 'tipo' }]),
      fields: [field('titolo'), field('tipo', 'enum', { options: [{ value: 'a', label: 'A' }] })],
      disabled: true,
    })
    expect((screen.getByLabelText('titolo') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('tipo') as HTMLSelectElement).disabled).toBe(true)
  })
})

describe('no look, only structure', () => {
  it('the component writes classes and never an inline colour or size', () => {
    // The portal has none of the web's tokens: a colour written here would
    // be wrong in one of the two applications by construction.
    const { container } = draw({
      definition: form([{ field: 'titolo' }, { field: 'tipo' }]),
      fields: [field('titolo', 'text', { help: 'aiuto' }), field('tipo', 'enum', { options: [] })],
      errors: { titolo: 'x' },
    })
    for (const el of container.querySelectorAll('*')) {
      expect(el.getAttribute('style'), el.className).toBeNull()
    }
    expect(container.querySelector('.og-form')).not.toBeNull()
  })
})

describe('labels and help in the reader\'s language', () => {
  it('a field label follows the language when the library carries one', () => {
    draw({
      fields: [field('titolo', 'text', { label: 'Title', labels: [{ language: 'it', label: 'Titolo' }] })],
      language: 'it',
    })
    expect(screen.getByLabelText('Titolo')).toBeTruthy()
  })

  it('a language the field has no translation for falls back to the base label', () => {
    draw({
      fields: [field('titolo', 'text', { label: 'Title', labels: [{ language: 'it', label: 'Titolo' }] })],
      language: 'de',
    })
    expect(screen.getByLabelText('Title')).toBeTruthy()
  })

  it('the LIBRARY help is translated too, when the form has none of its own', () => {
    draw({
      fields: [field('titolo', 'text', { help: 'Be specific', helps: [{ language: 'it', label: 'Sii specifico' }] })],
      language: 'it',
    })
    expect(screen.getByText('Sii specifico')).toBeTruthy()
  })

  it('with no language asked, the base label and help are used', () => {
    draw({ fields: [field('titolo', 'text', { label: 'Title', labels: [{ language: 'it', label: 'Titolo' }], help: 'Base help' })] })
    expect(screen.getByLabelText('Title')).toBeTruthy()
    expect(screen.getByText('Base help')).toBeTruthy()
  })
})

describe('what the controls report back', () => {
  it('a textarea reports its text', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const { onChange } = draw({ definition: form([{ field: 'note' }]), fields: [field('note', 'textarea')] })
    await userEvent.type(screen.getByLabelText('note'), 'a')
    expect(onChange).toHaveBeenCalledWith('note', 'a')
  })

  it('a boolean reports true, false and null — never the string "true"', async () => {
    // Stored as a string it would fail every condition comparing a boolean,
    // and land on the ticket as text.
    const { default: userEvent } = await import('@testing-library/user-event')
    const { onChange } = draw({ definition: form([{ field: 'urgente' }]), fields: [field('urgente', 'boolean')] })
    const select = screen.getByLabelText('urgente')
    await userEvent.selectOptions(select, 'true')
    expect(onChange).toHaveBeenLastCalledWith('urgente', true)
    await userEvent.selectOptions(select, 'false')
    expect(onChange).toHaveBeenLastCalledWith('urgente', false)
    await userEvent.selectOptions(select, '')
    expect(onChange).toHaveBeenLastCalledWith('urgente', null)
  })

  it('an enum reports the VALUE, not the label, and null when cleared', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const { onChange } = draw({
      definition: form([{ field: 'tipo' }]),
      fields: [field('tipo', 'enum', { options: [{ value: 'hw', label: 'Hardware' }] })],
    })
    await userEvent.selectOptions(screen.getByLabelText('tipo'), 'hw')
    expect(onChange).toHaveBeenLastCalledWith('tipo', 'hw')
  })

  it('a boolean shows the stored value, including false', () => {
    // `false` is a real answer: rendering it as "not answered" would lose it.
    draw({ definition: form([{ field: 'urgente' }]), fields: [field('urgente', 'boolean')], answers: { urgente: false } })
    expect((screen.getByLabelText('urgente') as HTMLSelectElement).value).toBe('false')
  })
})
