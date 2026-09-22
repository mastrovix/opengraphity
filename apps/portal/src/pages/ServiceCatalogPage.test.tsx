/**
 * THE SERVICE CATALOG, from the portal.
 *
 * The form is rendered by the SAME component as the workspace
 * (`CatalogFormRenderer` in web-core) because an end user must fill in the
 * form the administrator drew, not a poorer version: the portal used to know
 * only `select` and `input`, with no sections, conditions or text areas.
 *
 * Two defects reproduced live hold this page up, and both are pinned here:
 *
 *  - opening an item STARTS FROM SCRATCH. Library fields are shared between
 *    forms, so without the reset a new item was born pre-filled with the
 *    answers given to the previous one, and its conditions were evaluated
 *    against answers that did not belong to it. With files it was worse: a
 *    file uploaded on "New laptop" travelled onto the "New mouse" request.
 *  - a condition that switches off FORGETS the answer, because the server
 *    refuses a hidden field that arrives anyway — but a COMPUTED value is
 *    not an answer, and deleting it produced an infinite loop measured in
 *    the portal: the renderer rewrote it, the page deleted it, the object
 *    changed identity, the effect ran again.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { ServiceCatalogPage } from './ServiceCatalogPage'
import { GET_SERVICE_CATALOG, GET_ME, GET_TICKET_CATEGORIES, GET_PORTAL_CUSTOM_FIELDS } from '@/graphql/queries'
import { GET_PORTAL_CATALOG_FORM, GET_PORTAL_REFERENCE_CHOICES } from '../graphql/queries'
import { CREATE_SERVICE_REQUEST } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'

const sempre = Number.POSITIVE_INFINITY

const me = (permissions: string[] = ['portal.read', 'portal.submit']): GqlMock => ({
  request: { query: GET_ME },
  result: { data: { me: { __typename: 'User', id: 'u1', name: 'Anna', email: 'a@x', role: 'end_user', permissions, language: 'en' } } },
  maxUsageCount: sempre,
})

const categorie: GqlMock = {
  request: { query: GET_TICKET_CATEGORIES, variables: () => true },
  result: { data: { ticketCategories: [{ __typename: 'TicketCategory', name: 'hardware', label: 'Hardware e periferiche' }] } },
  maxUsageCount: sempre,
}

const campiCliente = (fields: unknown[] = []): GqlMock => ({
  request: { query: GET_PORTAL_CUSTOM_FIELDS, variables: () => true },
  result: { data: { portalCustomFields: fields } },
  maxUsageCount: sempre,
})

const voce = (over: Record<string, unknown> = {}) => ({
  __typename: 'ServiceCatalogItem', id: 'it-1', name: 'New laptop',
  description: 'A laptop for a new joiner', category: 'hardware', requiresApproval: false, ...over,
})

const catalogo = (items: unknown[]): GqlMock => ({
  request: { query: GET_SERVICE_CATALOG },
  result: { data: { serviceCatalogItems: items } },
  maxUsageCount: sempre,
})

/** A form whose serial number appears only when the model is "custom". */
const MODULO = {
  __typename: 'CatalogForm', itemId: 'it-1', revision: 3,
  definition: JSON.stringify({
    version: 1, revision: 3,
    sections: [{ id: 's1', title: { en: 'Details' }, items: [
      { field: 'modello' },
      { field: 'seriale', visibleWhen: { rules: [{ field: 'modello', operator: 'equals', value: 'custom' }] } },
    ] }],
  }),
  fields: [
    { __typename: 'FormFieldView', name: 'modello', fieldType: 'text', label: 'Model', required: false, vocabulary: null, help: null, formula: null, refTypes: [], labels: [], helps: [], options: [], tableColumns: [] },
    { __typename: 'FormFieldView', name: 'seriale', fieldType: 'text', label: 'Serial', required: false, vocabulary: null, help: null, formula: null, refTypes: [], labels: [], helps: [], options: [], tableColumns: [] },
  ],
}

