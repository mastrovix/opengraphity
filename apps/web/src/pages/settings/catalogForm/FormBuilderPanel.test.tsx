/**
 * THE FORM BUILDER: where an administrator designs the form of a catalog item.
 *
 * What a requester fills in, in the portal and in the workspace, is exactly
 * what is published from here, so a regression lands on real requests:
 *  - the form of the WRONG item is overwritten (the owner lost a field that
 *    way: no item is preselected, and publishing names the item it writes);
 *  - a draft is lost without asking when switching item;
 *  - a field lands in a section other than the chosen one, or an edit made in
 *    the properties never reaches what is published;
 *  - a new field is put on the form before it exists in the library (the form
 *    would not save), or a condition looks at a field that carries no answer.
 * These tests drive the panel as an administrator does — choosing, clicking,
 * typing — and read what is on screen and what is sent to the API. Dragging
 * and the AI designer are in `FormBuilderPanel.more.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'
import { emptyCatalogForm } from '@opengraphity/types'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import {
  ITEMS, LAPTOP_FORM, LIBRARY, afterMutation, answerForms, chooseItem, fieldsIn, libraryField, openItem, prepareApollo,
  publish, sectionOrder, sectionTitled, withDictionary,
} from './__tests__/formBuilderFixtures'

/*
 * Apollo Client 4 calls a mutation's `onError` AND then rejects its promise
 * (`react/hooks/useMutation.js`); the shared fake resolves instead. The panel
 * handles a refusal on the rejecting path only, so here a refused mutation
 * rejects, as it does in the app — and a refusal the panel forgot to catch
 * fails the run as an unhandled rejection.
 */
vi.mock('@apollo/client/react', async () => {
  const { moduloApollo } = await import('@/test/apolloFinto')
  const base = moduloApollo()
  type Execute = (o?: Record<string, unknown>) => Promise<{ data?: unknown; errors?: Error[] }>
  return {
    ...base,
    useMutation: (doc: Parameters<typeof base.useMutation>[0], opts?: Parameters<typeof base.useMutation>[1]) => {
      const [execute, state] = base.useMutation(doc, opts) as unknown as [Execute, unknown]
      const likeApollo4 = async (o?: Record<string, unknown>) => {
        const r = await execute(o)
        if (r.errors?.[0]) throw r.errors[0]
        return r
      }
      return [likeApollo4, state]
    },
  }
})
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { FormBuilderPanel } = await import('./FormBuilderPanel')

beforeEach(() => {
  prepareApollo()
  toast.success.mockReset()
  toast.error.mockReset()
  toast.info.mockReset()
  // jsdom has no layout, so no `elementFromPoint`: a click on a grip starts
  // (and at once ends) a drag, which asks what is under the pointer.
  document.elementFromPoint = vi.fn(() => null)
})

/** Opens the panel on an item, with its stored form on the canvas. */
async function openOn(name = 'New laptop', ui = <FormBuilderPanel />) {
  const r = renderWithProviders(ui)
  await openItem(r.user, name)
  return r
}

/** Presses a key on a grip, found again each time: a move re-renders the canvas. */
async function pressOn(user: UserEvent, grip: RegExp, key: string) {
  screen.getByRole('button', { name: grip }).focus()
  await user.keyboard(key)
}

const dialogNamed = (name: string) => screen.getByRole('dialog', { name })
/** A properties modal is closed by its «×», whose name is «Cancel». */
const closeDialog = async (user: UserEvent, name: string) => {
  await user.click(within(dialogNamed(name)).getAllByRole('button', { name: 'Cancel' })[0]!)
  await waitFor(() => expect(screen.queryByRole('dialog', { name })).toBeNull())
}
const optionsOf = (select: HTMLElement) => within(select).getAllByRole('option').map((o) => o.textContent)

describe('choosing the item', () => {
  it('with no active catalog item there is nothing to design', () => {
    apolloFinto.risposte['GetServiceCatalogAdmin'] = { serviceCatalogItems: [ITEMS[2]] }
    renderWithProviders(<FormBuilderPanel />)
    expect(screen.getByText(/There is no active catalog item to build a form for/)).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Service request' })).toBeNull()
  })

  it('nothing is preselected: until an item is chosen there is no canvas and nothing to publish', () => {
    renderWithProviders(<FormBuilderPanel />)
    const itemSelect = screen.getByRole('combobox', { name: 'Service request' })
    expect(itemSelect).toHaveValue('')
    // Only the active items are offered.
    expect(optionsOf(itemSelect)).toEqual(['Choose a service request', 'New laptop', 'App access'])
    expect(screen.getByText(/Choose a service request above/)).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByRole('button', { name: 'Save and publish' })).toBeDisabled()
    expect(screen.getByText('No form yet')).toBeInTheDocument()
    // The form of no item is even asked for.
    expect(apolloFinto.chiamate['GetCatalogForm']).toBeUndefined()
  })

  it('choosing an item loads its published form onto the canvas', async () => {
    await openOn('New laptop')
    expect(apolloFinto.chiamata('GetCatalogForm')).toEqual({ itemId: 'i-laptop' })
    expect(screen.getByText('Published revision 3')).toBeInTheDocument()
    expect(sectionOrder()).toEqual(['Details', 'Money'])
    expect(fieldsIn('Details')).toEqual(['Requester', 'Urgent'])
    expect(fieldsIn('Money')).toEqual(['Cost centre'])
    // The canvas says whose form it is; nothing changed yet, so nothing to publish.
    expect(screen.getByText('New laptop', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.queryByText('Changes not published yet')).toBeNull()
    expect(screen.getByRole('button', { name: 'Save and publish' })).toBeDisabled()
    expect(screen.getByRole('tab', { name: 'Designer' })).toHaveAttribute('aria-selected', 'true')
  })

  it('a stored form that cannot be read opens as an empty form, not as the one open before', async () => {
    answerForms({
      'i-laptop': { revision: 3, definition: LAPTOP_FORM },
      'i-access': { revision: 2, definition: '{not json' },
    })
    const { user } = await openOn('New laptop')
    await openItem(user, 'App access')
    expect(screen.getByText('Published revision 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Section with no title' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Requester' })).toBeNull()
  })

  it('switching item with unpublished changes asks first; saying no keeps the draft', async () => {
    const { user } = await openOn('New laptop')
    await user.click(screen.getByRole('button', { name: 'Add a section' }))
    expect(screen.getByText('Changes not published yet')).toBeInTheDocument()

    await chooseItem(user, 'App access')
    const question = await screen.findByRole('dialog', { name: 'Discard the draft?' })
    expect(within(question).getByText(/unpublished changes/)).toBeInTheDocument()
    await user.click(within(question).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Discard the draft?' })).toBeNull())
    expect(screen.getByRole('combobox', { name: 'Service request' })).toHaveValue('i-laptop')
    expect(sectionOrder()).toEqual(['Details', 'Money', '3'])

    await chooseItem(user, 'App access')
    await user.click(within(await screen.findByRole('dialog', { name: 'Discard the draft?' })).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(sectionOrder()).toEqual(['1']))
    expect(screen.getByRole('combobox', { name: 'Service request' })).toHaveValue('i-access')
    expect(screen.getByText('No form yet')).toBeInTheDocument()
    expect(screen.queryByText('Changes not published yet')).toBeNull()
  })

  /*
   * Found in the tour of 23 Sep 2026, fixed: after a switch the previous
   * item's draft stayed on the canvas, still unpublished, until the new form
   * arrived — and could be published onto the item just chosen.
   */
  it('switching item takes the old draft away until the new form arrives, and nothing can be published meanwhile', async () => {
    // The form of «App access» has not arrived yet.
    answerForms({ 'i-laptop': { revision: 3, definition: LAPTOP_FORM } })
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: 'Add a section' }))
    await chooseItem(user, 'App access')
    await user.click(within(await screen.findByRole('dialog', { name: 'Discard the draft?' })).getByRole('button', { name: 'Delete' }))

    expect(await screen.findByText('Loading the form of «App access»…')).toHaveAttribute('role', 'status')
    expect(sectionOrder()).toEqual([])
    expect(screen.queryByText('Changes not published yet')).toBeNull()
    expect(screen.getByRole('button', { name: 'Save and publish' })).toBeDisabled()
    // No state is claimed for a form that is not in hand.
    expect(screen.queryByText(/Published revision|No form yet/)).toBeNull()
  })

  it('a form that cannot be loaded says so and keeps publishing off; «Retry» loads it', async () => {
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: 'Add a section' }))
    await chooseItem(user, 'App access')
    // From here the form cannot be read.
    apolloFinto.erroriQuery['GetCatalogForm'] = new Error('offline')
    await user.click(within(await screen.findByRole('dialog', { name: 'Discard the draft?' })).getByRole('button', { name: 'Delete' }))

    expect(await screen.findByText('The form of «App access» could not be loaded: until it is, it cannot be changed or published.')).toBeInTheDocument()
    expect(sectionOrder()).toEqual([])
    expect(screen.queryByText('Changes not published yet')).toBeNull()
    expect(screen.getByRole('button', { name: 'Save and publish' })).toBeDisabled()

    // The server answers again: «Retry» asks once more, and the form arrives.
    delete apolloFinto.erroriQuery['GetCatalogForm']
    apolloFinto.refetch.mockClear()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
    await waitFor(() => expect(sectionOrder()).toEqual(['1']))
    expect(screen.queryByText(/could not be loaded/)).toBeNull()
    expect(screen.getByText('No form yet')).toBeInTheDocument()
  })
})

