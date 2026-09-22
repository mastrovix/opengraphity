/**
 * THE BRAND: logo and name in the portal, e-mails and PDFs; sender name and
 * reply-to address.
 *
 * What a regression would cost the customer:
 *  - an invalid name or reply-to reaching the server would put a broken
 *    header on every outgoing e-mail, so the page refuses it BEFORE saving and
 *    says which field is wrong;
 *  - Save is offered only when something changed, and what is sent is trimmed
 *    (an empty reply-to is "none", not an empty address);
 *  - a failed save or upload is SAID — it used to look successful (G-16);
 *  - the upload error from the server is shown in the reader's language when
 *    the server sends a key, and never as "[object Object]";
 *  - removing the logo asks first, and a failed removal is not reported as done.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, fireEvent, within } from '@testing-library/react'
import i18n from '@/i18n/i18n'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { BrandSection } = await import('./BrandSection')

const T = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts) as string

const SAVED = { displayName: 'Acme IT', senderName: 'Acme Service Desk', replyTo: 'help@acme.test' as string | null, logoUrl: null as string | null, logoMimeType: null as string | null, isDefault: false }

const fetchMock = vi.fn()
beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset(); toast.error.mockReset()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals() })

const show = (over: Partial<typeof SAVED> = {}) => {
  apolloFinto.risposte['GetTenantBrandSettings'] = { tenantBrandSettings: { ...SAVED, ...over } }
  return renderWithProviders(<BrandSection />)
}
const field = (key: string) => screen.getByLabelText(T(`pages.organization.${key}`)) as HTMLInputElement
const saveButton = () => screen.getByRole('button', { name: T('common.save') })
const fileInput = () => screen.getByLabelText(T('pages.organization.logoUpload'), { selector: 'input' }) as HTMLInputElement
const upload = (file = new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })) =>
  fireEvent.change(fileInput(), { target: { files: [file] } })
const response = (ok: boolean, body?: unknown, statusText = 'Bad Request') => ({
  ok, statusText,
  json: body === undefined ? () => Promise.reject(new Error('no body')) : () => Promise.resolve(body),
})

describe('BrandSection — loading', () => {
  it('shows the saved values, and Save is off until something changes', () => {
    show()
    expect(field('displayName').value).toBe('Acme IT')
    expect(field('senderName').value).toBe('Acme Service Desk')
    expect(field('replyTo').value).toBe('help@acme.test')
    expect(saveButton()).toBeDisabled()
    expect(screen.queryByText(T('pages.organization.brandFactory'))).not.toBeInTheDocument()
  })

  it('factory values are announced as such, and without a reply-to the field is empty', () => {
    show({ isDefault: true, replyTo: null })
    expect(screen.getByText(T('pages.organization.brandFactory'))).toBeInTheDocument()
    expect(field('replyTo').value).toBe('')
  })

  it('a query error is shown with a retry, instead of an empty form', async () => {
    apolloFinto.erroriQuery['GetTenantBrandSettings'] = new Error('brand unavailable')
    const { user } = renderWithProviders(<BrandSection />)
    expect(screen.getByText(/brand unavailable/)).toBeInTheDocument()
    expect(screen.queryByLabelText(T('pages.organization.displayName'))).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: T('queryError.retry') }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })
})

describe('BrandSection — names and reply-to', () => {
  it('saves trimmed values, and an emptied reply-to as null (no address, not an empty one)', async () => {
    const { user } = show()
    await user.clear(field('displayName')); await user.type(field('displayName'), '  Acme  ')
    await user.clear(field('replyTo'))
    expect(saveButton()).toBeEnabled()
    await user.click(saveButton())
    await waitFor(() => expect(apolloFinto.chiamata('SetTenantBrand')).toEqual({ input: { displayName: 'Acme', senderName: 'Acme Service Desk', replyTo: null } }))
    expect(toast.success).toHaveBeenCalledWith(T('pages.organization.brandSaved'))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('an invalid reply-to is named, and blocks Save', async () => {
    const { user } = show()
    await user.clear(field('replyTo')); await user.type(field('replyTo'), 'not an address')
    expect(screen.getByRole('alert')).toHaveTextContent(T('pages.organization.replyToInvalid'))
    expect(saveButton()).toBeDisabled()
  })

  it('a name with characters that break a mail header, or an empty one, blocks Save', async () => {
    const { user } = show()
    await user.clear(field('senderName')); await user.type(field('senderName'), 'Acme <desk>')
    expect(screen.getByRole('alert')).toHaveTextContent(T('pages.organization.brandNameInvalid'))
    expect(saveButton()).toBeDisabled()
    await user.clear(field('senderName'))
    expect(screen.getByRole('alert')).toHaveTextContent(T('pages.organization.brandNameInvalid'))
    await user.type(field('senderName'), 'Acme Desk')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(saveButton()).toBeEnabled()
  })

  it('a refused save is shown as an error, not as saved', async () => {
    apolloFinto.esiti['SetTenantBrand'] = { error: new Error('Reply-to domain not allowed') }
    const { user } = show()
    await user.type(field('senderName'), '!')
    await user.click(saveButton())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Reply-to domain not allowed')))
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe('BrandSection — logo', () => {
  it('without a logo: the product logo is previewed, there is nothing to remove, and the hint says so', () => {
    show()
    expect(screen.getByAltText(T('pages.organization.logoPreview'))).toHaveAttribute('src', '/opengrafo-logo.svg')
    expect(screen.queryByRole('button', { name: T('pages.organization.logoRemove') })).not.toBeInTheDocument()
    expect(screen.getByText(T('pages.organization.logoHintNone'))).toBeInTheDocument()
  })

  it('with a logo: it is previewed from the API, and the hint depends on its format', () => {
    const { unmount } = show({ logoUrl: '/api/brand/logo?v=2', logoMimeType: 'image/svg+xml' })
    expect(screen.getByAltText(T('pages.organization.logoPreview')).getAttribute('src')).toContain('/api/brand/logo?v=2')
    expect(screen.getByText(T('pages.organization.logoHintSvg'))).toBeInTheDocument()
    unmount()
    show({ logoUrl: '/api/brand/logo?v=3', logoMimeType: 'image/png' })
    expect(screen.getByText(T('pages.organization.logoHintPng'))).toBeInTheDocument()
  })

  it('the upload button opens the file picker', async () => {
    const { user } = show()
    const click = vi.spyOn(fileInput(), 'click')
    await user.click(screen.getByRole('button', { name: T('pages.organization.logoUpload') }))
    expect(click).toHaveBeenCalled()
  })

  it('uploading posts the file, confirms and reloads the brand; the picker is reset', async () => {
    fetchMock.mockResolvedValue(response(true, {}))
    show()
    upload()
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(T('pages.organization.logoSaved')))
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toContain('/api/brand/logo')
    expect(init.method).toBe('POST')
    expect((init.body as FormData).get('file')).toBeInstanceOf(File)
    expect(apolloFinto.refetch).toHaveBeenCalled()
    // Picking the same file again must fire a change: the value is cleared.
    expect(fileInput().value).toBe('')
    expect(screen.getByRole('button', { name: T('pages.organization.logoUpload') })).toBeEnabled()
  })

  it('a cancelled picker (no file) uploads nothing', () => {
    show()
    fireEvent.change(fileInput(), { target: { files: [] } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('while uploading the button says so and cannot be pressed twice', async () => {
    let resolve!: (v: unknown) => void
    fetchMock.mockReturnValue(new Promise((r) => { resolve = r }))
    show()
    upload()
    const busy = await screen.findByRole('button', { name: T('pages.organization.logoUploading') })
    expect(busy).toBeDisabled()
    resolve(response(true, {}))
    await waitFor(() => expect(screen.getByRole('button', { name: T('pages.organization.logoUpload') })).toBeEnabled())
  })

  describe('a refused upload shows the reason', () => {
    it('as a plain string from the server', async () => {
      fetchMock.mockResolvedValue(response(false, { error: 'File too large' }))
      show(); upload()
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('File too large'))
      expect(toast.success).not.toHaveBeenCalled()
    })

    it('translated when the server sends a key', async () => {
      fetchMock.mockResolvedValue(response(false, { error: { key: 'common.save', message: 'fallback' } }))
      show(); upload()
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(T('common.save')))
    })

    it('with the server message when the key is unknown to the client', async () => {
      fetchMock.mockResolvedValue(response(false, { error: { key: 'no.such.key.anywhere', message: 'Only PNG or SVG' } }))
      show(); upload()
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Only PNG or SVG'))
    })

    it('with the message alone when there is no key', async () => {
      fetchMock.mockResolvedValue(response(false, { error: { key: null, message: 'Image unreadable' } }))
      show(); upload()
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Image unreadable'))
    })

    it('with the HTTP status text when the body is not JSON, or has no error', async () => {
      fetchMock.mockResolvedValueOnce(response(false, undefined, 'Payload Too Large'))
      const { unmount } = show(); upload()
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Payload Too Large'))
      unmount()
      fetchMock.mockResolvedValueOnce(response(false, {}, 'Bad Gateway'))
      show(); upload()
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Bad Gateway'))
    })

    it('with a translated key and no message, the translation of the key', async () => {
      fetchMock.mockResolvedValue(response(false, { error: { key: 'common.cancel' } }))
      show(); upload()
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(T('common.cancel')))
    })
  })

  describe('removing the logo', () => {
    const removeButton = () => screen.getByRole('button', { name: T('pages.organization.logoRemove') })

    it('asks first: "no" removes nothing', async () => {
      const { user } = show({ logoUrl: '/api/brand/logo', logoMimeType: 'image/png' })
      await user.click(removeButton())
      const dialog = await screen.findByRole('dialog')
      expect(dialog).toHaveTextContent(T('pages.organization.logoRemoveConfirm'))
      await user.click(within(dialog).getByRole('button', { name: T('common.cancel') }))
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('"yes" deletes it on the server, confirms and reloads', async () => {
      fetchMock.mockResolvedValue(response(true, {}))
      const { user } = show({ logoUrl: '/api/brand/logo', logoMimeType: 'image/png' })
      await user.click(removeButton())
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: T('common.confirm') }))
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith(T('pages.organization.logoRemoved')))
      expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('DELETE')
      expect(apolloFinto.refetch).toHaveBeenCalled()
    })

    it('a failed removal is reported, not confirmed', async () => {
      fetchMock.mockResolvedValue(response(false, {}))
      const { user } = show({ logoUrl: '/api/brand/logo', logoMimeType: 'image/png' })
      await user.click(removeButton())
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: T('common.confirm') }))
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(T('pages.organization.logoRemoveFailed')))
      expect(toast.success).not.toHaveBeenCalled()
      expect(apolloFinto.refetch).not.toHaveBeenCalled()
    })
  })
})
