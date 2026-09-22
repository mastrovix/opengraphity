/**
 * The form designer canvas: it draws the form as the requester will see it,
 * and every field and section is selectable.
 *
 * Why these behaviours matter:
 * - selection is the ONLY way to reach the properties modal: if a click (or
 *   Enter/Space from the keyboard) stops reporting the right section/field
 *   indexes, the builder edits the wrong field or nothing at all;
 * - the `data-drop` keys are what the drag engine looks up in the DOM: a
 *   renamed key silently disables drag and drop;
 * - the "missing title in EN" warning exists because publishing refuses such a
 *   form, and the owner only found out after designing the whole form;
 * - the dashed drop box must fill the free cell of a two-column grid, or the
 *   grid is left with a hole.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CatalogFormDefinition, CatalogFormItem } from '@opengraphity/types'
import { FormCanvas, IconaTipo, cellaLibera, stessaSelezione, type Selezione } from './FormCanvas'
import type { FormFieldRow } from './FieldLibraryPanel'

function field(name: string, fieldType: string, extra: Partial<FormFieldRow> = {}): FormFieldRow {
  return {
    id: `f-${name}`, name, fieldType, label: `Label ${name}`, labels: [], help: null, helps: [],
    required: false, vocabulary: null, inList: false, formula: null, validationScript: null,
    tableDefinition: null, usedBy: [], options: [], ...extra,
  }
}

const ALL_TYPES = ['text', 'textarea', 'number', 'date', 'datetime', 'boolean', 'enum', 'multi_enum',
  'note', 'attachment', 'ref_ci', 'ref_user', 'ref_team', 'table'] as const

function renderCanvas(overrides: Partial<Parameters<typeof FormCanvas>[0]> = {}) {
  const onSeleziona = vi.fn()
  const props: Parameters<typeof FormCanvas>[0] = {
    bozza: { version: 1, revision: 0, sections: [] },
    perNome: new Map(),
    lingua: 'en',
    lingue: ['en'],
    selezione: null,
    bersaglio: null,
    onSeleziona,
    maniglia: (iSez, iVoce) => <button type="button">{`grip ${String(iSez)}-${String(iVoce)}`}</button>,
    manigliaSezione: (iSez) => <button type="button">{`section grip ${String(iSez)}`}</button>,
    ...overrides,
  }
  const view = render(<FormCanvas {...props} />)
  return { ...view, onSeleziona }
}

describe('stessaSelezione', () => {
  it('matches only the same kind with the same indexes', () => {
    const sec0: Selezione = { tipo: 'section', iSez: 0 }
    const item00: Selezione = { tipo: 'item', iSez: 0, iVoce: 0 }
    expect(stessaSelezione(null, sec0)).toBe(false)
    expect(stessaSelezione(sec0, null)).toBe(false)
    expect(stessaSelezione(sec0, item00)).toBe(false)
    expect(stessaSelezione(sec0, { tipo: 'section', iSez: 0 })).toBe(true)
    expect(stessaSelezione(sec0, { tipo: 'section', iSez: 1 })).toBe(false)
    expect(stessaSelezione(item00, { tipo: 'item', iSez: 0, iVoce: 0 })).toBe(true)
    // Same section, different field: a different field must not look selected.
    expect(stessaSelezione(item00, { tipo: 'item', iSez: 0, iVoce: 1 })).toBe(false)
  })
})

describe('cellaLibera', () => {
  const half: CatalogFormItem = { field: 'a' }
  const full: CatalogFormItem = { field: 'b', width: 'full' }
  it('a one-column section never has a free cell', () => {
    expect(cellaLibera({ items: [half] })).toBe(false)
    expect(cellaLibera({ columns: 1, items: [half] })).toBe(false)
  })
  it('two columns: an odd number of half fields leaves a hole, a full row resets it', () => {
    expect(cellaLibera({ columns: 2, items: [] })).toBe(false)
    expect(cellaLibera({ columns: 2, items: [half] })).toBe(true)
    expect(cellaLibera({ columns: 2, items: [half, half] })).toBe(false)
    expect(cellaLibera({ columns: 2, items: [half, full] })).toBe(false)
    expect(cellaLibera({ columns: 2, items: [full, half] })).toBe(true)
  })
})

describe('IconaTipo', () => {
  it('names the type for screen readers, and falls back to the text icon for an unknown type', () => {
    render(<><IconaTipo tipo="date" /><IconaTipo tipo="mystery" size={20} /></>)
    expect(screen.getByRole('img', { name: 'Date' })).toHaveAttribute('title', 'Date')
    // An unknown type still gets an icon (no crash, no empty slot).
    expect(screen.getAllByRole('img')).toHaveLength(2)
  })
})

describe('FormCanvas', () => {
  it('draws every field type with its label and the type icon', () => {
    const perNome = new Map(ALL_TYPES.map((tp) => [tp, field(tp, tp)] as const))
    const bozza: CatalogFormDefinition = {
      version: 1, revision: 1,
      sections: [{ id: 'main', title: { en: 'Main' }, items: ALL_TYPES.map((tp) => ({ field: tp })) }],
    }
    renderCanvas({ bozza, perNome })
    for (const tp of ALL_TYPES) {
      expect(screen.getByRole('button', { name: `Label ${tp}` })).toBeInTheDocument()
    }
    // The boolean mock control shows the yes/no hint, the note shows its text.
    expect(screen.getByText(/Yes \/ No/)).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Table (rows)' })).toBeInTheDocument()
  })

  it('a field missing from the library is still drawn, by its internal name, as text', () => {
    const bozza: CatalogFormDefinition = {
      version: 1, revision: 1,
      sections: [{ id: 'main', title: { en: 'Main' }, items: [{ field: 'orphan' }] }],
    }
    renderCanvas({ bozza })
    const tile = screen.getByRole('button', { name: 'orphan' })
    expect(within(tile).getByRole('img', { name: 'Text' })).toBeInTheDocument()
  })

  it('marks required, conditional, read-only and computed fields', () => {
    const perNome = new Map([
      ['req', field('req', 'text', { required: true })],
      ['cond', field('cond', 'text', { formula: '' })],
      ['calc', field('calc', 'number', { formula: 'a + b', help: 'Computed total' })],
    ])
    const bozza: CatalogFormDefinition = {
      version: 1, revision: 1,
      sections: [{
        id: 'main', title: { en: 'Main' }, items: [
          { field: 'req' },
          { field: 'cond', visibleWhen: { match: 'all', rules: [] } as unknown as CatalogFormItem['visibleWhen'] },
          { field: 'calc', readOnly: true, required: false },
        ],
      }],
    }
    renderCanvas({ bozza, perNome })
    const req = screen.getByRole('button', { name: 'Label req' })
    expect(within(req).getByText('*')).toBeInTheDocument()
    const cond = screen.getByRole('button', { name: 'Label cond' })
    expect(within(cond).getByTitle('It appears only when a condition is true')).toBeInTheDocument()
    // An empty formula is not a computed field.
    expect(within(cond).queryByText('ƒ')).toBeNull()
    const calc = screen.getByRole('button', { name: 'Label calc' })
    expect(within(calc).getByTitle('Read-only in this form')).toBeInTheDocument()
    expect(within(calc).getByText('ƒ')).toBeInTheDocument()
    // The form-level `required: false` wins over nothing: no asterisk.
    expect(within(calc).queryByText('*')).toBeNull()
  })

  it('selecting a field or a section reports its indexes, by click and by keyboard', async () => {
    const user = userEvent.setup()
    const perNome = new Map([['a', field('a', 'text')], ['b', field('b', 'text')]])
    const bozza: CatalogFormDefinition = {
      version: 1, revision: 1,
      sections: [
        { id: 's0', title: { en: 'First' }, items: [{ field: 'a' }] },
        { id: 's1', title: { en: 'Second' }, items: [{ field: 'a2' }, { field: 'b' }] },
      ],
    }
    const { onSeleziona } = renderCanvas({ bozza, perNome })
    await user.click(screen.getByRole('button', { name: 'Label b' }))
    expect(onSeleziona).toHaveBeenLastCalledWith({ tipo: 'item', iSez: 1, iVoce: 1 })
    await user.click(screen.getByRole('button', { name: 'Second' }))
    expect(onSeleziona).toHaveBeenLastCalledWith({ tipo: 'section', iSez: 1 })

    screen.getByRole('button', { name: 'Label a' }).focus()
    await user.keyboard('{Enter}')
    expect(onSeleziona).toHaveBeenLastCalledWith({ tipo: 'item', iSez: 0, iVoce: 0 })

    // The grip handles are passed the right indexes too: the drag engine relies on them.
    expect(screen.getByRole('button', { name: 'grip 1-1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'section grip 1' })).toBeInTheDocument()
  })

  it('shows the selected field as pressed and exposes the drop keys', () => {
    const bozza: CatalogFormDefinition = {
      version: 1, revision: 1,
      sections: [{ id: 's0', title: { en: 'First' }, columns: 2, items: [{ field: 'a' }, { field: 'b' }] }],
    }
    const { container } = renderCanvas({
      bozza, selezione: { tipo: 'item', iSez: 0, iVoce: 1 }, bersaglio: 'item-0-0',
    })
    expect(screen.getByRole('button', { name: 'b' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'a' })).toHaveAttribute('aria-pressed', 'false')
    for (const key of ['sec-0', 'ord-0', 'item-0-0', 'item-0-1']) {
      expect(container.querySelector(`[data-drop="${key}"]`)).not.toBeNull()
    }
    expect(screen.getByText('Two columns')).toBeInTheDocument()
  })

  it('an untitled section says so, and a title missing in another language is flagged', () => {
    const bozza: CatalogFormDefinition = {
      version: 1, revision: 1,
      sections: [
        { id: 'untitled', title: {}, items: [] },
        { id: 'partial', title: { it: 'Principale', en: '  ' }, items: [] },
      ],
    }
    renderCanvas({ bozza, lingua: 'it', lingue: ['it', 'en'], selezione: { tipo: 'section', iSez: 0 }, bersaglio: 'sec-1' })
    expect(screen.getByRole('button', { name: 'Section with no title' })).toBeInTheDocument()
    expect(screen.getByText('No title in IT, EN')).toBeInTheDocument()
    // A blank (whitespace) title counts as missing: publishing refuses it too.
    expect(screen.getByText('No title in EN')).toBeInTheDocument()
    expect(screen.getAllByText('One column')).toHaveLength(2)
    // The dashed drop box is always there, even in an empty section.
    expect(screen.getAllByText('Drop it here to add it to this section.')).toHaveLength(2)
  })
})