const modulo = (m: unknown = MODULO): GqlMock => ({
  request: { query: GET_PORTAL_CATALOG_FORM, variables: () => true },
  result: { data: { catalogFormToFill: m } },
  maxUsageCount: sempre,
})

const base = (items: unknown[] = [voce()]) => [me(), categorie, campiCliente(), catalogo(items)]

/**
 * La scheda di una voce, quando e DAVVERO quella su cui cliccare.
 *
 * Due attese, e la seconda e' meno ovvia:
 *  - `portal.submit` arriva con `me`, e finche non arriva il pulsante e' spento;
 *  - il gruppo si chiama con l'ETICHETTA della categoria, che arriva dal
 *    Dizionario dopo il primo render. Quando arriva, la chiave del gruppo
 *    cambia («hardware» → «Hardware e periferiche») e React rimonta la
 *    scheda: un pulsante preso prima e' un nodo staccato dal documento, e
 *    cliccarlo non fa niente — il test cadeva su «nessun dialogo» invece che
 *    sul suo punto.
 */
async function apribile(nome: string, gruppo = 'Hardware e periferiche'): Promise<HTMLButtonElement> {
  // L'etichetta del gruppo e' l'ultima cosa che arriva: aspettarla vuol dire
  // aspettare il rimontaggio, e solo dopo prendere il pulsante.
  await screen.findByRole('heading', { name: gruppo })
  const button = screen.getByText(nome).closest('button') as HTMLButtonElement
  await waitFor(() => { expect(button.disabled).toBe(false) })
  return button
}

describe('the catalog', () => {
  it('groups the items by their DICTIONARY label, not by the internal value', async () => {
    // The portal used to carry five categories written in its own code, with
    // labels of its own — and "security" missing.
    renderWithProviders(<ServiceCatalogPage />, { mocks: base() })
    expect(await screen.findByRole('heading', { name: 'Hardware e periferiche' })).toBeInTheDocument()
    expect(screen.getByText('New laptop')).toBeInTheDocument()
    expect(screen.getByText('A laptop for a new joiner')).toBeInTheDocument()
  })

  it('an item with no category lands under a named group, not under "null"', async () => {
    renderWithProviders(<ServiceCatalogPage />, { mocks: base([voce({ category: null })]) })
    await screen.findByText('New laptop')
    expect(screen.queryByRole('heading', { name: /null|undefined/ })).toBeNull()
  })

  it('an item needing approval says so before it is opened', async () => {
    renderWithProviders(<ServiceCatalogPage />, { mocks: base([voce({ requiresApproval: true })]) })
    await screen.findByText('New laptop')
    expect(screen.getByText('Requires approval')).toBeInTheDocument()
  })

  it('an empty catalog says so instead of showing nothing', async () => {
    renderWithProviders(<ServiceCatalogPage />, { mocks: base([]) })
    await waitFor(() => { expect(screen.queryByText('New laptop')).toBeNull() })
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
  })

  it('a failed load is announced', async () => {
    const rotto: GqlMock = { request: { query: GET_SERVICE_CATALOG }, error: new Error('Catalog unavailable') }
    renderWithProviders(<ServiceCatalogPage />, { mocks: [me(), categorie, campiCliente(), rotto] })
    expect((await screen.findByRole('alert')).textContent).toContain('Catalog unavailable')
  })

  it('without portal.submit the items are shown but cannot be opened, and the button says why', async () => {
    // Reading the catalog and opening a request are two permissions (wave 7).
    renderWithProviders(<ServiceCatalogPage />, { mocks: [me(['portal.read']), categorie, campiCliente(), catalogo([voce()])] })
    const button = (await screen.findByText('New laptop')).closest('button') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).not.toBe('')
  })
})

