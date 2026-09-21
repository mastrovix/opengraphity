/** Secondo giro UI del 15 set 2026: le etichette dei moduli non erano legate ai loro controlli. */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FieldWrapper } from './FieldWrapper'
import { Input, LabelledField, Select } from './ui/FormControls'

describe('etichette legate ai controlli', () => {
  it('FieldWrapper: l\'etichetta dà il nome al controllo, e l\'errore gli si lega', () => {
    render(<FieldWrapper visible label="Title" error="Required field"><input type="text" /></FieldWrapper>)
    const input = screen.getByRole('textbox', { name: 'Title' })
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('Required field')
  })

  it('FieldWrapper: un id già dato resta quello', () => {
    render(<FieldWrapper visible label="Title"><input id="mine" type="text" /></FieldWrapper>)
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveAttribute('id', 'mine')
  })

  it('LabelledField: Input e Select prendono il nome dall\'etichetta del campo', () => {
    render(<>
      <LabelledField label="Label"><Input /></LabelledField>
      <LabelledField label="Cardinality"><Select><option>One</option></Select></LabelledField>
    </>)
    expect(screen.getByRole('textbox', { name: 'Label' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Cardinality' })).toBeInTheDocument()
  })
})
