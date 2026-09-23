/**
 * THE KNOWLEDGE-BASE EDITOR: rich text on screen, Markdown on the wire.
 *
 * An article is stored as Markdown; the author edits it as formatted text.
 * So the editor must (1) show the Markdown it is given as formatted text,
 * (2) give back Markdown that means the same thing — headings, lists, quotes,
 * code, tables, links, images — once the author pauses (not at every
 * keystroke), (3) take a new value from outside (another article) but never
 * overwrite what the author is typing, and (4) stay read-only when asked.
 * A formatting that the toolbar offers but the Markdown drops is lost on the
 * next save without a word: so the toolbar offers only what the Markdown
 * keeps (strikethrough as GFM `~~text~~`, underline as `<u>text</u>`).
 *
 * jsdom has no layout: ProseMirror asks the browser where the caret is to
 * scroll it into view, so `Range` gets the two measuring methods jsdom lacks
 * (returning empty boxes), like the global setup does for other browser APIs.
 */
import { useState } from 'react'
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RichTextEditor } from './RichTextEditor'

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

type RangeWithLayout = { getClientRects?: () => DOMRect[]; getBoundingClientRect?: () => DOMRect }
const rangeProto = Range.prototype as unknown as RangeWithLayout

beforeAll(() => {
  rangeProto.getClientRects = () => []
  rangeProto.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
})
afterAll(() => {
  delete rangeProto.getClientRects
  delete rangeProto.getBoundingClientRect
})
afterEach(() => {
  delete (document as { elementFromPoint?: unknown }).elementFromPoint
})

function mount(value: string, props: { placeholder?: string; readOnly?: boolean } = {}) {
  const onChange = vi.fn()
  const user = userEvent.setup()
  const r = render(<RichTextEditor value={value} onChange={onChange} {...props} />)
  return { ...r, user, onChange }
}

/** The page as the KB admin uses it: the Markdown lives in the parent's state. */
function Harness({ initial, onMarkdown }: { initial: string; onMarkdown?: (md: string) => void }) {
  const [md, setMd] = useState(initial)
  return <RichTextEditor value={md} onChange={(v) => { setMd(v); onMarkdown?.(v) }} />
}

/** A form that can put its body back to empty, as KBAdminPage's «New article» does. */
function StartOver() {
  const [md, setMd] = useState('')
  return (
    <>
      <RichTextEditor value={md} onChange={setMd} />
      <button type="button" onClick={() => { setMd('') }}>Start over</button>
      <output data-testid="form-body">{md}</output>
    </>
  )
}

/**
 * The Markdown leaves 300 ms after the last edit. On a loaded CI runner that
 * can take longer than the default second of `waitFor`: waits that depend on
 * the pause get more room (they still end as soon as the Markdown arrives).
 */
const PAUSE = { timeout: 10_000 }

const editor = () => screen.getByRole('textbox')
/** The Markdown is loaded asynchronously: wait until the editor shows `text`. */
const shows = (text: string) => waitFor(() => expect(editor()).toHaveTextContent(text))
const button = (title: string) => screen.getByTitle(title)

async function selectAll(user: ReturnType<typeof userEvent.setup>) {
  editor().focus()
  await user.keyboard('{Control>}a{/Control}')
}

/** The Markdown sent after the pause that follows an edit. */
async function markdownSent(onChange: ReturnType<typeof vi.fn>) {
  await waitFor(() => expect(onChange).toHaveBeenCalled(), PAUSE)
  return onChange.mock.calls.at(-1)![0] as string
}