/*
 * The properties modal keeps the keyboard inside it (see
 * `ModaleCentrato.test.tsx`), but the selection is only a pair of positions
 * in the draft: when the item changes under it, the properties must close.
 */
describe('properties left open when the item changes', () => {
  it('properties pointing past the end of the new form close, instead of drawing nothing', async () => {
    const first = await openOn()
    await first.user.click(screen.getByRole('button', { name: 'Money' }))
    expect(screen.getByRole('dialog', { name: 'Section properties' })).toBeInTheDocument()
    await openItem(first.user, 'App access')
    expect(screen.queryByRole('dialog', { name: 'Section properties' })).toBeNull()
    first.unmount()

    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: 'Requester' }))
    expect(screen.getByRole('dialog', { name: 'Field properties' })).toBeInTheDocument()
    await openItem(user, 'App access')
    expect(screen.queryByRole('dialog', { name: 'Field properties' })).toBeNull()
  })

  /*
   * Found by this test (tour of 23 Sep 2026), fixed: changing item kept the
   * selection, so the properties of a field nobody selected opened on the
   * other item's form, and edits went into that draft.
   */
  it('switching item closes the properties of the form that was open', async () => {
    answerForms({
      'i-laptop': { revision: 3, definition: LAPTOP_FORM },
      'i-access': { revision: 1, definition: { ...LAPTOP_FORM, sections: [
        { id: 'main', title: { en: 'Main', it: 'Principale' }, items: [{ field: 'budget' }, { field: 'urgent' }] },
      ] } },
    })
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: 'Requester' }))
    await openItem(user, 'App access')
    expect(screen.queryByRole('dialog', { name: 'Field properties' })).toBeNull()
  })
})

describe('the tools', () => {
  it('are two groups, closed at first and open one at a time, with their count on the title', async () => {
    const { user } = await openOn()
    const library = screen.getByRole('button', { name: /^Library/ })
    const types = screen.getByRole('button', { name: /^Field types/ })
    expect(library).toHaveAttribute('aria-expanded', 'false')
    expect(types).toHaveAttribute('aria-expanded', 'false')
    // The count says whether a group is worth opening.
    expect(library).toHaveTextContent(/3$/)
    expect(types).toHaveTextContent(/14$/)
    expect(screen.queryByRole('button', { name: 'Drag «Budget» into a section' })).toBeNull()

    await user.click(library)
    expect(library).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Drag «Budget» into a section' })).toBeInTheDocument()

    await user.click(types)
    expect(library).toHaveAttribute('aria-expanded', 'false')
    expect(types).toHaveAttribute('aria-expanded', 'true')
    expect(screen.queryByRole('button', { name: 'Drag «Budget» into a section' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Add a new Date field' })).toBeInTheDocument()

    await user.click(types)
    expect(types).toHaveAttribute('aria-expanded', 'false')
  })

  it('the library offers the shared fields that the form does not use yet', async () => {
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: /^Library/ }))
    expect(screen.getAllByRole('button', { name: /^Drag «/ }).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Drag «Budget» into a section', 'Drag «Laptop model» into a section', 'Drag «Manager» into a section',
    ])
  })

  it('an empty library, or one whose shared fields are all on the form, says which', async () => {
    apolloFinto.risposte['GetFormFields'] = { formFields: [] }
    const first = await openOn()
    await first.user.click(screen.getByRole('button', { name: /^Library/ }))
    expect(screen.getByText(/The field library is empty/)).toBeInTheDocument()
    first.unmount()

    apolloFinto.risposte['GetFormFields'] = { formFields: LIBRARY.filter((f) => ['requester', 'urgent', 'cost_centre'].includes(f.name)) }
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: /^Library/ }))
    expect(screen.getByText('Every field of the library is already in this form.')).toBeInTheDocument()
  })

  it('«+» adds a library field to the section touched last', async () => {
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: /^Library/ }))
    await user.click(screen.getByRole('button', { name: 'Add «Budget» to the section «Details»' }))
    expect(fieldsIn('Details')).toEqual(['Requester', 'Urgent', 'Budget'])
    expect(screen.getByText('Changes not published yet')).toBeInTheDocument()
    // A field already on the form is not offered again.
    expect(screen.queryByRole('button', { name: /^Add «Budget»/ })).toBeNull()

    // Selecting the other section makes it the current one.
    await user.click(screen.getByRole('button', { name: 'Money' }))
    await closeDialog(user, 'Section properties')
    await user.click(screen.getByRole('button', { name: 'Add «Laptop model» to the section «Money»' }))
    expect(fieldsIn('Money')).toEqual(['Cost centre', 'Laptop model'])
  })

  it('«+» on a field type opens the editor of a new field for the current section', async () => {
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: /^Field types/ }))
    await user.click(screen.getByRole('button', { name: 'Add a new Date field' }))
    const editor = dialogNamed('New field · Date')
    expect(within(editor).getByText('It will go into the «Details» section.')).toBeInTheDocument()
    expect(within(editor).getByRole('combobox', { name: 'Type' })).toHaveValue('date')
  })

  it('with no section left the tools can add nothing', async () => {
    const { user } = await openOn('App access')
    await user.click(screen.getByRole('button', { name: 'Section with no title' }))
    await user.click(within(dialogNamed('Section properties')).getByRole('button', { name: 'Remove this section' }))
    expect(sectionOrder()).toEqual([])

    await user.click(screen.getByRole('button', { name: /^Library/ }))
    expect(screen.getByRole('button', { name: 'Add «Budget» to the section «»' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: /^Field types/ }))
    expect(screen.getByRole('button', { name: 'Add a new Date field' })).toBeDisabled()
  })
})

