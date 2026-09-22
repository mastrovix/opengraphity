/**
 * ATTACHMENTS, REFERENCES AND REPEATABLE TABLES — the three field types whose
 * STATE is not an answer.
 *
 * Files, chosen references and table rows all live with the caller, not in
 * `answers`, because none of them is a value: a file is an upload, a
 * reference is a relation, a row is a node. What this renderer owns is what
 * the person sees and what it asks the caller to do.
 *
 * The portal has no CMDB search, and that is a case the renderer handles
 * rather than ignores: it SAYS the search is unavailable instead of showing a
 * box that finds nothing — an end user does not browse the CMDB.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CatalogFormDefinition } from '@opengraphity/types'
import { CatalogFormRenderer, type CatalogFormFieldView } from '../CatalogFormRenderer.js'

afterEach(cleanup)

const field = (name: string, fieldType: string, over: Partial<CatalogFormFieldView> = {}): CatalogFormFieldView =>
  ({ name, fieldType, label: name, required: false, ...over })

const form = (items: Array<Record<string, unknown>>): CatalogFormDefinition =>
  ({ version: 1, revision: 1, sections: [{ id: 's1', title: { it: 'Dati' }, items }] } as unknown as CatalogFormDefinition)

function draw(fields: CatalogFormFieldView[], over: Record<string, unknown> = {}) {
  const props = {
    definition: form(fields.map((f) => ({ field: f.name }))),
    fields, answers: {}, onChange: vi.fn(),
    ...over,
  } as Parameters<typeof CatalogFormRenderer>[0]
  return render(<CatalogFormRenderer {...props} />)
}

describe('attachment fields', () => {
  const allegato = [field('documento', 'attachment', { label: 'Documento' })]

  it('with no upload handler there is no file input at all', () => {
    // The caller decides whether uploading is possible here; offering a
    // control that leads nowhere is worse than not offering it.
    draw(allegato)
    expect(document.querySelector('input[type=file]')).toBeNull()
  })

  it('the file input is named by the field label, through aria-labelledby', () => {
    // The label cannot use htmlFor for a file input inside its own wrapper
    // label, so it carries an id the input points back to.
    draw(allegato, { onUploadFile: vi.fn() })
    expect(screen.getByLabelText('Documento').getAttribute('type')).toBe('file')
  })

  it('picking a file hands it to the caller, with the field it answers', async () => {
    const onUploadFile = vi.fn()
    draw(allegato, { onUploadFile })
    const input = screen.getByLabelText('Documento') as HTMLInputElement
    await userEvent.upload(input, new File(['x'], 'contratto.pdf', { type: 'application/pdf' }))
    expect(onUploadFile).toHaveBeenCalledWith('documento', expect.objectContaining({ name: 'contratto.pdf' }))
  })

  it('the control is emptied after each pick, so the SAME file can be uploaded again', async () => {
    // Without this the browser fires no event for an identical second pick,
    // and it looks like nothing happened.
    const onUploadFile = vi.fn()
    draw(allegato, { onUploadFile })
    const input = screen.getByLabelText('Documento') as HTMLInputElement
    await userEvent.upload(input, new File(['x'], 'contratto.pdf'))
    expect(input.value).toBe('')
  })

  it('uploaded files are listed with their size, and can be removed one by one', async () => {
    const onRemoveFile = vi.fn()
    draw(allegato, {
      onUploadFile: vi.fn(), onRemoveFile, fileRemoveLabel: 'Togli',
      files: { documento: [{ id: 'a1', filename: 'contratto.pdf', sizeBytes: 2048 }] },
    })
    expect(screen.getByText('contratto.pdf')).toBeTruthy()
    expect(screen.getByText('2 kB')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Togli contratto.pdf' }))
    expect(onRemoveFile).toHaveBeenCalledWith('documento', 'a1')
  })

  it.each([
    [512,             '512 B'],
    [2048,            '2 kB'],
    [1024 * 1024,     '1.0 MB'],
    [3 * 1024 * 1024, '3.0 MB'],
  ])('a size of %i bytes reads as %s', (sizeBytes, text) => {
    draw(allegato, { onUploadFile: vi.fn(), files: { documento: [{ id: 'a1', filename: 'f', sizeBytes }] } })
    expect(screen.getByText(text)).toBeTruthy()
  })

  it('while an upload is running the control is closed and says so', () => {
    draw(allegato, { onUploadFile: vi.fn(), uploadingField: 'documento' })
    expect((screen.getByLabelText('Documento') as HTMLInputElement).disabled).toBe(true)
  })

  it('a disabled form shows the files but offers no remove button', () => {
    draw(allegato, {
      onUploadFile: vi.fn(), onRemoveFile: vi.fn(), disabled: true,
      files: { documento: [{ id: 'a1', filename: 'contratto.pdf', sizeBytes: 10 }] },
    })
    expect(screen.getByText('contratto.pdf')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('reference fields', () => {
  const riferimento = [field('ci', 'ref_ci', { label: 'CI impattato' })]

  it('without a search handler it SAYS so instead of showing a box that finds nothing', () => {
    // This is the portal: an end user does not browse the CMDB.
    draw(riferimento, { referenceUnavailableLabel: 'Ricerca non disponibile dal portale' })
    expect(screen.getByText('Ricerca non disponibile dal portale')).toBeTruthy()
    expect(screen.queryByRole('searchbox')).toBeNull()
  })

  it('a short query asks nothing: two characters is the floor', async () => {
    // One letter matches half the CMDB; asking the server for it is a round
    // trip that cannot produce a usable list.
    const onSearchReference = vi.fn(async () => [])
    draw(riferimento, { onSearchReference, onPickReference: vi.fn() })
    await userEvent.type(screen.getByRole('searchbox'), 'a')
    expect(onSearchReference).not.toHaveBeenCalled()
  })

  it('from two characters it searches, passing the FIELD so the caller can filter by CI type', async () => {
    // The field carries refTypes: without them a "which printer?" question
    // also offered the firewalls.
    const onSearchReference = vi.fn(async () => [{ id: 'ci-1', label: 'Stampante 1' }])
    draw([field('ci', 'ref_ci', { label: 'CI', refTypes: ['printer'] })], { onSearchReference, onPickReference: vi.fn() })
    await userEvent.type(screen.getByRole('searchbox'), 'st')
    expect(onSearchReference).toHaveBeenCalledWith(expect.objectContaining({ name: 'ci', refTypes: ['printer'] }), 'st')
    expect(await screen.findByRole('button', { name: 'Stampante 1' })).toBeTruthy()
  })

  it('picking a result hands it to the caller and clears the search', async () => {
    const onPickReference = vi.fn()
    draw(riferimento, { onSearchReference: vi.fn(async () => [{ id: 'ci-1', label: 'Server A' }]), onPickReference })
    await userEvent.type(screen.getByRole('searchbox'), 'se')
    await userEvent.click(await screen.findByRole('button', { name: 'Server A' }))
    expect(onPickReference).toHaveBeenCalledWith('ci', { id: 'ci-1', label: 'Server A' })
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('')
  })

  it('a search with no results says so, instead of leaving an empty list', async () => {
    draw(riferimento, { onSearchReference: vi.fn(async () => []), onPickReference: vi.fn(), referenceNoResultsLabel: 'Nessun risultato' })
    await userEvent.type(screen.getByRole('searchbox'), 'zz')
    expect(await screen.findByText('Nessun risultato')).toBeTruthy()
  })

  it('once chosen, the reference shows its label and a way to clear it', async () => {
    const onPickReference = vi.fn()
    draw(riferimento, {
      onSearchReference: vi.fn(), onPickReference, referenceClearLabel: 'Togli',
      references: { ci: [{ id: 'ci-1', label: 'Server A' }] },
    })
    expect(screen.getByText('Server A')).toBeTruthy()
    expect(screen.queryByRole('searchbox')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Togli' }))
    expect(onPickReference).toHaveBeenCalledWith('ci', null)
  })

  it('a disabled form shows the chosen reference but no clear button', () => {
    draw(riferimento, {
      onSearchReference: vi.fn(), onPickReference: vi.fn(), disabled: true,
      references: { ci: [{ id: 'ci-1', label: 'Server A' }] },
    })
    expect(screen.getByText('Server A')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('repeatable tables', () => {
  const colonne = [
    { name: 'modello', fieldType: 'text', label: 'Modello', required: true },
    { name: 'quantita', fieldType: 'number', label: 'Quantità' },
    { name: 'urgente', fieldType: 'boolean', label: 'Urgente' },
    { name: 'taglia', fieldType: 'enum', label: 'Taglia', options: [{ value: 's', label: 'S' }] },
    { name: 'quando', fieldType: 'date', label: 'Quando' },
    { name: 'strano', fieldType: 'un_tipo_futuro', label: 'Strano' },
  ]
  const tabella = [field('righe', 'table', { label: 'Righe', tableColumns: colonne })]

  it('the columns become table headers, with the required ones marked', () => {
    draw(tabella, { tables: {}, onTablesChange: vi.fn() })
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).toContain('Modello *')
    expect(headers).toContain('Quantità')
  })

  it('an empty table does NOT start with a blank row: it invites explicitly', () => {
    // A table born with a row in it looks like it is asking for something,
    // and if the person does not touch it the server drops it anyway.
    draw(tabella, { tables: {}, onTablesChange: vi.fn(), tableAddRowLabel: 'Aggiungi riga' })
    expect(screen.getAllByRole('row')).toHaveLength(2)     // header + the "—" row
    expect(screen.getByRole('button', { name: 'Aggiungi riga' })).toBeTruthy()
  })

  it('adding a row hands the caller a row with every column present and empty', async () => {
    const onTablesChange = vi.fn()
    draw(tabella, { tables: {}, onTablesChange, tableAddRowLabel: 'Aggiungi' })
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi' }))
    expect(onTablesChange).toHaveBeenCalledWith('righe', [
      { modello: '', quantita: '', urgente: '', taglia: '', quando: '', strano: '' },
    ])
  })

  it('every column type gets its own control, and an unknown type falls back to text', () => {
    // A column type this renderer does not know shows the value as text
    // instead of showing nothing at all.
    draw(tabella, { tables: { righe: [{ modello: 'X1', quantita: '2', urgente: 'true', taglia: 's', quando: '2026-01-01', strano: 'v' }] }, onTablesChange: vi.fn() })
    const row = screen.getAllByRole('row')[1]!
    const cells = within(row).getAllByRole('cell')
    expect(within(cells[0]!).getByDisplayValue('X1').getAttribute('type')).toBe('text')
    const number = within(cells[1]!).getByDisplayValue('2') as HTMLInputElement
    expect(number.type).toBe('number')
    expect(number.inputMode).toBe('decimal')      // the touch keyboard, again
    expect(within(cells[2]!).getByRole('combobox')).toBeTruthy()
    expect(within(cells[3]!).getByRole('combobox')).toBeTruthy()
    expect(within(cells[4]!).getByDisplayValue('2026-01-01').getAttribute('type')).toBe('date')
    expect(within(cells[5]!).getByDisplayValue('v').getAttribute('type')).toBe('text')
  })

  it('editing a cell reports the WHOLE table back, with only that cell changed', async () => {
    const onTablesChange = vi.fn()
    draw(tabella, { tables: { righe: [{ modello: 'X1' }, { modello: 'X2' }] }, onTablesChange })
    await userEvent.type(within(screen.getAllByRole('row')[2]!).getByDisplayValue('X2'), '!')
    expect(onTablesChange).toHaveBeenLastCalledWith('righe', [{ modello: 'X1' }, { modello: 'X2!' }])
  })

  it('removing a row removes that one', async () => {
    const onTablesChange = vi.fn()
    draw(tabella, { tables: { righe: [{ modello: 'X1' }, { modello: 'X2' }] }, onTablesChange, tableRemoveRowLabel: 'Togli' })
    await userEvent.click(screen.getAllByRole('button', { name: 'Togli' })[0]!)
    expect(onTablesChange).toHaveBeenCalledWith('righe', [{ modello: 'X2' }])
  })

  it('without an onTablesChange the table is READ, not filled in: the builder preview', () => {
    draw(tabella, { tables: { righe: [{ modello: 'X1' }] } })
    expect(screen.queryByRole('button')).toBeNull()
    expect((within(screen.getAllByRole('row')[1]!).getByDisplayValue('X1') as HTMLInputElement).disabled).toBe(true)
  })

  it('a disabled form is read-only too, even with a change handler', () => {
    draw(tabella, { tables: { righe: [{ modello: 'X1' }] }, onTablesChange: vi.fn(), disabled: true })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('a required table is marked, and its error is announced', () => {
    draw(tabella, {
      definition: form([{ field: 'righe', required: true }]),
      tables: {}, onTablesChange: vi.fn(),
      requiredLabel: 'obbligatorio', errors: { righe: 'Serve almeno una riga' },
    })
    expect(screen.getByLabelText('obbligatorio')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('Serve almeno una riga')
  })
})