describe('RichTextEditor — showing an article', () => {
  it('shows the Markdown as formatted text', async () => {
    mount([
      '# Reset a password', '', 'Open the **admin** page and click [Reset](https://kb.example.com/reset).', '',
      '- first', '- second', '', '> Only for admins', '', '```sh\npasswd bob\n```', '', '---', '',
      '| Field | Value |', '| --- | --- |', '| user | bob |',
    ].join('\n'))
    await shows('Reset a password')
    expect(screen.getByRole('heading', { level: 1, name: 'Reset a password' })).toBeInTheDocument()
    expect(screen.getByText('admin').tagName).toBe('STRONG')
    expect(screen.getByRole('link', { name: 'Reset' })).toHaveAttribute('href', 'https://kb.example.com/reset')
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['first', 'second'])
    expect(screen.getByText('Only for admins').closest('blockquote')).not.toBeNull()
    expect(screen.getByText('passwd bob').closest('pre')).not.toBeNull()
    expect(screen.getByRole('table')).toHaveTextContent('FieldValueuserbob')
    expect(editor().querySelector('hr')).not.toBeNull()
  })

  it('an empty article shows the placeholder, «Write here...» unless the page gives its own', async () => {
    const { unmount } = mount('')
    await waitFor(() => expect(editor().querySelector('p')).toHaveAttribute('data-placeholder', 'Write here...'))
    unmount()
    mount('', { placeholder: 'Describe the solution' })
    await waitFor(() => expect(editor().querySelector('p')).toHaveAttribute('data-placeholder', 'Describe the solution'))
  })

  it('read-only: no toolbar, and the text cannot be edited', async () => {
    mount('Frozen **text**', { readOnly: true })
    await shows('Frozen text')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(editor()).toHaveAttribute('contenteditable', 'false')
  })

  it('the full toolbar is there when editing', () => {
    mount('x')
    const titles = screen.getAllByRole('button').map((b) => b.getAttribute('title'))
    expect(titles).toEqual([
      'Bold (Ctrl+B)', 'Italic (Ctrl+I)', 'Underline (Ctrl+U)', 'Strikethrough',
      'Heading 1', 'Heading 2', 'Heading 3', 'Bullet list', 'Numbered list',
      'Quote', 'Inline code', 'Code block', 'Insert link', 'Insert image', 'Insert table', 'Horizontal rule',
      'Undo (Ctrl+Z)', 'Redo (Ctrl+Y)',
    ])
  })
})