describe('the request dialog', () => {
  async function apri(mocks = [...base(), modulo()]) {
    const { user } = renderWithProviders(<ServiceCatalogPage />, { mocks })
    await user.click(await apribile('New laptop'))
    return { user, dialog: await screen.findByRole('dialog') }
  }

  it('is a real dialog: named, modal, and focused', async () => {
    // It had no role, no name, no Escape and no focus move: with a screen
    // reader the form was not announced and tabbing continued in the page
    // underneath.
    const { dialog } = await apri()
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(within(dialog).getByRole('heading', { name: 'New laptop' })).toBeInTheDocument()
    expect(document.activeElement).toBe(dialog)
  })

  it('Escape closes it', async () => {
    const { user, dialog } = await apri()
    await user.type(dialog, '{Escape}')
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('a click on the backdrop closes it; a click INSIDE does not', async () => {
    const { user, dialog } = await apri()
    await user.click(within(dialog).getByRole('heading', { name: 'New laptop' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.click(dialog.parentElement!)
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('Cancel closes it and sends nothing', async () => {
    const { user } = await apri()
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  /**
   * IL FUOCO SI DA UNA VOLTA SOLA (difetto trovato scrivendo questo test).
   *
   * Il dialogo prendeva il fuoco con una ref in linea, cioe' una funzione
   * nuova a ogni render, che React richiama a ogni render: il fuoco tornava
   * sul dialogo A OGNI TASTO. Scrivendo nei «Dettagli» restava la prima
   * lettera — il test si aspettava «Keep me» e riceveva «K» — e lo stesso in
   * ogni campo del modulo. Dal portale, una richiesta non si poteva scrivere.
   */
  it('typing keeps every letter: the dialog takes the focus once, not at every render', async () => {
    const { user, dialog } = await apri()
    const dettagli = within(dialog).getByRole('textbox', { name: /detail/i }) as HTMLTextAreaElement
    await user.type(dettagli, 'A laptop for the new joiner')
    expect(dettagli.value).toBe('A laptop for the new joiner')

    const modello = await within(dialog).findByLabelText('Model') as HTMLInputElement
    await user.type(modello, 'ThinkPad X1')
    expect(modello.value).toBe('ThinkPad X1')
  })

  it('renders the administrator\'s form, with its conditional fields', async () => {
    const { user, dialog } = await apri()
    expect(await within(dialog).findByLabelText('Model')).toBeInTheDocument()
    expect(within(dialog).queryByLabelText('Serial')).toBeNull()
    await user.type(within(dialog).getByLabelText('Model'), 'custom')
    expect(await within(dialog).findByLabelText('Serial')).toBeInTheDocument()
  })

  it('a form whose definition is corrupt does not take the dialog down', async () => {
    // The details box and the buttons must still work: refusing to render
    // the whole request over a bad JSON would block the catalog entry.
    const { dialog } = await apri([...base(), modulo({ ...MODULO, definition: '{not json' })])
    expect(within(dialog).getByRole('heading', { name: 'New laptop' })).toBeInTheDocument()
    expect(within(dialog).getByRole('textbox')).toBeInTheDocument()
  })
})

describe('sending the request', () => {
  const creazione = (input: unknown, result: unknown): GqlMock => ({
    request: { query: CREATE_SERVICE_REQUEST, variables: input as Record<string, unknown> },
    result: result as GqlMock['result'],
  })

  it('sends the item, the details and only the VISIBLE answers, with the form revision', async () => {
    let inviato: Record<string, unknown> | null = null
    const create: GqlMock = {
      request: {
        query: CREATE_SERVICE_REQUEST,
        variables: (v: Record<string, unknown>) => { inviato = v['input'] as Record<string, unknown>; return true },
      },
      result: { data: { createServiceRequest: { __typename: 'ServiceRequest', id: 'sr-1', number: 'REQ-1', status: 'new' } } },
    }
    const { user } = renderWithProviders(<ServiceCatalogPage />, { mocks: [...base(), modulo(), create] })
    await user.click(await apribile('New laptop'))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByRole('textbox', { name: /detail/i }), 'For the new joiner')
    await user.type(await within(dialog).findByLabelText('Model'), 'X1')
    await user.click(within(dialog).getByRole('button', { name: /submit|send|create/i }))

    await waitFor(() => { expect(inviato).not.toBeNull() })
    expect(inviato).toMatchObject({
      catalogItemId: 'it-1', title: 'New laptop', description: 'For the new joiner', formRevision: 3,
    })
    // The conditional field never became visible: it must not travel.
    expect(JSON.stringify(inviato)).not.toContain('seriale')
    // No priority: the catalog item decides it.
    expect(inviato).not.toHaveProperty('severity')
  })

  it('blank details are sent as null, not as an empty string', async () => {
    let inviato: Record<string, unknown> | null = null
    const create: GqlMock = {
      request: { query: CREATE_SERVICE_REQUEST, variables: (v: Record<string, unknown>) => { inviato = v['input'] as Record<string, unknown>; return true } },
      result: { data: { createServiceRequest: { __typename: 'ServiceRequest', id: 'sr-1', number: 'REQ-1', status: 'new' } } },
    }
    const { user } = renderWithProviders(<ServiceCatalogPage />, { mocks: [...base(), modulo(), create] })
    await user.click(await apribile('New laptop'))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByRole('textbox', { name: /detail/i }), '   ')
    await user.click(within(dialog).getByRole('button', { name: /submit|send|create/i }))
    await waitFor(() => { expect(inviato).not.toBeNull() })
    expect(inviato!['description']).toBeNull()
  })

  it('lands on the request just sent, not on a list where it cannot be seen', async () => {
    // It used to land on "My tickets" with a status nobody read, and the
    // request was not even visible there (H-36 / H-2).
    const create = creazione(
      { input: expect.anything() as never },
      { data: { createServiceRequest: { __typename: 'ServiceRequest', id: 'sr-9', number: 'REQ-9', status: 'new' } } },
    )
    const { user } = renderWithProviders(<ServiceCatalogPage />, {
      mocks: [...base(), modulo(), { ...create, request: { query: CREATE_SERVICE_REQUEST, variables: () => true } }],
    })
    await user.click(await apribile('New laptop'))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: /submit|send|create/i }))
    await waitFor(() => { expect(screen.getByTestId('location').textContent).toBe('/tickets/sr-9') })
  })

  it('a refusal keeps the dialog open so nothing typed is lost', async () => {
    const rotto: GqlMock = {
      request: { query: CREATE_SERVICE_REQUEST, variables: () => true },
      error: new Error('Approval route is not configured'),
    }
    const { user } = renderWithProviders(<ServiceCatalogPage />, { mocks: [...base(), modulo(), rotto] })
    await user.click(await apribile('New laptop'))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByRole('textbox', { name: /detail/i }), 'Keep me')
    await user.click(within(dialog).getByRole('button', { name: /submit|send|create/i }))
    await waitFor(() => {
      expect((within(screen.getByRole('dialog')).getByRole('textbox', { name: /detail/i }) as HTMLTextAreaElement).value).toBe('Keep me')
    })
  })
})

describe('opening an item starts from scratch', () => {
  it('the answers of the previous item do not carry over', async () => {
    // Library fields are shared between forms: without the reset the new
    // item was born pre-filled, and its conditions evaluated against answers
    // that did not belong to it.
    const due = [voce(), voce({ id: 'it-2', name: 'New mouse' })]
    const { user } = renderWithProviders(<ServiceCatalogPage />, { mocks: [...base(due), modulo()] })
    await user.click(await apribile('New laptop'))
    let dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByRole('textbox', { name: /detail/i }), 'A laptop please')
    await user.type(await within(dialog).findByLabelText('Model'), 'X1')
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }))

    await user.click(await apribile('New mouse'))
    dialog = await screen.findByRole('dialog')
    expect((within(dialog).getByRole('textbox', { name: /detail/i }) as HTMLTextAreaElement).value).toBe('')
    expect((await within(dialog).findByLabelText('Model') as HTMLInputElement).value).toBe('')
  })
})

