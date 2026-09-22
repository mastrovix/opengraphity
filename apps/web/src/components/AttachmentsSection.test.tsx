/**
 * ATTACHMENTS ON A TICKET OR CI: list, upload, authenticated download, delete.
 *
 * Every detail page embeds this card. What breaks for a user if it regresses:
 * - the upload is a multipart REST POST; if a rejected file (too big, wrong
 *   type) is reported as "uploaded", the user believes evidence is on the
 *   ticket when it is not — so the SERVER's reason must reach them;
 * - the download needs the Bearer header, so it fetches a blob instead of a
 *   plain link; a 401/404 must be shown with its real cause, not swallowed;
 * - deleting is irreversible, so it must go through the confirmation, and a
 *   "no" must delete nothing;
 * - the organisation's policy (size, extensions) is told BEFORE picking a file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, fireEvent, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { AttachmentsSection } = await import('./AttachmentsSection')

const ATTACHMENTS = [
  { id: 'a1', filename: 'log.txt', mimeType: 'text/plain', sizeBytes: 512, uploadedBy: 'u', uploadedAt: '', description: null, downloadUrl: '/api/attachments/a1' },
  { id: 'a2', filename: 'shot.png', mimeType: 'image/png', sizeBytes: 2048, uploadedBy: 'u', uploadedAt: '', description: null, downloadUrl: 'https://files.example/a2' },
  { id: 'a3', filename: 'dump.bin', mimeType: 'application/octet-stream', sizeBytes: 3 * 1024 * 1024, uploadedBy: 'u', uploadedAt: '', description: null, downloadUrl: '/api/attachments/a3' },
]

const fetchMock = vi.fn()

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset()
  toast.error.mockReset()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  apolloFinto.risposte['GetAttachments'] = { attachments: ATTACHMENTS }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const mount = () => renderWithProviders(<AttachmentsSection entityType="incident" entityId="INC1" />)
const fileInput = (container: HTMLElement) => container.querySelector('input[type="file"]') as HTMLInputElement
const pick = (input: HTMLInputElement, files: File[]) => fireEvent.change(input, { target: { files } })

describe('AttachmentsSection — list', () => {
  it('lists the attachments of this entity with human sizes', () => {
    mount()
    expect(apolloFinto.chiamata('GetAttachments')).toEqual({ entityType: 'incident', entityId: 'INC1' })
    expect(screen.getByText('log.txt')).toBeInTheDocument()
    expect(screen.getByText('512 B')).toBeInTheDocument()
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
    expect(screen.getByText('3.0 MB')).toBeInTheDocument()
  })

  it('an entity without attachments says so, and without a policy the picker accepts anything', () => {
    apolloFinto.risposte['GetAttachments'] = undefined
    const { container } = mount()
    expect(screen.getByText('No attachments.')).toBeInTheDocument()
    expect(fileInput(container)).not.toHaveAttribute('accept')
  })

  it('the organisation policy is shown before choosing and restricts the picker', () => {
    apolloFinto.risposte['GetAttachmentPolicy'] = { attachmentPolicy: { maxSizeMb: 10, extensions: ['pdf', 'png'] } }
    const { container } = mount()
    expect(screen.getByText('Up to 10 MB: .pdf, .png')).toBeInTheDocument()
    expect(fileInput(container)).toHaveAttribute('accept', '.pdf,.png')
  })
})

describe('AttachmentsSection — upload', () => {
  it('the button opens the file picker', async () => {
    const { container, user } = mount()
    const click = vi.spyOn(fileInput(container), 'click')
    await user.click(screen.getByRole('button', { name: /Attach file/ }))
    expect(click).toHaveBeenCalled()
  })

  it('posts every file as multipart for this entity, then reports success and refreshes the list', async () => {
    fetchMock.mockResolvedValue({ ok: true })
    const { container } = mount()
    const input = fileInput(container)
    pick(input, [new File(['a'], 'one.txt'), new File(['b'], 'two.txt')])
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('File uploaded'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toMatch(/\/api\/attachments$/)
    expect(init.method).toBe('POST')
    const body = init.body as FormData
    expect(body.get('entityType')).toBe('incident')
    expect(body.get('entityId')).toBe('INC1')
    expect((body.get('file') as File).name).toBe('one.txt')
    expect(apolloFinto.refetch).toHaveBeenCalled()
    // The input is cleared so choosing the same file again triggers a new upload.
    expect(input.value).toBe('')
  })

  it('a rejected upload shows the server reason and never says "uploaded"', async () => {
    fetchMock.mockResolvedValue({ ok: false, statusText: 'Payload Too Large', json: async () => ({ error: 'File exceeds 10 MB' }) })
    const { container } = mount()
    pick(fileInput(container), [new File(['a'], 'big.iso')])
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('File exceeds 10 MB'))
    expect(toast.success).not.toHaveBeenCalled()
    // The button is usable again after the failure.
    expect(screen.getByRole('button', { name: /Attach file/ })).toBeEnabled()
  })

  it('a rejection with a non-JSON body falls back to the HTTP status text', async () => {
    fetchMock.mockResolvedValue({ ok: false, statusText: 'Bad Gateway', json: async () => { throw new SyntaxError('html') } })
    const { container } = mount()
    pick(fileInput(container), [new File(['a'], 'x.txt')])
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Bad Gateway'))
  })

  it('a JSON body without a reason also falls back to the status text', async () => {
    fetchMock.mockResolvedValue({ ok: false, statusText: 'Forbidden', json: async () => ({}) })
    const { container } = mount()
    pick(fileInput(container), [new File(['a'], 'x.txt')])
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Forbidden'))
  })

  it('a non-Error failure uses the generic upload message', async () => {
    fetchMock.mockRejectedValue('offline')
    const { container } = mount()
    pick(fileInput(container), [new File(['a'], 'x.txt')])
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Upload failed'))
  })

  it('while uploading, the button says so and cannot be pressed again', async () => {
    let finish!: (v: unknown) => void
    fetchMock.mockReturnValue(new Promise((r) => { finish = r }))
    const { container } = mount()
    pick(fileInput(container), [new File(['a'], 'x.txt')])
    expect(await screen.findByRole('button', { name: /Uploading/ })).toBeDisabled()
    finish({ ok: true })
    await waitFor(() => expect(screen.getByRole('button', { name: /Attach file/ })).toBeEnabled())
  })

  it('cancelling the picker (no files) sends nothing', () => {
    const { container } = mount()
    pick(fileInput(container), [])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('AttachmentsSection — download', () => {
  it('fetches an API path on the API origin with the bearer header and saves it under its filename', async () => {
    fetchMock.mockResolvedValue({ ok: true, blob: async () => new Blob(['x']) })
    // Node's own createObjectURL cannot read a jsdom Blob: stand in for the browser.
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:attachment')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    // Capture the anchor the component creates, so its click does not navigate jsdom.
    const anchors: HTMLAnchorElement[] = []
    const create = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = create(tag)
      if (tag === 'a') { (el as HTMLAnchorElement).click = vi.fn(); anchors.push(el as HTMLAnchorElement) }
      return el
    })
    const { user } = mount()
    await user.click(screen.getByText('log.txt'))
    await waitFor(() => expect(anchors[0]?.click).toHaveBeenCalled())
    // Saved under the attachment's own name, not the blob id.
    expect(anchors[0]!.download).toBe('log.txt')
    expect(anchors[0]!.href).toBe('blob:attachment')
    // The blob URL is released, or every download leaks the file in memory.
    expect(revoke).toHaveBeenCalledWith('blob:attachment')
    expect(toast.error).not.toHaveBeenCalled()
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toMatch(/\/api\/attachments\/a1$/)
    expect(init.headers).toBeDefined()
  })

  it('an absolute download URL is used as is', async () => {
    fetchMock.mockResolvedValue({ ok: true, blob: async () => new Blob(['x']) })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:attachment')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const { user } = mount()
    await user.click(screen.getByText('shot.png'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('https://files.example/a2', expect.anything()))
  })

  it('a failed download shows the real cause (status), not a generic label', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' })
    const { user } = mount()
    await user.click(screen.getByText('log.txt'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Download failed: 404 Not Found'))
  })
})

describe('AttachmentsSection — delete', () => {
  it('deletes only after confirmation, then reports and refreshes', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Delete shot.png' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Delete this attachment?')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(apolloFinto.chiamata('DeleteAttachment')).toEqual({ id: 'a2' }))
    expect(toast.success).toHaveBeenCalledWith('Attachment deleted')
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('cancelling the confirmation deletes nothing', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Delete log.txt' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(apolloFinto.chiamata('DeleteAttachment')).toBeUndefined()
  })

  it('a failed delete is shown to the user', async () => {
    apolloFinto.esiti['DeleteAttachment'] = { error: new Error('not allowed') }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Delete log.txt' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('not allowed'))
    expect(toast.success).not.toHaveBeenCalled()
  })
})