describe('sections', () => {
  it('«Add a section» appends an untitled section, flagged, that publishes with a free id', async () => {
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: 'Add a section' }))
    expect(sectionOrder()).toEqual(['Details', 'Money', '3'])
    expect(within(sectionTitled('Section with no title')).getByText('No title in EN, IT')).toBeInTheDocument()

    const def = await publish(user)
    expect(def.version).toBe(1)
    expect(def.sections.map((s) => s.id)).toEqual(['details', 'money', 'section_1'])
    expect(def.sections[2]).toEqual({ id: 'section_1', title: {}, items: [] })
  })

  it('a section moves with the arrow keys of its grip, and not past either end', async () => {
    const { user } = await openOn()
    await pressOn(user, /^Move the section «Money»/, '{ArrowUp}')
    expect(sectionOrder()).toEqual(['Money', 'Details'])
    await pressOn(user, /^Move the section «Money»/, '{ArrowUp}')
    expect(sectionOrder()).toEqual(['Money', 'Details'])
    await pressOn(user, /^Move the section «Details»/, '{ArrowDown}')
    expect(sectionOrder()).toEqual(['Money', 'Details'])
    await pressOn(user, /^Move the section «Money»/, '{ArrowDown}')
    expect(sectionOrder()).toEqual(['Details', 'Money'])
    // Only the arrows move: any other key leaves the section where it is.
    await pressOn(user, /^Move the section «Details»/, '{ArrowRight}')
    expect(sectionOrder()).toEqual(['Details', 'Money'])

    const def = await publish(user)
    expect(def.sections.map((s) => s.id)).toEqual(['details', 'money'])
  })

  it('its properties: a title per product language, the columns, and widths in bulk', async () => {
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: 'Details' }))
    const props = dialogNamed('Section properties')
    expect(within(props).getByText('Details')).toBeInTheDocument()
    const en = within(props).getByRole('textbox', { name: 'Section title (EN)' })
    expect(en).toHaveValue('Details')
    expect(within(props).getByRole('textbox', { name: 'Section title (IT)' })).toHaveValue('Dettagli')
    await user.clear(en)
    await user.type(en, 'Who asks')
    // The canvas follows as it is typed (it shows the English title).
    expect(screen.getByRole('button', { name: 'Who asks' })).toBeInTheDocument()

    await user.selectOptions(within(props).getByRole('combobox', { name: 'Columns' }), 'Two columns')
    expect(within(sectionTitled('Who asks')).getByText('Two columns')).toBeInTheDocument()
    await user.click(within(props).getByRole('button', { name: 'All at half width' }))
    await closeDialog(user, 'Section properties')
    let def = await publish(user)
    expect(def.sections[0]).toEqual({
      id: 'details', title: { en: 'Who asks', it: 'Dettagli' }, columns: 2,
      items: [{ field: 'requester', width: 'half' }, { field: 'urgent', width: 'half' }],
    })

    await user.click(screen.getByRole('button', { name: 'Who asks' }))
    await user.click(within(dialogNamed('Section properties')).getByRole('button', { name: 'All at full width' }))
    // Back to one column: the key goes, as in every form written before columns existed.
    await user.selectOptions(within(dialogNamed('Section properties')).getByRole('combobox', { name: 'Columns' }), 'One column')
    await closeDialog(user, 'Section properties')
    def = await publish(user)
    expect(def.sections[0]).not.toHaveProperty('columns')
    expect(def.sections[0]?.items).toEqual([{ field: 'requester', width: 'full' }, { field: 'urgent', width: 'full' }])
  })

  it('the title is asked in every language the tenant declares, and a missing one is flagged on the canvas', async () => {
    apolloFinto.risposte['GetTenantLanguageSettings'] = { tenantLanguageSettings: { available: ['en', 'it', 'de'] } }
    const { user } = await openOn()
    expect(within(sectionTitled('Details')).getByText('No title in DE')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Details' }))
    await user.type(within(dialogNamed('Section properties')).getByRole('textbox', { name: 'Section title (DE)' }), 'Angaben')
    expect(within(sectionTitled('Details')).queryByText(/No title in/)).toBeNull()
  })

  it('without the tenant settings the languages are English and Italian', async () => {
    apolloFinto.risposte['GetTenantLanguageSettings'] = undefined
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: 'Details' }))
    const props = dialogNamed('Section properties')
    expect(within(props).getAllByRole('textbox')).toHaveLength(2)
    expect(within(props).getByRole('textbox', { name: 'Section title (EN)' })).toHaveValue('Details')
    expect(within(props).getByRole('textbox', { name: 'Section title (IT)' })).toHaveValue('Dettagli')
  })

  it('removing a section takes its fields off the form, and they are offered again', async () => {
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: 'Money' }))
    await user.click(within(dialogNamed('Section properties')).getByRole('button', { name: 'Remove this section' }))
    expect(screen.queryByRole('dialog', { name: 'Section properties' })).toBeNull()
    expect(sectionOrder()).toEqual(['Details'])
    await user.click(screen.getByRole('button', { name: /^Library/ }))
    expect(screen.getByRole('button', { name: 'Drag «Cost centre» into a section' })).toBeInTheDocument()
  })
})