/**
 * FILE, RIFERIMENTI E TABELLE: le risposte che non sono valori.
 *
 * Un file si carica SUBITO, su una bozza, perché la richiesta non esiste
 * ancora — prima, dal portale, si poteva allegare solo DOPO la creazione,
 * cioè mai per un campo del modulo. E la bozza è DI QUESTA VOCE: nasceva una
 * volta per apertura della pagina, e il difetto riprodotto dal vivo il 17
 * set 2026 era caricare un file su «Nuovo portatile», chiudere, inviare
 * «Nuovo mouse» e vedere la richiesta del mouse portarsi dietro il file
 * dell'altra.
 */
describe('i campi che non portano un valore', () => {
  const campo = (name: string, fieldType: string, over: Record<string, unknown> = {}) => ({
    __typename: 'FormFieldView', name, fieldType, label: name, required: false,
    vocabulary: null, help: null, formula: null, refTypes: [], labels: [], helps: [],
    options: [], tableColumns: [], ...over,
  })
  const moduloCon = (fields: unknown[], items: Array<Record<string, unknown>>) => modulo({
    ...MODULO,
    definition: JSON.stringify({ version: 1, revision: 3, sections: [{ id: 's1', title: { en: 'D' }, items }] }),
    fields,
  })

  async function apriCon(mocks: GqlMock[]) {
    const { user } = renderWithProviders(<ServiceCatalogPage />, { mocks })
    await user.click(await apribile('New laptop'))
    return { user, dialog: await screen.findByRole('dialog') }
  }

  it('una TABELLA si compila e le sue righe viaggiano a parte, con le celle per colonna', async () => {
    let inviato: Record<string, unknown> | null = null
    const create: GqlMock = {
      request: { query: CREATE_SERVICE_REQUEST, variables: (v: Record<string, unknown>) => { inviato = v['input'] as Record<string, unknown>; return true } },
      result: { data: { createServiceRequest: { __typename: 'ServiceRequest', id: 'sr-1', number: 'REQ-1', status: 'new' } } },
    }
    const tabella = campo('righe', 'table', {
      tableColumns: [{ __typename: 'FormTableColumn', name: 'modello', label: 'Modello', fieldType: 'text', required: false, options: [] }],
    })
    const { user, dialog } = await apriCon([...base(), moduloCon([tabella], [{ field: 'righe' }]), create])

    await user.click(await within(dialog).findByRole('button', { name: /add/i }))
    await user.type(within(dialog).getAllByRole('textbox').at(-1)!, 'X1')
    await user.click(within(dialog).getByRole('button', { name: /submit|send|create/i }))

    await waitFor(() => { expect(inviato).not.toBeNull() })
    expect(inviato!['formAnswers']).toEqual([
      { name: 'righe', rows: [{ cells: [{ column: 'modello', value: 'X1' }] }] },
    ])
  })

  it('una tabella lasciata vuota non manda righe', async () => {
    let inviato: Record<string, unknown> | null = null
    const create: GqlMock = {
      request: { query: CREATE_SERVICE_REQUEST, variables: (v: Record<string, unknown>) => { inviato = v['input'] as Record<string, unknown>; return true } },
      result: { data: { createServiceRequest: { __typename: 'ServiceRequest', id: 'sr-1', number: 'REQ-1', status: 'new' } } },
    }
    const tabella = campo('righe', 'table', {
      tableColumns: [{ __typename: 'FormTableColumn', name: 'modello', label: 'Modello', fieldType: 'text', required: false, options: [] }],
    })
    const { user, dialog } = await apriCon([...base(), moduloCon([tabella], [{ field: 'righe' }]), create])
    await user.click(within(dialog).getByRole('button', { name: /submit|send|create/i }))
    await waitFor(() => { expect(inviato).not.toBeNull() })
    expect(inviato!['formAnswers']).toEqual([])
  })

  it('un ALLEGATO si carica subito sulla bozza, e la bozza viaggia con la richiesta', async () => {
    const { uploadFormDraftFile } = await import('../lib/formDraftUpload')
    const caricato = vi.spyOn(await import('../lib/formDraftUpload'), 'uploadFormDraftFile')
    void uploadFormDraftFile
    caricato.mockResolvedValue({ id: 'att-1', filename: 'contratto.pdf', sizeBytes: 1024 })

    let inviato: Record<string, unknown> | null = null
    const create: GqlMock = {
      request: { query: CREATE_SERVICE_REQUEST, variables: (v: Record<string, unknown>) => { inviato = v['input'] as Record<string, unknown>; return true } },
      result: { data: { createServiceRequest: { __typename: 'ServiceRequest', id: 'sr-1', number: 'REQ-1', status: 'new' } } },
    }
    const { user, dialog } = await apriCon([...base(), moduloCon([campo('documento', 'attachment')], [{ field: 'documento' }]), create])

    const input = await within(dialog).findByLabelText('documento') as HTMLInputElement
    await user.upload(input, new File(['x'], 'contratto.pdf', { type: 'application/pdf' }))
    expect(await within(dialog).findByText('contratto.pdf')).toBeInTheDocument()
    expect(caricato).toHaveBeenCalledWith(expect.any(String), 'documento', expect.objectContaining({ name: 'contratto.pdf' }))

    await user.click(within(dialog).getByRole('button', { name: /submit|send|create/i }))
    await waitFor(() => { expect(inviato).not.toBeNull() })
    // La bozza viaggia; l'allegato NON viaggia come risposta.
    expect(typeof inviato!['formDraftId']).toBe('string')
    expect(inviato!['formAnswers']).toEqual([])
    caricato.mockRestore()
  })

  it('ogni apertura di una voce comincia una bozza SUA: i file di prima non la seguono', async () => {
    const caricato = vi.spyOn(await import('../lib/formDraftUpload'), 'uploadFormDraftFile')
    caricato.mockResolvedValue({ id: 'att-1', filename: 'contratto.pdf', sizeBytes: 1024 })
    const due = [voce(), voce({ id: 'it-2', name: 'New mouse' })]
    const { user } = renderWithProviders(<ServiceCatalogPage />, {
      mocks: [...base(due), moduloCon([campo('documento', 'attachment')], [{ field: 'documento' }])],
    })

    await user.click(await apribile('New laptop'))
    let dialog = await screen.findByRole('dialog')
    await user.upload(await within(dialog).findByLabelText('documento'), new File(['x'], 'contratto.pdf'))
    await within(dialog).findByText('contratto.pdf')
    const primaBozza = caricato.mock.calls[0]![0]
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }))

    await user.click(await apribile('New mouse'))
    dialog = await screen.findByRole('dialog')
    // Il file di prima non si vede più, e la bozza è un'altra.
    await waitFor(() => { expect(within(dialog).queryByText('contratto.pdf')).toBeNull() })
    await user.upload(await within(dialog).findByLabelText('documento'), new File(['y'], 'altro.pdf'))
    await waitFor(() => { expect(caricato.mock.calls.length).toBe(2) })
    expect(caricato.mock.calls[1]![0]).not.toBe(primaBozza)
    caricato.mockRestore()
  })

  it('un caricamento fallito lo dice e non lascia un file a metà', async () => {
    const caricato = vi.spyOn(await import('../lib/formDraftUpload'), 'uploadFormDraftFile')
    caricato.mockRejectedValue(new Error('File too large (max 10MB)'))
    const { user, dialog } = await apriCon([...base(), moduloCon([campo('documento', 'attachment')], [{ field: 'documento' }])])
    await user.upload(await within(dialog).findByLabelText('documento'), new File(['x'], 'enorme.pdf'))
    await waitFor(() => { expect(within(dialog).queryByText('enorme.pdf')).toBeNull() })
    caricato.mockRestore()
  })
})

