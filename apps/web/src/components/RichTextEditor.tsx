import { useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import Placeholder from '@tiptap/extension-placeholder'
import { createLowlight, common } from 'lowlight'
import TurndownService from 'turndown'
import { Marked } from 'marked'
import { toast } from 'sonner'
import { UNDERLINE_OPEN, UNDERLINE_CLOSE } from '@opengraphity/web-core'
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  Heading1, Heading2, Heading3,
  List, ListOrdered, Quote, Code, Square,
  LinkIcon, ImageIcon, TableIcon, Minus, Undo, Redo,
} from 'lucide-react'
import { colors, palette } from '@/lib/tokens'

// ── lowlight instance ────────────────────────────────────────────────────────

const lowlight = createLowlight(common)

// ── Turndown (HTML → Markdown) ───────────────────────────────────────────────

const td = new TurndownService({
  headingStyle:   'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
})

// Tables
td.addRule('table', {
  filter: ['table'],
  replacement(_content, node) {
    const rows = Array.from((node as HTMLElement).querySelectorAll('tr'))
    if (!rows.length) return ''
    const toRow = (tr: Element, isHeader: boolean) =>
      '| ' + Array.from(tr.querySelectorAll('th,td')).map((c) => (c.textContent ?? '').trim().replace(/\|/g, '\\|')).join(' | ') + ' |'
        + (isHeader ? '\n|' + Array.from(tr.querySelectorAll('th,td')).map(() => ' --- |').join('') : '')
    const [head, ...body] = rows
    return '\n\n' + toRow(head, true) + '\n' + body.map((r) => toRow(r, false)).join('\n') + '\n\n'
  },
})

// Code blocks — TipTap wraps them in <pre><code>
td.addRule('codeBlock', {
  filter(node) {
    return node.nodeName === 'PRE' && node.firstChild?.nodeName === 'CODE'
  },
  replacement(_content, node) {
    const code  = node.firstChild as HTMLElement
    const lang  = (code.className || '').replace(/^language-/, '')
    const text  = code.textContent ?? ''
    return '\n\n```' + lang + '\n' + text + '\n```\n\n'
  },
})

// Horizontal rule
td.addRule('hr', {
  filter: ['hr'],
  replacement: () => '\n\n---\n\n',
})

// Blockquote
td.addRule('blockquote', {
  filter: ['blockquote'],
  replacement(_content, node) {
    const text = (node as HTMLElement).textContent ?? ''
    return '\n\n' + text.trim().split('\n').map((l) => '> ' + l).join('\n') + '\n\n'
  },
})

// Strikethrough — tiptap writes it as <s>, the Markdown as GFM `~~text~~`,
// which `marked` reads back as a strike. Without this rule Turndown kept only
// the text, and the strike the toolbar offers was gone at the next save
// (found by the tests, tour of 23 Sep 2026).
td.addRule('strikethrough', {
  filter: ['s'],
  replacement: (content) => '~~' + content + '~~',
})

// Underline — Markdown has no syntax for it, so it is kept as `<u>text</u>`,
// the one piece of HTML the editor writes: `marked` passes it through when the
// article is loaded again, and the readers (web and portal) render exactly
// that pair through `remarkUnderline` from web-core, while any other HTML stays
// text. Without this rule the underline the toolbar offers was dropped at the
// next save (found by the tests, tour of 23 Sep 2026).
td.addRule('underline', {
  filter: ['u'],
  replacement: (content) => UNDERLINE_OPEN + content + UNDERLINE_CLOSE,
})

// ── Markdown → HTML ───────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/*
 * The code of a block goes into the editor exactly as it is written between
 * the fences. `marked`'s own renderer ends it with a newline; the editor kept
 * it (showing an empty last line) and the Turndown rule above writes its own
 * before the closing fence, so every save added an empty line at the end of
 * each code block (found by the tests, tour of 23 Sep 2026). The rest is
 * `marked`'s renderer: the first word of the info string is the language.
 */