describe('RichTextEditor — what the toolbar writes', () => {
  it.each([
    ['Bold (Ctrl+B)', '**Some text**'],
    ['Italic (Ctrl+I)', '_Some text_'],
    ['Inline code', '`Some text`'],
    ['Heading 1', '# Some text'],
    ['Heading 2', '## Some text'],
    ['Heading 3', '### Some text'],
    ['Bullet list', '-   Some text'],
    ['Numbered list', '1.  Some text'],
    ['Quote', '> Some text'],
    ['Code block', '```\nSome text\n```'],
  ])('%s gives back %j', async (title, expected) => {
    const { user, onChange } = mount('Some text')
    await shows('Some text')
    await selectAll(user)
    await user.click(button(title))
    expect(await markdownSent(onChange)).toBe(expected)
  })

  it('a quote of several lines keeps every line quoted', async () => {
    const { user, onChange } = mount('> first line\n> second line')
    await shows('first line')
    await selectAll(user)
    await user.click(button('Bold (Ctrl+B)'))
    expect((await markdownSent(onChange)).split('\n').every((l) => l.startsWith('> '))).toBe(true)
  })

  it('a code block keeps its language and its code', async () => {
    const { user, onChange } = mount('```js\nconst a = 1\n```')
    await shows('const a = 1')
    await user.click(button('Horizontal rule'))
    expect(await markdownSent(onChange)).toMatch(/^```js\nconst a = 1\n/)
  })

  /*
   * Found by this test (tour of 23 Sep 2026), fixed: `marked` ended the code
   * of a block with a newline, the editor kept it and the Turndown rule added
   * its own before the closing fence, so every save added an empty line at
   * the end of each code block.
   */
  it('a code block comes back exactly as it was loaded, without a new empty line', async () => {
    const { user, onChange } = mount('```js\nconst a = 1\n```')
    await shows('const a = 1')
    await user.click(button('Horizontal rule'))
    expect(await markdownSent(onChange)).toMatch(/^```js\nconst a = 1\n```/)
  })

  it('a new table is a Markdown table with a header row, three by three', async () => {
    const { user, onChange } = mount('')
    await user.click(button('Insert table'))
    expect(await markdownSent(onChange)).toBe('|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |')
  })

  it('a table cell with a pipe keeps it escaped, so the columns do not shift', async () => {
    const { user, onChange } = mount('| Command | Meaning |\n| --- | --- |\n| a \\| b | pipe |')
    await shows('a | b')
    await user.click(button('Horizontal rule'))
    expect(await markdownSent(onChange)).toContain('| a \\| b | pipe |')
  })

  it('a horizontal rule is written as ---', async () => {
    const { user, onChange } = mount('Above')
    await shows('Above')
    await user.click(button('Horizontal rule'))
    expect(await markdownSent(onChange)).toBe('Above\n\n---')
  })

  it('the Markdown goes out once the author pauses, not at every change', async () => {
    const { user, onChange } = mount('Some text')
    await shows('Some text')
    await selectAll(user)
    // Two edits in a row, with no pause between them (the toolbar acts on mousedown).
    fireEvent.mouseDown(button('Bold (Ctrl+B)'))
    fireEvent.mouseDown(button('Italic (Ctrl+I)'))
    expect(onChange).not.toHaveBeenCalled()
    await waitFor(() => expect(onChange).toHaveBeenCalled(), PAUSE)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0]![0]).toMatch(/^(\*\*_Some text_\*\*|_\*\*Some text\*\*_)$/)
  })

  it('the Markdown goes to the handler of the latest render, not to a stale one', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<RichTextEditor value="Some text" onChange={first} />)
    await shows('Some text')
    await selectAll(user)
    fireEvent.mouseDown(button('Bold (Ctrl+B)'))
    rerender(<RichTextEditor value="Some text" onChange={second} />)
    expect(await markdownSent(second)).toBe('**Some text**')
    expect(first).not.toHaveBeenCalled()
  })

  it('undo takes back the last change and redo brings it back', async () => {
    const { user, onChange } = mount('Some text')
    await shows('Some text')
    await selectAll(user)
    await user.click(button('Bold (Ctrl+B)'))
    expect(await markdownSent(onChange)).toBe('**Some text**')
    onChange.mockClear()
    await user.click(button('Undo (Ctrl+Z)'))
    expect(await markdownSent(onChange)).toBe('Some text')
    onChange.mockClear()
    await user.click(button('Redo (Ctrl+Y)'))
    expect(await markdownSent(onChange)).toBe('**Some text**')
  })

  it('removing all the text gives back an empty article, not an empty paragraph', async () => {
    const { user, onChange } = mount('Some text')
    await shows('Some text')
    await selectAll(user)
    await user.keyboard('{Backspace}')
    expect(await markdownSent(onChange)).toBe('')
  })

  it('the toolbar shows the formatting that is on', async () => {
    const user = userEvent.setup()
    render(<Harness initial="Some text" />)
    await shows('Some text')
    expect(button('Bold (Ctrl+B)')).toHaveStyle({ background: 'transparent' })
    await selectAll(user)
    await user.click(button('Bold (Ctrl+B)'))
    await waitFor(() => expect(button('Bold (Ctrl+B)')).toHaveStyle({ background: 'var(--color-info-tint)' }), PAUSE)
    expect(button('Italic (Ctrl+I)')).toHaveStyle({ background: 'transparent' })
  })

  /*
   * Found by this test (tour of 23 Sep 2026), fixed: the toolbar offered
   * Underline and the Markdown dropped it at the next save (Turndown had no
   * rule for <u>). Markdown has no underline, so it is kept as `<u>…</u>`,
   * which the readers of an article (web and portal) render through
   * `remarkUnderline` — the only HTML they render.
   */
  it('underlined text keeps its underline in the Markdown, as <u>…</u>', async () => {
    const { user, onChange } = mount('Some text')
    await shows('Some text')
    await selectAll(user)
    await user.click(button('Underline (Ctrl+U)'))
    expect(await markdownSent(onChange)).toBe('<u>Some text</u>')
  })

  it('Ctrl+U underlines too', async () => {
    const { user, onChange } = mount('Some text')
    await shows('Some text')
    await selectAll(user)
    await user.keyboard('{Control>}u{/Control}')
    expect(await markdownSent(onChange)).toBe('<u>Some text</u>')
  })

  it('an underline read from the Markdown is shown, and written back unchanged', async () => {
    const { user, onChange } = mount('Keep <u>this</u> in')
    await shows('Keep this in')
    expect(editor().querySelector('u')).toHaveTextContent('this')
    await user.click(button('Horizontal rule'))
    expect(await markdownSent(onChange)).toMatch(/^Keep <u>this<\/u> in\n/)
  })

  /*
   * Found by this test (tour of 23 Sep 2026), fixed: Turndown had no rule for
   * <s>, so the strike the toolbar offers was dropped from the Markdown at the
   * next save. It is written as GFM `~~text~~`, which `marked` reads back.
   */
  it('struck-through text keeps its strike in the Markdown (GFM ~~text~~)', async () => {
    const { user, onChange } = mount('Some text')
    await shows('Some text')
    await selectAll(user)
    await user.click(button('Strikethrough'))
    expect(await markdownSent(onChange)).toBe('~~Some text~~')
  })

  it('a strike read from the Markdown is shown, and written back unchanged', async () => {
    const { user, onChange } = mount('Keep ~~this~~ out')
    await shows('Keep this out')
    expect(editor().querySelector('s')).toHaveTextContent('this')
    await user.click(button('Horizontal rule'))
    expect(await markdownSent(onChange)).toMatch(/^Keep ~~this~~ out\n/)
  })
})

describe('RichTextEditor — links and images', () => {
  it('«Insert link» asks for the address (starting from https://) and links the selected text', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('https://kb.example.com/vpn')
    const { user, onChange } = mount('VPN guide')
    await shows('VPN guide')
    await selectAll(user)
    await user.click(button('Insert link'))
    expect(prompt).toHaveBeenCalledWith('Link URL:', 'https://')
    expect(await markdownSent(onChange)).toBe('[VPN guide](https://kb.example.com/vpn)')
  })

  it('on a link, «Insert link» proposes the current address', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('https://new.example.com')
    const { user, onChange } = mount('[docs](https://old.example.com)')
    await shows('docs')
    await selectAll(user)
    await user.click(button('Insert link'))
    expect(prompt).toHaveBeenCalledWith('Link URL:', 'https://old.example.com')
    expect(await markdownSent(onChange)).toBe('[docs](https://new.example.com)')
  })

  it('cancelling the link prompt changes nothing', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue(null)
    const { user, onChange } = mount('Plain text')
    await shows('Plain text')
    await selectAll(user)
    await user.click(button('Insert link'))
    // The next real edit shows what the document is: no link was added.
    await user.click(button('Bold (Ctrl+B)'))
    expect(await markdownSent(onChange)).toBe('**Plain text**')
  })

  /*
   * Found by this test (tour of 23 Sep 2026), fixed: the code meant an empty
   * address to remove the link, but `if (!url) return` took '' for «cancel»
   * too, so the branch never ran and there was no way to unlink from the
   * toolbar. Cancel (null) still changes nothing: see the test above.
   */
  it('clearing the address in the link prompt removes the link', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('')
    const { user, onChange } = mount('[docs](https://old.example.com)')
    await shows('docs')
    await selectAll(user)
    await user.click(button('Insert link'))
    await user.click(button('Bold (Ctrl+B)'))
    expect(await markdownSent(onChange)).toBe('**docs**')
  })

  /*
   * Found by this test (tour of 23 Sep 2026), fixed: tiptap 3's StarterKit
   * already carries Link (with `openOnClick: true`) and Underline, and the
   * editor added them a second time (tiptap warned «Duplicate extension
   * names»). StarterKit's copy kept its click handler, so clicking a link
   * while writing opened it in a new window despite `openOnClick: false`.
   */
  it('clicking a link while writing places the caret, it does not open the link', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const { user } = mount('See [docs](https://kb.example.com/docs)')
    const link = await screen.findByRole('link', { name: 'docs' })
    // Where the pointer lands: jsdom has no layout to answer this itself.
    ;(document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => link
    await user.click(link)
    expect(open).not.toHaveBeenCalled()
  })

  it('no extension is registered twice (the cause of the defect above)', async () => {
    const warn = vi.spyOn(console, 'warn')
    mount('x')
    await shows('x')
    expect(warn.mock.calls.flat().join('\n')).not.toContain('Duplicate extension names')
  })

  // Tour of 23 Sep 2026: an editor that went away with the focus still inside
  // sent its pending edit 300 ms later — into whatever form the parent showed
  // by then, e.g. the next article.
  it('an edit still waiting for the pause is dropped when the editor goes away', async () => {
    const { user, onChange, unmount } = mount('Some text')
    await shows('Some text')
    await selectAll(user)
    await user.keyboard('Other')
    unmount()
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(onChange).not.toHaveBeenCalled()
  })

  // Tour of 23 Sep 2026: tiptap refuses some addresses, and the prompt closed
  // as if the link had been made.
  it('an address tiptap refuses is said, and no link is made', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('javascript:alert(1)')
    const { user } = mount('Open the portal')
    await shows('Open the portal')
    await selectAll(user)
    await user.click(button('Insert link'))
    expect(toast.error).toHaveBeenCalledWith('This address cannot be used as a link: javascript:alert(1)')
    expect(editor().querySelector('a')).toBeNull()
  })

  it('with the caret in a link and nothing selected, the prompt edits that whole link', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('https://new.example.com')
    const { user, onChange } = mount('See [docs](https://old.example.com) here')
    const link = await screen.findByRole('link', { name: 'docs' })
    editor().focus()
    document.getSelection()!.collapse(link.firstChild!, 2)
    document.dispatchEvent(new Event('selectionchange'))
    await user.click(button('Insert link'))
    expect(prompt).toHaveBeenCalledWith('Link URL:', 'https://old.example.com')
    expect(await markdownSent(onChange)).toBe('See [docs](https://new.example.com) here')
  })

  it('«Insert image» asks for the address and puts the image in the article', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('https://img.example.com/topology.png')
    const { user, onChange } = mount('')
    await user.click(button('Insert image'))
    expect(prompt).toHaveBeenCalledWith('Image URL:')
    expect(await markdownSent(onChange)).toBe('![](https://img.example.com/topology.png)')
  })

  it('cancelling the image prompt inserts nothing', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue(null)
    const { user, onChange } = mount('Text')
    await shows('Text')
    await user.click(button('Insert image'))
    await user.click(button('Horizontal rule'))
    expect(await markdownSent(onChange)).toBe('Text\n\n---')
  })
})

describe('RichTextEditor — a value from outside', () => {
  it('a new value (another article) replaces the content, without echoing it back as an edit', async () => {
    const onChange = vi.fn()
    const { rerender } = render(<RichTextEditor value="First article" onChange={onChange} />)
    await shows('First article')
    rerender(<RichTextEditor value={'## Second article'} onChange={onChange} />)
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Second article' })).toBeInTheDocument())
    expect(editor()).not.toHaveTextContent('First article')
    await act(async () => { await new Promise((r) => { setTimeout(r, 0) }) })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('while the author is writing, a value from outside does not overwrite the text; once they leave, it does', async () => {
    const onChange = vi.fn()
    const { rerender } = render(<RichTextEditor value="Draft being written" onChange={onChange} />)
    await shows('Draft being written')
    editor().focus()
    rerender(<RichTextEditor value="Saved elsewhere" onChange={onChange} />)
    await act(async () => { await new Promise((r) => { setTimeout(r, 0) }) })
    expect(editor()).toHaveTextContent('Draft being written')
    editor().blur()
    rerender(<RichTextEditor value="Reloaded after leaving" onChange={onChange} />)
    await shows('Reloaded after leaving')
  })

  it('the author\'s own edit coming back as the new value does not reset the editor', async () => {
    const user = userEvent.setup()
    const onMarkdown = vi.fn()
    render(<Harness initial="Some text" onMarkdown={onMarkdown} />)
    await shows('Some text')
    await selectAll(user)
    await user.click(button('Bold (Ctrl+B)'))
    await waitFor(() => expect(onMarkdown).toHaveBeenCalledWith('**Some text**'), PAUSE)
    expect(screen.getByText('Some text').tagName).toBe('STRONG')
  })

  /*
   * Found by this test (tour of 23 Sep 2026), fixed: the «nothing changed»
   * check compared the new value with the last value LOADED into the editor,
   * not with what the editor stood for after the author's edits. When the
   * page put that same text back — KBAdminPage does it with «New article»
   * while a new article is being written (the form resets the body to '' and
   * the editor, keyed 'new', stays mounted) — the reset was ignored and the
   * old text stayed on screen, out of step with the form; the next keystroke
   * sent it back into the form.
   */
  it('putting back the text the editor was loaded with resets what the author wrote', async () => {
    const user = userEvent.setup()
    render(<StartOver />)
    await user.click(button('Horizontal rule'))
    await waitFor(() => expect(screen.getByTestId('form-body')).toHaveTextContent('---'), PAUSE)
    await user.click(screen.getByRole('button', { name: 'Start over' }))
    expect(screen.getByTestId('form-body')).toBeEmptyDOMElement()
    await act(async () => { await new Promise((r) => { setTimeout(r, 0) }) })
    expect(editor().querySelector('hr')).toBeNull()
  })

  /** tiptap's `focus()` lands a frame after the toolbar click: no hand is faster than that. */
  const focused = () => waitFor(() => expect(editor()).toHaveFocus())

  it('a reset clicked before the pause is over still resets, and the old text does not come back', async () => {
    const user = userEvent.setup()
    render(<StartOver />)
    await user.click(button('Horizontal rule'))
    await focused()
    // No wait for the pause: leaving the editor sends the edit at once, then the reset replaces it.
    await user.click(screen.getByRole('button', { name: 'Start over' }))
    await act(async () => { await new Promise((r) => { setTimeout(r, 400) }) })
    expect(screen.getByTestId('form-body')).toBeEmptyDOMElement()
    expect(editor().querySelector('hr')).toBeNull()
  })

  it('leaving the editor sends the edit still waiting for the pause at once', async () => {
    const user = userEvent.setup()
    render(<StartOver />)
    await user.click(button('Horizontal rule'))
    await focused()
    expect(screen.getByTestId('form-body')).toBeEmptyDOMElement()
    act(() => { editor().blur() })
    expect(screen.getByTestId('form-body')).toHaveTextContent('---')
  })

  it('closing the editor before the article has loaded does not fail', async () => {
    const consoleError = vi.spyOn(console, 'error')
    const { unmount } = mount('# Closed too early')
    unmount()
    await act(async () => { await new Promise((r) => { setTimeout(r, 0) }) })
    expect(consoleError).not.toHaveBeenCalled()
  })
})