describe('fields on the canvas', () => {
  it('a field moves within its section with the arrow keys of its grip', async () => {
    const { user } = await openOn()
    await pressOn(user, /^Move «Requester»/, '{ArrowDown}')
    expect(fieldsIn('Details')).toEqual(['Urgent', 'Requester'])
    await pressOn(user, /^Move «Requester»/, '{ArrowDown}')
    expect(fieldsIn('Details')).toEqual(['Urgent', 'Requester'])
    await pressOn(user, /^Move «Requester»/, '{ArrowUp}')
    expect(fieldsIn('Details')).toEqual(['Requester', 'Urgent'])
    await pressOn(user, /^Move «Requester»/, '{ArrowUp}')
    expect(fieldsIn('Details')).toEqual(['Requester', 'Urgent'])
  })

  it('its properties apply to this form only: required, portal, read-only', async () => {
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: 'Requester' }))
    const props = dialogNamed('Field properties')
    expect(within(props).getByText('requester · Text')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Requester' })).toHaveAttribute('aria-pressed', 'true')
    // One column: half width is explained, not offered.
    expect(within(props).getByText(/Half width only exists in a two-column section/)).toBeInTheDocument()
    await user.click(within(props).getByRole('checkbox', { name: 'Required in this form' }))
    await user.click(within(props).getByRole('checkbox', { name: /^Visible in the service request/ }))
    await user.click(within(props).getByRole('checkbox', { name: /^Read-only in this form/ }))
    // The canvas marks what changes the behaviour.
    const tile = screen.getByRole('button', { name: 'Requester' })
    expect(within(tile).getByText('*')).toBeInTheDocument()
    expect(within(tile).getByTitle('Read-only in this form')).toBeInTheDocument()
    await closeDialog(user, 'Field properties')

    const def = await publish(user)
    expect(def.sections[0]?.items[0]).toEqual({ field: 'requester', required: true, endUser: false, readOnly: true })
    // The library field itself did not change.
    expect(apolloFinto.chiamate['UpdateFormField']).toBeUndefined()
  })

  it('in a two-column section a field can take the whole row', async () => {
    answerForms({ 'i-laptop': { revision: 3, definition: {
      ...LAPTOP_FORM,
      sections: [{ id: 'money', title: { en: 'Money', it: 'Soldi' }, columns: 2, items: [{ field: 'cost_centre' }, { field: 'budget' }] }],
    } } })
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: 'Cost centre' }))
    const half = within(dialogNamed('Field properties')).getByRole('checkbox', { name: 'Half width' })
    // Two columns: half width is the default, and can be switched off.
    expect(half).toBeChecked()
    await user.click(half)
    await closeDialog(user, 'Field properties')
    const def = await publish(user)
    expect(def.sections[0]?.items).toEqual([{ field: 'cost_centre', width: 'full' }, { field: 'budget' }])
  })

  it('removing a field takes it off this form and offers it again for reuse', async () => {
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: 'Urgent' }))
    await user.click(within(dialogNamed('Field properties')).getByRole('button', { name: /Remove this field/ }))
    expect(screen.queryByRole('dialog', { name: 'Field properties' })).toBeNull()
    expect(fieldsIn('Details')).toEqual(['Requester'])
    await user.click(screen.getByRole('button', { name: /^Library/ }))
    expect(screen.getByRole('button', { name: 'Drag «Urgent» into a section' })).toBeInTheDocument()
  })

  it('a field missing from the library is shown by its name, and only its place in the form can be edited', async () => {
    answerForms({ 'i-laptop': { revision: 3, definition: {
      ...LAPTOP_FORM,
      sections: [{ id: 'main', title: { en: 'Main', it: 'Principale' }, items: [{ field: 'ghost' }, { field: 'requester' }] }],
    } } })
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: 'ghost' }))
    const props = dialogNamed('Field properties')
    expect(within(props).getByText('ghost · Text')).toBeInTheDocument()
    expect(within(props).queryByRole('button', { name: /Edit the field/ })).toBeNull()
    // Its place in the form still changes: here, required.
    await user.click(within(props).getByRole('checkbox', { name: 'Required in this form' }))
    await closeDialog(user, 'Field properties')
    const def = await publish(user)
    expect(def.sections[0]?.items[0]).toEqual({ field: 'ghost', required: true })
  })
})

