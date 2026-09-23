/**
 * A VALUE WITHOUT A LABEL, SHOWN THE WAY A PERSON WROTE IT (D29, tour of 23 Sep 2026).
 *
 * The catalog form showed «Pick Up At The IT Desk» for the stored value «Pick
 * up at the IT desk»: the API's fallback capitalised every word, and so did
 * five copies of the same rule in the web. One rule now, the same in the API:
 * sentences stay as they are, machine keys become sentences, anything else is
 * left alone.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within, cleanup } from '@testing-library/react'
import type { CatalogFormDefinition } from '@opengraphity/types'
import { humanizeValue, optionLabel } from '../valueLabel.js'
import { CatalogFormRenderer, type CatalogFormFieldView } from '../CatalogFormRenderer.js'

afterEach(cleanup)

describe('humanizeValue', () => {
  it('a value written with spaces is shown as it is', () => {
    expect(humanizeValue('Pick up at the IT desk')).toBe('Pick up at the IT desk')
    expect(humanizeValue('ship to home')).toBe('ship to home')
  })

  it('a machine key becomes a sentence: only the first letter is capitalised', () => {
    expect(humanizeValue('in_progress')).toBe('In progress')
    expect(humanizeValue('database_instance')).toBe('Database instance')
    expect(humanizeValue('active')).toBe('Active')
    expect(humanizeValue('v2_api')).toBe('V2 api')
  })

  it('an UPPER_SNAKE key (a relation type) becomes a sentence too', () => {
    expect(humanizeValue('HOSTED_ON')).toBe('Hosted on')
    expect(humanizeValue('PARENT_OF')).toBe('Parent of')
  })

  it('anything else is not guessed at: CamelCase, an acronym, a hyphen, punctuation', () => {
    for (const v of ['DatabaseInstance', 'IT', 'e-mail', 'SAP/ERP', 'iPhone', '']) expect(humanizeValue(v)).toBe(v)
  })
})

describe('optionLabel — the label the API sent with an option', () => {
  it('a label written in the Dictionary always wins', () => {
    expect(optionLabel('Pick up at the IT desk', 'Collect at the IT desk')).toBe('Collect at the IT desk')
    expect(optionLabel('desk', 'Ritiro al banco IT')).toBe('Ritiro al banco IT')
  })

  it('a label that arrives is shown as it is: «In Progress» may be what the customer wrote', () => {
    expect(optionLabel('in_progress', 'In Progress')).toBe('In Progress')
  })

  it('no label at all: the value, humanized', () => {
    expect(optionLabel('in_progress', null)).toBe('In progress')
    expect(optionLabel('in_progress', '')).toBe('In progress')
    expect(optionLabel('Home delivery', undefined)).toBe('Home delivery')
  })
})

describe('the catalog form shows the sentence the customer wrote (D29)', () => {
  const field = (over: Partial<CatalogFormFieldView>): CatalogFormFieldView =>
    ({ name: 'consegna', fieldType: 'enum', label: 'Delivery', required: false, ...over })
  const definition = { version: 1, revision: 1, sections: [{ id: 's1', title: { en: 'Data' }, items: [{ field: 'consegna' }] }] } as unknown as CatalogFormDefinition
  const options = [
    // what the API sends for a sentence without a label: the sentence (enumValueLabels.ts, humanizeValue)
    { value: 'Pick up at the IT desk', label: 'Pick up at the IT desk' },
    { value: 'courier', label: 'By courier' },
  ]

  it('single choice', () => {
    render(<CatalogFormRenderer definition={definition} fields={[field({ options })]} answers={{}} onChange={vi.fn()} />)
    const select = screen.getByRole('combobox', { name: /Delivery/ })
    // getByRole throws when the option is not there.
    expect(within(select).getByRole('option', { name: 'Pick up at the IT desk' })).toBeTruthy()
    expect(within(select).getByRole('option', { name: 'By courier' })).toBeTruthy()
    expect(within(select).queryByRole('option', { name: 'Pick Up At The IT Desk' })).toBeNull()
  })

  it('multiple choice', () => {
    render(<CatalogFormRenderer definition={definition} fields={[field({ fieldType: 'multi_enum', options })]} answers={{}} onChange={vi.fn()} />)
    expect(screen.getByRole('checkbox', { name: 'Pick up at the IT desk' })).toBeTruthy()
  })
})