describe('le risposte che si spengono, i rifiuti e i riferimenti', () => {
  const campo = (name: string, fieldType: string, over: Record<string, unknown> = {}) => ({
    __typename: 'FormFieldView', name, fieldType, label: name, required: false,
    vocabulary: null, help: null, formula: null, refTypes: [], labels: [], helps: [],
    options: [], tableColumns: [], ...over,
  })
  const moduloCon = (fields: unknown[], items: Array<Record<string, unknown>>) => modulo({
    ...MODULO,
    definition: JSON.stringify({ version: 1, revision: 3, sections: [{ id: 's1', title: { en: 'D' }, items }] }),
    fields,
  })
  const cattura = (): [GqlMock, () => Record<string, unknown> | null] => {
    let inviato: Record<string, unknown> | null = null
    return [{
      request: { query: CREATE_SERVICE_REQUEST, variables: (v: Record<string, unknown>) => { inviato = v['input'] as Record<string, unknown>; return true } },
      result: { data: { createServiceRequest: { __typename: 'ServiceRequest', id: 'sr-1', number: 'REQ-1', status: 'new' } } },
    }, () => inviato]
  }

  it('una condizione che si SPEGNE fa dimenticare la risposta: il server la rifiuterebbe', async () => {
    const [create, letto] = cattura()
    const { user } = renderWithProviders(<ServiceCatalogPage />, { mocks: [...base(), modulo(), create] })
    await user.click(await apribile('New laptop'))
    const dialog = await screen.findByRole('dialog')

    // Si accende la condizione, si risponde, poi la si spegne.
    await user.type(await within(dialog).findByLabelText('Model'), 'custom')
    await user.type(await within(dialog).findByLabelText('Serial'), 'SN-1')
    await user.clear(within(dialog).getByLabelText('Model'))
    await user.type(within(dialog).getByLabelText('Model'), 'standard')
    await waitFor(() => { expect(within(dialog).queryByLabelText('Serial')).toBeNull() })

    await user.click(within(dialog).getByRole('button', { name: /submit|send|create/i }))
    await waitFor(() => { expect(letto()).not.toBeNull() })
    expect(JSON.stringify(letto())).not.toContain('SN-1')
  })

  it('un rifiuto che NOMINA un campo lo accende accanto a quel campo', async () => {
    // Il portale non passava affatto `errors` al renderer: l'unico segnale
    // era l'avviso all'angolo, che sparisce dopo pochi secondi e su un
    // modulo lungo lascia indovinare quale casella (17 set 2026).
    const rifiuto: GqlMock = {
      request: { query: CREATE_SERVICE_REQUEST, variables: () => true },
      result: { errors: [{ message: 'Model is required', extensions: { i18n: { key: 'errors.field.required', params: { name: 'modello' } } } } as never] },
    }
    const { user } = renderWithProviders(<ServiceCatalogPage />, { mocks: [...base(), modulo(), rifiuto] })
    await user.click(await apribile('New laptop'))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByLabelText('Model')
    await user.click(within(dialog).getByRole('button', { name: /submit|send|create/i }))
    await waitFor(() => {
      expect(within(screen.getByRole('dialog')).getByLabelText('Model').getAttribute('aria-invalid')).toBe('true')
    })
  })

  it('un RIFERIMENTO si sceglie fra i CI che il prodotto offre, e viaggia in refIds', async () => {
    // Non si naviga la CMDB: il server risponde con i CI dei tipi che quel
    // campo dichiara (20 set 2026).
    const [create, letto] = cattura()
    const scelte: GqlMock = {
      request: { query: GET_PORTAL_REFERENCE_CHOICES, variables: () => true },
      result: { data: { portalReferenceChoices: [{ __typename: 'ReferenceChoice', id: 'ci-1', label: 'Stampante 1' }] } },
      maxUsageCount: sempre,
    }
    const { user } = renderWithProviders(<ServiceCatalogPage />, {
      mocks: [...base(), moduloCon([campo('stampante', 'ref_ci', { refTypes: ['printer'] })], [{ field: 'stampante' }]), scelte, create],
    })
    await user.click(await apribile('New laptop'))
    const dialog = await screen.findByRole('dialog')
    await user.type(await within(dialog).findByRole('searchbox'), 'st')
    await user.click(await within(dialog).findByRole('button', { name: 'Stampante 1' }))
    await user.click(within(dialog).getByRole('button', { name: /submit|send|create/i }))

    await waitFor(() => { expect(letto()).not.toBeNull() })
    expect(letto()!['formAnswers']).toEqual([{ name: 'stampante', refIds: ['ci-1'] }])
  })

  it('un riferimento non scelto viaggia come lista vuota, non come valore', async () => {
    const [create, letto] = cattura()
    const scelte: GqlMock = {
      request: { query: GET_PORTAL_REFERENCE_CHOICES, variables: () => true },
      result: { data: { portalReferenceChoices: [] } }, maxUsageCount: sempre,
    }
    const { user } = renderWithProviders(<ServiceCatalogPage />, {
      mocks: [...base(), moduloCon([campo('stampante', 'ref_ci')], [{ field: 'stampante' }]), scelte, create],
    })
    await user.click(await apribile('New laptop'))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByRole('searchbox')
    await user.click(within(dialog).getByRole('button', { name: /submit|send|create/i }))
    await waitFor(() => { expect(letto()).not.toBeNull() })
    expect(letto()!['formAnswers']).toEqual([{ name: 'stampante', refIds: [] }])
  })

  it('un campo del cliente OBBLIGATORIO ferma l\'invio, e lo dice accanto al campo', async () => {
    const [create, letto] = cattura()
    const campiObbligatori = campiCliente([
      { __typename: 'PortalCustomField', name: 'centro_di_costo', label: 'Centro di costo', fieldType: 'text', required: true, options: [] },
    ])
    const { user } = renderWithProviders(<ServiceCatalogPage />, {
      mocks: [me(), categorie, campiObbligatori, catalogo([voce()]), modulo(), create],
    })
    await user.click(await apribile('New laptop'))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByLabelText(/Centro di costo/)
    await user.click(within(dialog).getByRole('button', { name: /submit|send|create/i }))

    // Non e' partito niente, e il campo lo dice.
    await waitFor(() => { expect(within(dialog).getByText(/required|obbligatorio/i)).toBeInTheDocument() })
    expect(letto()).toBeNull()
  })

  it('un campo del cliente compilato viaggia con la richiesta', async () => {
    const [create, letto] = cattura()
    const campiCon = campiCliente([
      { __typename: 'PortalCustomField', name: 'centro_di_costo', label: 'Centro di costo', fieldType: 'text', required: false, options: [] },
    ])
    const { user } = renderWithProviders(<ServiceCatalogPage />, {
      mocks: [me(), categorie, campiCon, catalogo([voce()]), modulo(), create],
    })
    await user.click(await apribile('New laptop'))
    const dialog = await screen.findByRole('dialog')
    await user.type(await within(dialog).findByLabelText(/Centro di costo/), 'IT-01')
    await user.click(within(dialog).getByRole('button', { name: /submit|send|create/i }))
    await waitFor(() => { expect(letto()).not.toBeNull() })
    expect(letto()!['customFields']).toEqual([{ name: 'centro_di_costo', value: 'IT-01' }])
  })
})