describe('visibility conditions', () => {
  /*
   * Found by this test (tour of 23 Sep 2026), fixed: with no rule and nothing
   * to look at, the condition editor drew the rules block anyway and read
   * `match` on an undefined condition, taking the whole builder down.
   */
  it('with no other field that carries an answer, it says why no condition can be written', async () => {
    answerForms({ 'i-laptop': { revision: 3, definition: {
      ...LAPTOP_FORM,
      sections: [{ id: 'main', title: { en: 'Main', it: 'Principale' }, items: [{ field: 'requester' }, { field: 'manager' }] }],
    } } })
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: 'Requester' }))
    const props = dialogNamed('Field properties')
    expect(within(props).getByText('Visibility')).toBeInTheDocument()
    // A person reference is read from the graph: a condition cannot look at it.
    expect(within(props).getByText(/A condition looks at ANOTHER field’s answer/)).toBeInTheDocument()
    expect(within(props).queryByRole('button', { name: /Only show it under a condition/ })).toBeNull()
  })

  it('a condition is written by choosing, and its value comes from the field it looks at', async () => {
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: 'Requester' }))
    const props = dialogNamed('Field properties')
    expect(within(props).getByText(/The field appears only when the condition is true/)).toBeInTheDocument()
    await user.click(within(props).getByRole('button', { name: /Only show it under a condition/ }))

    // The first field that can be looked at, compared with «is»; never the field itself.
    expect(within(props).getByDisplayValue('all of these')).toBeInTheDocument()
    expect(optionsOf(within(props).getByDisplayValue('Urgent'))).toEqual(['Urgent', 'Cost centre'])
    expect(within(props).getByDisplayValue('is')).toBeInTheDocument()
    // A yes/no field is answered Yes or No, not typed.
    const value = within(props).getByDisplayValue('Select')
    expect(optionsOf(value)).toEqual(['Select', 'Yes', 'No'])
    await user.selectOptions(value, 'Yes')
    expect(within(screen.getByRole('button', { name: 'Requester' })).getByTitle('It appears only when a condition is true')).toBeInTheDocument()

    // A choice offers the Dictionary's values, with their labels.
    await user.selectOptions(within(props).getByDisplayValue('Urgent'), 'Cost centre')
    const choice = within(props).getByDisplayValue('true')
    expect(optionsOf(choice)).toEqual(['Select', 'IT', 'HR', 'true'])
    await user.selectOptions(choice, 'HR')
    await closeDialog(user, 'Field properties')

    const def = await publish(user)
    expect(def.sections[0]?.items[0]).toEqual({
      field: 'requester', visibleWhen: { match: 'all', rules: [{ field: 'cost_centre', op: 'eq', value: 'hr' }] },
    })
  })

  it('rules can be added, matched with «any», use an operator without value, and be removed', async () => {
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: 'Requester' }))
    const props = dialogNamed('Field properties')
    await user.click(within(props).getByRole('button', { name: /Only show it under a condition/ }))
    await user.click(within(props).getByRole('button', { name: /Add a rule/ }))
    expect(within(props).getAllByRole('button', { name: 'Remove this rule' })).toHaveLength(2)
    // Each rule is edited on its own: the second looks at the cost centre, the first stays.
    await user.selectOptions(within(props).getAllByDisplayValue('Urgent')[1]!, 'Cost centre')
    await user.selectOptions(within(props).getAllByDisplayValue('Select')[1]!, 'IT')
    await user.selectOptions(within(props).getByDisplayValue('all of these'), 'any of these')
    await user.selectOptions(within(props).getAllByDisplayValue('is')[0]!, 'is filled in')
    // «is filled in» compares with nothing: the value box of that rule goes.
    expect(within(props).queryAllByDisplayValue('Select')).toHaveLength(0)
    await closeDialog(user, 'Field properties')
    let def = await publish(user)
    expect(def.sections[0]?.items[0]?.visibleWhen).toEqual({
      match: 'any', rules: [{ field: 'urgent', op: 'filled' }, { field: 'cost_centre', op: 'eq', value: 'it' }],
    })

    // Back to an operator with a value: the value box returns, empty.
    await user.click(screen.getByRole('button', { name: 'Requester' }))
    await user.selectOptions(within(dialogNamed('Field properties')).getByDisplayValue('is filled in'), 'is not')
    expect(within(dialogNamed('Field properties')).getAllByDisplayValue('Select')).toHaveLength(1)
    // Removing the last rule removes the condition, key and all.
    await user.click(within(dialogNamed('Field properties')).getAllByRole('button', { name: 'Remove this rule' })[0]!)
    await user.click(within(dialogNamed('Field properties')).getByRole('button', { name: 'Remove this rule' }))
    expect(within(dialogNamed('Field properties')).getByRole('button', { name: /Only show it under a condition/ })).toBeInTheDocument()
    expect(within(screen.getByRole('button', { name: 'Requester' })).queryByTitle('It appears only when a condition is true')).toBeNull()
    await closeDialog(user, 'Field properties')
    def = await publish(user)
    expect(def.sections[0]?.items[0]).toEqual({ field: 'requester' })
  })

  it('a stored value the Dictionary no longer has stays visible, and a number is typed', async () => {
    answerForms({ 'i-laptop': { revision: 3, definition: {
      ...LAPTOP_FORM,
      sections: [{ id: 'main', title: { en: 'Main', it: 'Principale' }, items: [
        { field: 'requester', visibleWhen: { match: 'all', rules: [{ field: 'cost_centre', op: 'eq', value: 'finance' }] } },
        { field: 'cost_centre' }, { field: 'budget' },
      ] }],
    } } })
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: 'Requester' }))
    const props = dialogNamed('Field properties')
    expect(optionsOf(within(props).getByDisplayValue('finance'))).toEqual(['Select', 'IT', 'HR', 'finance'])

    await user.selectOptions(within(props).getByDisplayValue('Cost centre'), 'Budget')
    const numberBox = within(props).getByRole('textbox')
    expect(numberBox).toHaveValue('finance')
    await user.clear(numberBox)
    await user.type(numberBox, '1000')
    await closeDialog(user, 'Field properties')
    const def = await publish(user)
    expect(def.sections[0]?.items[0]?.visibleWhen).toEqual({ match: 'all', rules: [{ field: 'budget', op: 'eq', value: '1000' }] })
  })

  it('every control of a rule is named: which rule it belongs to, and what it sets', async () => {
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: 'Urgent' }))
    const props = dialogNamed('Field properties')
    await user.click(within(props).getByRole('button', { name: /Only show it under a condition/ }))
    // The combination is named by the words written before it.
    expect(within(props).getByRole('combobox', { name: 'Show it when' })).toHaveValue('all')
    expect(within(props).getByRole('combobox', { name: 'Rule 1: field' })).toHaveValue('requester')
    expect(within(props).getByRole('combobox', { name: 'Rule 1: comparison' })).toHaveValue('eq')
    // A text answer is typed, a choice is picked: named the same way either way.
    expect(within(props).getByRole('textbox', { name: 'Rule 1: value' })).toHaveValue('')
    await user.click(within(props).getByRole('button', { name: /Add a rule/ }))
    await user.selectOptions(within(props).getByRole('combobox', { name: 'Rule 2: field' }), 'Cost centre')
    expect(within(props).getByRole('combobox', { name: 'Rule 2: value' })).toHaveValue('')
    expect(within(props).getByRole('combobox', { name: 'Rule 2: comparison' })).toHaveValue('eq')
  })

  it('a rule on a field taken off the form shows that field, and with nothing else to look at no rule can be added', async () => {
    answerForms({ 'i-laptop': { revision: 3, definition: {
      ...LAPTOP_FORM,
      sections: [{ id: 'main', title: { en: 'Main', it: 'Principale' }, items: [
        // It looks at the cost centre, which is no longer on the form: the server refuses that.
        { field: 'requester', visibleWhen: { match: 'all', rules: [{ field: 'cost_centre', op: 'eq', value: 'hr' }] } },
      ] }],
    } } })
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: 'Requester' }))
    const props = dialogNamed('Field properties')
    // What the rule really looks at, not the first field that could be chosen.
    const field = within(props).getByRole('combobox', { name: 'Rule 1: field' })
    expect(field).toHaveValue('cost_centre')
    expect(optionsOf(field)).toEqual(['Cost centre'])
    expect(within(props).queryByRole('button', { name: /Add a rule/ })).toBeNull()
    // Removing it leaves the explanation, not a way to write a rule on nothing.
    await user.click(within(props).getByRole('button', { name: 'Remove this rule' }))
    expect(within(props).getByText(/A condition looks at ANOTHER field’s answer/)).toBeInTheDocument()
    expect(within(props).queryByRole('button', { name: /Only show it under a condition/ })).toBeNull()
  })
})