const markdown = new Marked({
  gfm:    true,
  breaks: false,
  renderer: {
    code({ text, lang, escaped }) {
      const language = (lang ?? '').match(/^\S*/)?.[0]
      const code     = escaped ? text : escapeHtml(text)
      return language
        ? `<pre><code class="language-${escapeHtml(language)}">${code}</code></pre>\n`
        : `<pre><code>${code}</code></pre>\n`
    },
  },
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function htmlToMarkdown(html: string): string {
  if (!html || html === '<p></p>') return ''
  return td.turndown(html).trim()
}

async function markdownToHtml(md: string): Promise<string> {
  if (!md) return ''
  return await markdown.parse(md)
}

// ── Toolbar actions ───────────────────────────────────────────────────────────

function insertLink(editor: Editor, t: TFunction) {
  const prev = editor.getAttributes('link')['href'] as string | undefined
  const url  = window.prompt(t('richText.linkPrompt'), prev ?? 'https://')
  // null is «Cancel». An empty address removes the link: `if (!url) return`
  // took it for a cancel too, so the link could not be removed from the
  // toolbar (found by the tests, tour of 23 Sep 2026). Either acts on the
  // whole link the caret is in, the one whose address the prompt proposed.
  if (url === null) return
  const href = url.trim()
  if (href === '') {
    editor.chain().focus().extendMarkRange('link').unsetLink().run()
  } else if (!editor.chain().focus().extendMarkRange('link').setLink({ href }).run()) {
    // tiptap refuses some addresses (javascript:, file:, …): say so, the text stays as it was.
    toast.error(t('richText.linkRefused', { href }))
  }
}

function insertImage(editor: Editor, t: TFunction) {
  const url = window.prompt(t('richText.imagePrompt'))
  if (url) editor.chain().focus().setImage({ src: url }).run()
}

function insertTable(editor: Editor) {
  editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
}

// ── Toolbar button ────────────────────────────────────────────────────────────

function Btn({
  onClick,
  active = false,
  title,
  children,
}: {
  onClick: () => void
  active?: boolean
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => { e.preventDefault(); onClick() }}
      title={title}
      style={{
        display:     'inline-flex',
        alignItems:  'center',
        justifyContent: 'center',
        width:       28,
        height:      28,
        borderRadius: 4,
        border:      'none',
        cursor:      'pointer',
        background:  active ? palette.info.tint : 'transparent',
        color:       active ? palette.info.text : palette.neutral.textStrong,
        flexShrink:  0,
      }}
    >
      {children}
    </button>
  )
}

function Sep() {
  return <div style={{ width: 1, height: 20, background: colors.border, margin: '0 4px', flexShrink: 0 }} />
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface RichTextEditorProps {
  value:        string
  onChange:     (markdown: string) => void
  placeholder?: string
  minHeight?:   string
  readOnly?:    boolean
}

// ── Component ─────────────────────────────────────────────────────────────────

export function RichTextEditor({
  value,
  onChange,
  placeholder,
  minHeight   = '300px',
  readOnly    = false,
}: RichTextEditorProps) {
  const { t } = useTranslation()
  const effectivePlaceholder = placeholder ?? t('common.writeHere')
  const debounceRef    = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The Markdown the editor's content stands for: the value last loaded into
  // it, or the Markdown it last sent out. null = nothing yet (just mounted).
  // A `value` equal to it is the editor's own text coming back: nothing to
  // load. It used to track only what was LOADED, so a parent putting back the
  // loaded text after the author's edits (KBAdminPage «New article» while a
  // new article is being written) looked like «nothing changed» and was
  // ignored (found by the tests, tour of 23 Sep 2026).
  const shownMarkdown  = useRef<string | null>(null)
  const latestOnChange = useRef(onChange)
  latestOnChange.current = onChange

  const emit = useCallback((html: string) => {
    const md = htmlToMarkdown(html)
    shownMarkdown.current = md
    latestOnChange.current(md)
  }, [])

  const handleUpdate = useCallback((html: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null
      emit(html)
    }, 300)
  }, [emit])

  // An editor that goes away without losing the focus first (keyboard
  // navigation) drops the edit still waiting for the pause: sent later, it
  // would land in whatever form the parent shows by then — another article.
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
  }, [])

  const editor = useEditor({
    extensions: [
      // tiptap 3's StarterKit already carries Link and Underline. Link is
      // added below with its own options, so StarterKit's copy is off: with
      // both registered, StarterKit's kept its click handler and opened a
      // link in a new window at every click while writing (found by the
      // tests, tour of 23 Sep 2026). Underline is StarterKit's own.
      StarterKit.configure({ codeBlock: false, link: false }),
      Link.configure({ openOnClick: false, HTMLAttributes: { rel: 'noopener noreferrer' } }),
      Image,
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      CodeBlockLowlight.configure({ lowlight }),
      Placeholder.configure({ placeholder: effectivePlaceholder }),
    ],
    editable: !readOnly,
    onUpdate: ({ editor: e }) => handleUpdate(e.getHTML()),
    // Leaving the editor sends an edit still waiting for the pause at once:
    // the button clicked next (Save, «New article», another article) must
    // find the form in step with what is on screen.
    onBlur: ({ editor: e }) => {
      if (!debounceRef.current) return
      clearTimeout(debounceRef.current)
      debounceRef.current = null
      emit(e.getHTML())
    },
  })

  // Sync external `value` (Markdown) into the editor.
  // Rules:
  //  - Always run when `value` changes and editor is ready.
  //  - Skip if the editor already stands for this value (its own edit coming back).
  //  - Skip if the editor has focus (user is typing — don't clobber their work).
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    if (value === shownMarkdown.current) return   // nothing changed
    if (shownMarkdown.current !== null && editor.isFocused) return  // user is typing

    // The new value replaces the text: an edit still waiting for the pause
    // belongs to the text going away, and must not carry it back into the form.
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    void markdownToHtml(value).then((html) => {
      if (editor.isDestroyed) return
      shownMarkdown.current = value
      editor.commands.setContent(html, { emitUpdate: false })
    })
  }, [editor, value])

  if (!editor) return null

  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: 8, overflow: 'hidden', background: colors.white }}>
      {/* ── Toolbar ── */}
      {!readOnly && (
        <div style={{ background: 'var(--color-slate-bg)', borderBottom: `1px solid ${colors.border}`, padding: '6px 8px', display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'center' }}>
          {/* Text formatting: each one is kept by the Markdown (underline as <u>…</u>, see the Turndown rules). */}
          <Btn onClick={() => editor.chain().focus().toggleBold().run()}          active={editor.isActive('bold')}          title={t('richText.bold')}><Bold size={14} /></Btn>
          <Btn onClick={() => editor.chain().focus().toggleItalic().run()}        active={editor.isActive('italic')}        title={t('richText.italic')}><Italic size={14} /></Btn>
          <Btn onClick={() => editor.chain().focus().toggleUnderline().run()}     active={editor.isActive('underline')}     title={t('richText.underline')}><UnderlineIcon size={14} /></Btn>
          <Btn onClick={() => editor.chain().focus().toggleStrike().run()}        active={editor.isActive('strike')}        title={t('richText.strike')}><Strikethrough size={14} /></Btn>

          <Sep />

          {/* Headings */}
          <Btn onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} active={editor.isActive('heading', { level: 1 })} title={t('richText.h1')}><Heading1 size={14} /></Btn>
          <Btn onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive('heading', { level: 2 })} title={t('richText.h2')}><Heading2 size={14} /></Btn>
          <Btn onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={editor.isActive('heading', { level: 3 })} title={t('richText.h3')}><Heading3 size={14} /></Btn>

          <Sep />

          {/* Lists */}
          <Btn onClick={() => editor.chain().focus().toggleBulletList().run()}    active={editor.isActive('bulletList')}    title={t('richText.bulletList')}><List size={14} /></Btn>
          <Btn onClick={() => editor.chain().focus().toggleOrderedList().run()}   active={editor.isActive('orderedList')}   title={t('richText.orderedList')}><ListOrdered size={14} /></Btn>

          <Sep />

          {/* Block elements */}
          <Btn onClick={() => editor.chain().focus().toggleBlockquote().run()}    active={editor.isActive('blockquote')}    title={t('richText.blockquote')}><Quote size={14} /></Btn>
          <Btn onClick={() => editor.chain().focus().toggleCode().run()}          active={editor.isActive('code')}          title={t('richText.inlineCode')}><Code size={14} /></Btn>
          <Btn onClick={() => editor.chain().focus().toggleCodeBlock().run()}     active={editor.isActive('codeBlock')}     title={t('richText.codeBlock')}><Square size={14} /></Btn>

          <Sep />

          {/* Insert */}
          <Btn onClick={() => insertLink(editor, t)}   active={editor.isActive('link')}   title={t('richText.insertLink')}><LinkIcon size={14} /></Btn>
          <Btn onClick={() => insertImage(editor, t)}  active={false}                     title={t('richText.insertImage')}><ImageIcon size={14} /></Btn>
          <Btn onClick={() => insertTable(editor)}  active={editor.isActive('table')}  title={t('richText.insertTable')}><TableIcon size={14} /></Btn>
          <Btn onClick={() => editor.chain().focus().setHorizontalRule().run()} active={false} title={t('richText.horizontalRule')}><Minus size={14} /></Btn>

          <Sep />

          {/* History */}
          <Btn onClick={() => editor.chain().focus().undo().run()} active={false} title={t('richText.undo')}><Undo size={14} /></Btn>
          <Btn onClick={() => editor.chain().focus().redo().run()} active={false} title={t('richText.redo')}><Redo size={14} /></Btn>
        </div>
      )}

      {/* ── Editor area ── */}
      <style>{`
        .tiptap-editor .ProseMirror {
          min-height: ${minHeight};
          padding: 16px;
          outline: none;
          font-size: 14px;
          font-family: var(--font-sans);
          color: var(--color-slate-dark);
          line-height: 1.6;
        }
        .tiptap-editor .ProseMirror:focus {
          outline: none;
        }
        .tiptap-editor .ProseMirror > * + * { margin-top: 0.75em; }
        .tiptap-editor .ProseMirror h1 { font-size: 24px; font-weight: 700; color: var(--color-slate-dark); }
        .tiptap-editor .ProseMirror h2 { font-size: 20px; font-weight: 600; color: var(--color-slate-dark); }
        .tiptap-editor .ProseMirror h3 { font-size: 16px; font-weight: 600; color: var(--color-slate-dark); }
        .tiptap-editor .ProseMirror a { color: var(--color-brand); text-decoration: underline; }
        .tiptap-editor .ProseMirror code { background: var(--color-slate-bg); font-family: var(--font-mono); font-size: 13px; padding: 2px 4px; border-radius: 3px; }
        .tiptap-editor .ProseMirror pre { background: var(--color-slate-bg); padding: 12px; border-radius: 6px; overflow-x: auto; }
        .tiptap-editor .ProseMirror pre code { background: none; padding: 0; font-size: 13px; }
        .tiptap-editor .ProseMirror blockquote { border-left: 3px solid var(--color-brand); padding-left: 12px; color: var(--color-slate); font-style: italic; margin: 0; }
        .tiptap-editor .ProseMirror ul { list-style: disc; padding-left: 20px; }
        .tiptap-editor .ProseMirror ol { list-style: decimal; padding-left: 20px; }
        .tiptap-editor .ProseMirror li { margin-top: 0.25em; }
        .tiptap-editor .ProseMirror img { max-width: 100%; border-radius: 4px; }
        .tiptap-editor .ProseMirror hr { border: none; border-top: 1px solid var(--color-border); margin: 1em 0; }
        .tiptap-editor .ProseMirror table { border-collapse: collapse; width: 100%; }
        .tiptap-editor .ProseMirror th, .tiptap-editor .ProseMirror td { border: 1px solid var(--color-border); padding: 6px 10px; font-size: 13px; }
        .tiptap-editor .ProseMirror th { background: var(--color-surface-1); font-weight: 600; }
        .tiptap-editor .ProseMirror p.is-editor-empty:first-child::before { content: attr(data-placeholder); color: var(--color-slate-light); pointer-events: none; float: left; height: 0; }
      `}</style>
      <div className="tiptap-editor">
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}
