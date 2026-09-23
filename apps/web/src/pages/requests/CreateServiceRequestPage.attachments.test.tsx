/**
 * A FILE ATTACHED TO THE FORM OF A NEW REQUEST, THAT THE SERVER WILL NOT LET GO.
 *
 * Files of a catalog form are uploaded at once to a draft, before the request
 * exists. Removing one is a call to the server, and the server can refuse it
 * (the file is locked, the draft expired). Then the person must be told, and
 * the file must stay in the list — it is still on the draft, and it would
 * reach the request even though the form says it is gone.
 *
 * Also here: a catalog item without a category is listed by its name alone,
 * without a dangling separator.
 *
 * The form renderer is replaced by a stand-in with the attachment controls
 * only: the renderer has its own tests in web-core.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { CreateServiceRequestPage } from './CreateServiceRequestPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast, Toaster: () => null }))
vi.mock('@/hooks/useEnumValues', () => ({ useEnumValues: () => ({ values: ['low', 'high'], loading: false }) }))
vi.mock('@/hooks/useValueStyle', () => ({ useValueStyle: () => () => ({ bg: '', color: '', accent: '' }) }))
vi.mock('@/contexts/DomainVocabularyContext', () => ({ useDomainVocabularies: () => ({ labelOf: () => null }) }))
const upload = vi.hoisted(() => vi.fn<(draft: string, field: string, file: File) => Promise<{ id: string; filename: string; sizeBytes: number }>>())
vi.mock('@/lib/formDraftUpload', () => ({ uploadFormDraftFile: (d: string, f: string, file: File) => upload(d, f, file) }))
vi.mock('@opengraphity/web-core', async (orig) => {
  const real = await orig<typeof import('@opengraphity/web-core')>()
  type Props = import('@opengraphity/web-core').CatalogFormRendererProps
  /** Stand-in renderer: the attachment callbacks of the real one, as buttons. */
  function FakeRenderer(p: Props) {
    return (
      <div data-testid="catalog-form">
        {p.fields.map((f) => (
          <div key={f.name}>
            <button type="button" onClick={() => void p.onUploadFile?.(f.name, new File(['x'], 'spec.pdf'))}>{`upload ${f.name}`}</button>
            {(p.files?.[f.name] ?? []).map((file) => (
              <button key={file.id} type="button" onClick={() => void p.onRemoveFile?.(f.name, file.id)}>{`remove ${file.filename}`}</button>
            ))}
          </div>
        ))}
      </div>
    )
  }
  return { ...real, CatalogFormRenderer: FakeRenderer }
})

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset()
  toast.error.mockReset()
  upload.mockReset().mockResolvedValue({ id: 'att-1', filename: 'spec.pdf', sizeBytes: 1 })
  apolloFinto.risposte['GetServiceCatalogAdmin'] = { serviceCatalogItems: [
    { id: 'cat-1', name: 'New laptop', description: null, category: 'hw', requiresApproval: false, priority: 'high', active: true },
    { id: 'cat-2', name: 'App access', description: null, category: null, requiresApproval: false, priority: null, active: true },
  ] }
  apolloFinto.risposte['GetCatalogFormToFill'] = (v?: Record<string, unknown>) => (v?.['itemId'] === 'cat-1'
    ? { catalogFormToFill: { itemId: 'cat-1', revision: 1, fields: [{ name: 'doc', fieldType: 'attachment', label: 'Doc', required: false }],
        definition: JSON.stringify({ version: 1, revision: 1, sections: [{ id: 'main', title: {}, items: [{ field: 'doc' }] }] }) } }
    : { catalogFormToFill: null })
  apolloFinto.risposte['GetTicketCreationCustomFields'] = { ticketCreationCustomFields: [] }
  apolloFinto.risposte['GetTicketCIExclusions'] = { ticketCIExclusions: [{ ticketType: 'service_request', ciTypes: [] }] }
})

describe('CreateServiceRequestPage: a file the server will not remove', () => {
  it('is said, and stays in the list', async () => {
    apolloFinto.esiti['DeleteFormAttachment'] = { error: new Error('The file is locked by another upload') }
    const { user } = renderWithProviders(<CreateServiceRequestPage />)
    await user.selectOptions(screen.getByRole('combobox', { name: /Catalog item/ }), 'cat-1')
    await user.click(screen.getByRole('button', { name: 'upload doc' }))
    await user.click(await screen.findByRole('button', { name: 'remove spec.pdf' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The file is locked by another upload'))
    expect(apolloFinto.chiamata('DeleteFormAttachment')).toEqual({ id: 'att-1' })
    expect(screen.getByRole('button', { name: 'remove spec.pdf' })).toBeInTheDocument()
  })
})

describe('CreateServiceRequestPage: the catalog', () => {
  it('an item without a category is listed by its name alone', () => {
    renderWithProviders(<CreateServiceRequestPage />)
    const items = within(screen.getByRole('combobox', { name: /Catalog item/ })).getAllByRole('option').map((o) => o.textContent)
    expect(items).toContain('App access')
    expect(items).toContain('hw · New laptop')
  })
})