describe('editing the library field from the form', () => {
  it('warns that every form using it changes, and saves it in the library', async () => {
    apolloFinto.esiti['UpdateFormField'] = { data: { updateFormField: { id: 'f-cost_centre' } } }
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: 'Cost centre' }))
    const props = dialogNamed('Field properties')
    expect(within(props).getByText(/this field is used by 2 forms/)).toBeInTheDocument()
    await user.click(within(props).getByRole('button', { name: /Edit the field/ }))
    // Name and type belong to the answers already collected: locked.
    expect(within(props).getByRole('textbox', { name: 'Name' })).toBeDisabled()
    const en = within(props).getByRole('textbox', { name: 'Label (English)' })
    await user.clear(en)
    await user.type(en, 'Cost center')
    apolloFinto.refetch.mockClear()
    await user.click(within(props).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Field saved'))
    expect(apolloFinto.chiamata('UpdateFormField')).toEqual({
      id: 'f-cost_centre',
      input: expect.objectContaining({
        vocabulary: 'cost_centres',
        labels: [{ language: 'it', text: 'Cost centre' }, { language: 'en', text: 'Cost center' }],
      }),
    })
    // The library is read again, and the editor closes.
    expect(apolloFinto.refetch).toHaveBeenCalled()
    expect(await within(props).findByRole('button', { name: /Edit the field/ })).toBeInTheDocument()
  })

  it('a refused save keeps the editor open', async () => {
    apolloFinto.esiti['UpdateFormField'] = { error: new Error('Vocabulary not found') }
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: 'Cost centre' }))
    const props = dialogNamed('Field properties')
    await user.click(within(props).getByRole('button', { name: /Edit the field/ }))
    await user.click(within(props).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Vocabulary not found'))
    // Still editing: the button is back to «Save», with the typed values kept.
    expect(await within(props).findByRole('button', { name: 'Save' })).toBeEnabled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  /*
   * Changed on 23 Sep 2026: this used to keep the editor open, with no word of
   * success, when the library could not be read again after a save that had
   * worked — inviting a second save of what was already saved.
   */
  it('saved, but the library could not be read again: the editor closes saying it was saved, and that the library is not refreshed', async () => {
    apolloFinto.esiti['UpdateFormField'] = { data: { updateFormField: { id: 'f-cost_centre' } } }
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: 'Cost centre' }))
    const props = dialogNamed('Field properties')
    await user.click(within(props).getByRole('button', { name: /Edit the field/ }))
    apolloFinto.refetch.mockRejectedValueOnce(new Error('offline'))
    await user.click(within(props).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Field saved'))
    expect(toast.error).toHaveBeenCalledWith(
      'The field library could not be refreshed: until it is, this page shows the field as it was before the change.')
    // Closed, as after any save: nothing invites saving it again.
    expect(await within(props).findByRole('button', { name: /Edit the field/ })).toBeInTheDocument()
    expect(within(props).queryByRole('button', { name: 'Save' })).toBeNull()
    expect(apolloFinto.chiamate['UpdateFormField']).toHaveLength(1)
  })

  it('cancelling, or closing the properties, drops the unsaved edit', async () => {
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: 'Cost centre' }))
    await user.click(within(dialogNamed('Field properties')).getByRole('button', { name: /Edit the field/ }))
    // The editor's own «Cancel», not the «×» of the modal.
    await user.click(within(dialogNamed('Field properties')).getByText('Cancel'))
    expect(within(dialogNamed('Field properties')).getByRole('button', { name: /Edit the field/ })).toBeInTheDocument()

    await user.click(within(dialogNamed('Field properties')).getByRole('button', { name: /Edit the field/ }))
    await closeDialog(user, 'Field properties')
    await user.click(screen.getByRole('button', { name: 'Cost centre' }))
    expect(within(dialogNamed('Field properties')).getByRole('button', { name: /Edit the field/ })).toBeInTheDocument()
    expect(apolloFinto.chiamate['UpdateFormField']).toBeUndefined()
  })
})

describe('a new field from a type', () => {
  /** After the creation the library knows the field, with its label. */
  function libraryWith(...added: ReturnType<typeof libraryField>[]) {
    apolloFinto.risposte['GetFormFields'] = afterMutation('CreateFormField', { formFields: LIBRARY }, { formFields: [...LIBRARY, ...added] })
    apolloFinto.esiti['CreateFormField'] = { data: { createFormField: { id: 'f-new' } } }
  }

  async function openNewField(user: UserEvent, type: string) {
    if (screen.getByRole('button', { name: /^Field types/ }).getAttribute('aria-expanded') === 'false') {
      await user.click(screen.getByRole('button', { name: /^Field types/ }))
    }
    await user.click(screen.getByRole('button', { name: `Add a new ${type} field` }))
    return dialogNamed(`New field · ${type}`)
  }

  it('is created in the library, named from its label, then placed at the end of its section', async () => {
    libraryWith(libraryField('start_date', 'date', 'Start date', { shared: false }))
    const { user } = await openOn()
    const editor = await openNewField(user, 'Date')
    await user.type(within(editor).getByRole('textbox', { name: 'Label (English)' }), 'Start date')
    expect(within(editor).getByRole('textbox', { name: 'Name' })).toHaveValue('start_date')
    await user.click(within(editor).getByRole('button', { name: 'Create and add' }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New field · Date' })).toBeNull())
    expect(apolloFinto.chiamata('CreateFormField')).toEqual({
      input: expect.objectContaining({ name: 'start_date', fieldType: 'date', label: 'Start date', shared: false }),
    })
    expect(fieldsIn('Details')).toEqual(['Requester', 'Urgent', 'Start date'])
    expect(screen.getByText('Changes not published yet')).toBeInTheDocument()
  })

  it('needs a label; a name written by hand is kept, an emptied one is proposed again from the label', async () => {
    libraryWith()
    const { user } = await openOn()
    let editor = await openNewField(user, 'Number')
    await user.click(within(editor).getByRole('button', { name: 'Create and add' }))
    expect(toast.error).toHaveBeenCalledWith('A field needs a label in at least one language.')
    expect(apolloFinto.chiamate['CreateFormField']).toBeUndefined()

    await user.type(within(editor).getByRole('textbox', { name: 'Name' }), '  unit_cost ')
    await user.type(within(editor).getByRole('textbox', { name: 'Label (English)' }), 'Unit cost')
    await user.click(within(editor).getByRole('button', { name: 'Create and add' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New field · Number' })).toBeNull())
    expect(apolloFinto.chiamata('CreateFormField')).toMatchObject({ input: { name: 'unit_cost' } })

    // The label of a field that exists proposes a name that does not collide with it.
    editor = await openNewField(user, 'Text')
    await user.type(within(editor).getByRole('textbox', { name: 'Label (English)' }), 'Budget')
    const nameBox = within(editor).getByRole('textbox', { name: 'Name' })
    expect(nameBox).toHaveValue('budget_2')
    await user.clear(nameBox)
    await user.click(within(editor).getByRole('button', { name: 'Create and add' }))
    await waitFor(() => expect(apolloFinto.chiamate['CreateFormField']).toHaveLength(2))
    expect(apolloFinto.chiamata('CreateFormField')).toMatchObject({ input: { name: 'budget_2', label: 'Budget' } })
  })

  it('names the section it goes into, by its id when the section has no title', async () => {
    const { user } = await openOn('App access')
    const editor = await openNewField(user, 'Date')
    expect(within(editor).getByText('It will go into the «main» section.')).toBeInTheDocument()
  })

  it('refused by the library, the editor stays open and the form is untouched', async () => {
    apolloFinto.esiti['CreateFormField'] = { error: new Error('The name is reserved') }
    const { user } = await openOn()
    const editor = await openNewField(user, 'Text')
    await user.type(within(editor).getByRole('textbox', { name: 'Label (English)' }), 'Status')
    await user.click(within(editor).getByRole('button', { name: 'Create and add' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The name is reserved'))
    expect(await within(dialogNamed('New field · Text')).findByRole('button', { name: 'Create and add' })).toBeEnabled()
    expect(within(dialogNamed('New field · Text')).getByRole('textbox', { name: 'Label (English)' })).toHaveValue('Status')
    expect(fieldsIn('Details')).toEqual(['Requester', 'Urgent'])
    expect(screen.queryByText('Changes not published yet')).toBeNull()
  })

  it('created, but the library could not be read again: it goes on the form all the same, and the editor closes saying so', async () => {
    // The library read after the creation fails, so it still has only the fields it had.
    apolloFinto.esiti['CreateFormField'] = { data: { createFormField: { id: 'f-start_date' } } }
    const { user } = await openOn()
    const editor = await openNewField(user, 'Date')
    await user.type(within(editor).getByRole('textbox', { name: 'Label (English)' }), 'Start date')
    apolloFinto.refetch.mockRejectedValueOnce(new Error('offline'))
    await user.click(within(editor).getByRole('button', { name: 'Create and add' }))

    // Closed: nothing invites creating it a second time.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New field · Date' })).toBeNull())
    expect(apolloFinto.chiamate['CreateFormField']).toHaveLength(1)
    expect(toast.error).toHaveBeenCalledWith(
      'The field was created and is on the form, but the field library could not be refreshed: until it is, the form shows the field by its name.')
    // On the form, by its name until the library is read again.
    expect(fieldsIn('Details')).toEqual(['Requester', 'Urgent', 'start_date'])
    expect(screen.getByText('Changes not published yet')).toBeInTheDocument()
  })

  it('Escape, Cancel and the close button leave without creating anything', async () => {
    const { user } = await openOn()
    await openNewField(user, 'Date')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'New field · Date' })).toBeNull()

    await user.click(within(await openNewField(user, 'Date')).getByText('Cancel'))
    expect(screen.queryByRole('dialog', { name: 'New field · Date' })).toBeNull()

    await openNewField(user, 'Date')
    await closeDialog(user, 'New field · Date')
    expect(apolloFinto.chiamate['CreateFormField']).toBeUndefined()
    expect(fieldsIn('Details')).toEqual(['Requester', 'Urgent'])
  })
})

describe('a new service request from the designer', () => {
  const openNewItem = async (user: UserEvent) => {
    await user.click(screen.getByRole('button', { name: 'New service request' }))
    return dialogNamed('New service request')
  }

  it('needs a name and a priority; category and priority come from the Dictionary', async () => {
    const { user } = renderWithProviders(withDictionary(<FormBuilderPanel />))
    const modal = await openNewItem(user)
    expect(within(modal).getByText(/Once created it opens here, ready to design/)).toBeInTheDocument()
    const create = within(modal).getByRole('button', { name: 'Create and design' })
    expect(create).toBeDisabled()
    // A value the Dictionary did not label is shown by its value.
    expect(optionsOf(within(modal).getByRole('combobox', { name: 'Category' }))).toEqual(['Select', 'Hardware', 'access'])
    expect(optionsOf(within(modal).getByRole('combobox', { name: 'Priority' }))).toEqual(['Select', 'Low', 'High', 'critical'])

    await user.type(within(modal).getByRole('textbox', { name: 'Name' }), '   ')
    await user.selectOptions(within(modal).getByRole('combobox', { name: 'Priority' }), 'High')
    expect(create).toBeDisabled()
    await user.type(within(modal).getByRole('textbox', { name: 'Name' }), 'Badge')
    expect(create).toBeEnabled()
  })

  it('without the Dictionary there is no priority to pick, so nothing can be created', async () => {
    const { user } = renderWithProviders(<FormBuilderPanel />)
    const modal = await openNewItem(user)
    expect(optionsOf(within(modal).getByRole('combobox', { name: 'Category' }))).toEqual(['Select'])
    expect(optionsOf(within(modal).getByRole('combobox', { name: 'Priority' }))).toEqual(['Select'])
    await user.type(within(modal).getByRole('textbox', { name: 'Name' }), 'Badge')
    expect(within(modal).getByRole('button', { name: 'Create and design' })).toBeDisabled()
  })

  it('creating it sends the trimmed values, then opens the new item ready to design', async () => {
    const badge = { id: 'i-badge', name: 'Badge', active: true, category: null }
    apolloFinto.risposte['GetServiceCatalogAdmin'] = afterMutation('CreateServiceCatalogItem',
      { serviceCatalogItems: ITEMS }, { serviceCatalogItems: [...ITEMS, badge] })
    answerForms({ 'i-badge': { revision: 0, definition: emptyCatalogForm() } })
    apolloFinto.esiti['CreateServiceCatalogItem'] = { data: { createServiceCatalogItem: { id: 'i-badge' } } }
    const { user } = renderWithProviders(withDictionary(<FormBuilderPanel />))
    const modal = await openNewItem(user)
    await user.type(within(modal).getByRole('textbox', { name: 'Name' }), '  Badge  ')
    await user.type(within(modal).getByRole('textbox', { name: 'Description (optional)' }), '   ')
    await user.selectOptions(within(modal).getByRole('combobox', { name: 'Priority' }), 'Low')
    await user.click(within(modal).getByRole('checkbox', { name: 'Needs an approval' }))
    await user.click(within(modal).getByRole('button', { name: 'Create and design' }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Item created'))
    expect(apolloFinto.chiamata('CreateServiceCatalogItem')).toEqual({ input: {
      name: 'Badge', description: null, category: null, priority: 'low', requiresApproval: true,
    } })
    // It opens at once on the new item, ready to design.
    expect(await screen.findByText('Badge', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Service request' })).toHaveValue('i-badge')
    expect(screen.queryByRole('dialog', { name: 'New service request' })).toBeNull()
    expect(sectionOrder()).toEqual(['1'])
  })

  it('a refused creation keeps the form open; Cancel leaves without creating anything', async () => {
    apolloFinto.esiti['CreateServiceCatalogItem'] = { error: new Error('A request with this name exists') }
    const { user } = renderWithProviders(withDictionary(<FormBuilderPanel />))
    const modal = await openNewItem(user)
    await user.type(within(modal).getByRole('textbox', { name: 'Name' }), 'Badge')
    await user.type(within(modal).getByRole('textbox', { name: 'Description (optional)' }), ' For visitors ')
    await user.selectOptions(within(modal).getByRole('combobox', { name: 'Category' }), 'Hardware')
    await user.selectOptions(within(modal).getByRole('combobox', { name: 'Priority' }), 'High')
    await user.click(within(modal).getByRole('button', { name: 'Create and design' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('A request with this name exists'))
    expect(apolloFinto.chiamata('CreateServiceCatalogItem')).toEqual({ input: {
      name: 'Badge', description: 'For visitors', category: 'hardware', priority: 'high', requiresApproval: false,
    } })
    expect(await within(dialogNamed('New service request')).findByRole('button', { name: 'Create and design' })).toBeEnabled()
    expect(toast.success).not.toHaveBeenCalled()

    await user.click(within(dialogNamed('New service request')).getByText('Cancel'))
    expect(screen.queryByRole('dialog', { name: 'New service request' })).toBeNull()
    // Nothing was pending from the AI: nothing to say about abandoned fields.
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('created, but the list could not be read again: the form closes, and the request opens all the same, named', async () => {
    // The list read after the creation fails, so it still has only the items it had.
    apolloFinto.esiti['CreateServiceCatalogItem'] = { data: { createServiceCatalogItem: { id: 'i-badge', name: 'Badge', active: true, category: null } } }
    answerForms({ 'i-badge': { revision: 0, definition: emptyCatalogForm() } })
    const { user } = renderWithProviders(withDictionary(<FormBuilderPanel />))
    const modal = await openNewItem(user)
    await user.type(within(modal).getByRole('textbox', { name: 'Name' }), 'Badge')
    await user.selectOptions(within(modal).getByRole('combobox', { name: 'Priority' }), 'Low')
    apolloFinto.refetch.mockRejectedValueOnce(new Error('offline'))
    await user.click(within(modal).getByRole('button', { name: 'Create and design' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('«Badge» was created, but the list of service requests could not be refreshed.'))
    expect(toast.success).toHaveBeenCalledWith('Item created')
    // Closed: nothing invites creating it a second time.
    expect(screen.queryByRole('dialog', { name: 'New service request' })).toBeNull()
    expect(apolloFinto.chiamate['CreateServiceCatalogItem']).toHaveLength(1)
    // It opens all the same, and the selector and the canvas both name it.
    await waitFor(() => expect(sectionOrder()).toEqual(['1']))
    expect(screen.getByRole('combobox', { name: 'Service request' })).toHaveValue('i-badge')
    expect(screen.getByText('Badge', { selector: 'strong' })).toBeInTheDocument()
  })
})

describe('publishing', () => {
  it('asks first, naming the item it writes; saying no sends nothing', async () => {
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: 'Add a section' }))
    await user.click(screen.getByRole('button', { name: 'Save and publish' }))
    const confirmation = await screen.findByRole('dialog', { name: 'Publish this form?' })
    expect(within(confirmation).getByText(/The form of «New laptop» is replaced by this design/)).toBeInTheDocument()
    await user.click(within(confirmation).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Publish this form?' })).toBeNull())
    expect(apolloFinto.chiamate['SaveCatalogForm']).toBeUndefined()
    expect(screen.getByText('Changes not published yet')).toBeInTheDocument()
  })

  it('sends the whole draft with the schema version, then shows the new revision and reloads', async () => {
    apolloFinto.esiti['SaveCatalogForm'] = { data: { saveCatalogForm: { revision: 4 } } }
    const { user } = await openOn()
    await pressOn(user, /^Move the section «Money»/, '{ArrowUp}')
    apolloFinto.refetch.mockClear()
    const def = await publish(user)

    expect(apolloFinto.chiamata('SaveCatalogForm')?.['itemId']).toBe('i-laptop')
    expect(def).toEqual({ ...LAPTOP_FORM, sections: [LAPTOP_FORM.sections[1], LAPTOP_FORM.sections[0]] })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Form published, revision 4'))
    await waitFor(() => expect(screen.queryByText('Changes not published yet')).toBeNull())
    expect(screen.getByRole('button', { name: 'Save and publish' })).toBeDisabled()
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a refused publication keeps the changes marked as not published', async () => {
    apolloFinto.esiti['SaveCatalogForm'] = { error: new Error('Section «section_1» has no title in en') }
    const { user } = await openOn()
    await user.click(screen.getByRole('button', { name: 'Add a section' }))
    await publish(user)
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Section «section_1» has no title in en'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByText('Changes not published yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save and publish' })).toBeEnabled()
  })
})

describe('the preview', () => {
  it('is the real form: answering a field makes the fields that depend on it appear', async () => {
    answerForms({ 'i-laptop': { revision: 3, definition: {
      ...LAPTOP_FORM,
      sections: [{ id: 'main', title: { en: 'Main', it: 'Principale' }, items: [
        { field: 'urgent' },
        { field: 'requester', visibleWhen: { match: 'all', rules: [{ field: 'urgent', op: 'eq', value: 'true' }] } },
      ] }],
    } } })
    const { user } = await openOn()
    await user.click(screen.getByRole('tab', { name: 'Preview' }))
    expect(screen.getByRole('tab', { name: 'Preview' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(/The real form, rendered by the same component/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add a section' })).toBeNull()

    expect(screen.queryByRole('textbox', { name: 'Requester' })).toBeNull()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Urgent' }), 'Yes')
    const requesterBox = screen.getByRole('textbox', { name: 'Requester' })
    await user.type(requesterBox, 'Ada')
    expect(requesterBox).toHaveValue('Ada')

    await user.click(screen.getByRole('tab', { name: 'Designer' }))
    expect(fieldsIn('Main')).toEqual(['Urgent', 'Requester'])
  })
})
