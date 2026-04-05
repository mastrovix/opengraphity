import { useEffect, useRef, useCallback } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import Placeholder from '@tiptap/extension-placeholder'
import Underline from '@tiptap/extension-underline'
import { createLowlight, common } from 'lowlight'
import TurndownService from 'turndown'
import { marked } from 'marked'
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  Heading1, Heading2, Heading3,
  List, ListOrdered, Quote, Code, Square,
  LinkIcon, ImageIcon, TableIcon, Minus, Undo, Redo,
} from 'lucide-react'

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function htmlToMarkdown(html: string): string {
  if (!html || html === '<p></p>') return ''
  return td.turndown(html).trim()
}

async function markdownToHtml(md: string): Promise<string> {
  if (!md) return ''
  return await marked(md, { gfm: true, breaks: false }) as string
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
        background:  active ? '#e0f2fe' : 'transparent',
        color:       active ? '#0369a1' : '#475569',
        flexShrink:  0,
      }}
    >
      {children}
    </button>
  )
}

function Sep() {
  return <div style={{ width: 1, height: 20, background: '#e2e8f0', margin: '0 4px', flexShrink: 0 }} />
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
  placeholder = 'Scrivi qui...',
  minHeight   = '300px',
  readOnly    = false,
}: RichTextEditorProps) {
  const debounceRef    = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Tracks the last markdown value we pushed into the editor.
  // null = never set (component just mounted). Compared against `value` to
  // detect external changes while skipping updates when the user is typing.
  const lastSetValue   = useRef<string | null>(null)
  const latestOnChange = useRef(onChange)
  latestOnChange.current = onChange

  const handleUpdate = useCallback((html: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      latestOnChange.current(htmlToMarkdown(html))
    }, 300)
  }, [])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      Underline,
      Link.configure({ openOnClick: false, HTMLAttributes: { rel: 'noopener noreferrer' } }),
      Image,
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      CodeBlockLowlight.configure({ lowlight }),
      Placeholder.configure({ placeholder }),
    ],
    editable: !readOnly,
    onUpdate: ({ editor: e }) => handleUpdate(e.getHTML()),
  })

  // Sync external `value` (Markdown) into the editor.
  // Rules:
  //  - Always run when `value` changes and editor is ready.
  //  - Skip if we already set this exact value (avoids echo from onChange).
  //  - Skip if the editor has focus (user is typing — don't clobber their work).
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    if (value === lastSetValue.current) return   // nothing changed
    if (lastSetValue.current !== null && editor.isFocused) return  // user is typing

    void markdownToHtml(value).then((html) => {
      if (editor.isDestroyed) return
      lastSetValue.current = value
      editor.commands.setContent(html, { emitUpdate: false })
    })
  }, [editor, value])

  // ── Toolbar actions ───────────────────────────────────────────────────────

  function insertLink() {
    if (!editor) return
    const prev = editor.getAttributes('link')['href'] as string | undefined
    const url  = window.prompt('URL del link:', prev ?? 'https://')
    if (!url) return
    if (url === '') {
      editor.chain().focus().unsetLink().run()
    } else {
      editor.chain().focus().setLink({ href: url }).run()
    }
  }

  function insertImage() {
    if (!editor) return
    const url = window.prompt('URL immagine:')
    if (url) editor.chain().focus().setImage({ src: url }).run()
  }

  function insertTable() {
    if (!editor) return
    editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
  }

  if (!editor) return null

  return (
    <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
      {/* ── Toolbar ── */}
      {!readOnly && (
        <div style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', padding: '6px 8px', display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'center' }}>
          {/* Text formatting */}
          <Btn onClick={() => editor.chain().focus().toggleBold().run()}          active={editor.isActive('bold')}          title="Grassetto (Ctrl+B)"><Bold size={14} /></Btn>
          <Btn onClick={() => editor.chain().focus().toggleItalic().run()}        active={editor.isActive('italic')}        title="Corsivo (Ctrl+I)"><Italic size={14} /></Btn>
          <Btn onClick={() => editor.chain().focus().toggleUnderline().run()}     active={editor.isActive('underline')}     title="Sottolineato (Ctrl+U)"><UnderlineIcon size={14} /></Btn>
          <Btn onClick={() => editor.chain().focus().toggleStrike().run()}        active={editor.isActive('strike')}        title="Barrato"><Strikethrough size={14} /></Btn>

          <Sep />

          {/* Headings */}
          <Btn onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} active={editor.isActive('heading', { level: 1 })} title="Titolo 1"><Heading1 size={14} /></Btn>
          <Btn onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive('heading', { level: 2 })} title="Titolo 2"><Heading2 size={14} /></Btn>
          <Btn onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={editor.isActive('heading', { level: 3 })} title="Titolo 3"><Heading3 size={14} /></Btn>

          <Sep />

          {/* Lists */}
          <Btn onClick={() => editor.chain().focus().toggleBulletList().run()}    active={editor.isActive('bulletList')}    title="Elenco puntato"><List size={14} /></Btn>
          <Btn onClick={() => editor.chain().focus().toggleOrderedList().run()}   active={editor.isActive('orderedList')}   title="Elenco numerato"><ListOrdered size={14} /></Btn>

          <Sep />

          {/* Block elements */}
          <Btn onClick={() => editor.chain().focus().toggleBlockquote().run()}    active={editor.isActive('blockquote')}    title="Citazione"><Quote size={14} /></Btn>
          <Btn onClick={() => editor.chain().focus().toggleCode().run()}          active={editor.isActive('code')}          title="Codice inline"><Code size={14} /></Btn>
          <Btn onClick={() => editor.chain().focus().toggleCodeBlock().run()}     active={editor.isActive('codeBlock')}     title="Blocco codice"><Square size={14} /></Btn>

          <Sep />

          {/* Insert */}
          <Btn onClick={insertLink}   active={editor.isActive('link')}   title="Inserisci link"><LinkIcon size={14} /></Btn>
          <Btn onClick={insertImage}  active={false}                     title="Inserisci immagine"><ImageIcon size={14} /></Btn>
          <Btn onClick={insertTable}  active={editor.isActive('table')}  title="Inserisci tabella"><TableIcon size={14} /></Btn>
          <Btn onClick={() => editor.chain().focus().setHorizontalRule().run()} active={false} title="Linea orizzontale"><Minus size={14} /></Btn>

          <Sep />

          {/* History */}
          <Btn onClick={() => editor.chain().focus().undo().run()} active={false} title="Annulla (Ctrl+Z)"><Undo size={14} /></Btn>
          <Btn onClick={() => editor.chain().focus().redo().run()} active={false} title="Ripristina (Ctrl+Y)"><Redo size={14} /></Btn>
        </div>
      )}

      {/* ── Editor area ── */}
      <style>{`
        .tiptap-editor .ProseMirror {
          min-height: ${minHeight};
          padding: 16px;
          outline: none;
          font-size: 14px;
          font-family: system-ui, -apple-system, sans-serif;
          color: #1a2332;
          line-height: 1.6;
        }
        .tiptap-editor .ProseMirror:focus {
          outline: none;
        }
        .tiptap-editor .ProseMirror > * + * { margin-top: 0.75em; }
        .tiptap-editor .ProseMirror h1 { font-size: 24px; font-weight: 700; color: #0f172a; }
        .tiptap-editor .ProseMirror h2 { font-size: 20px; font-weight: 600; color: #0f172a; }
        .tiptap-editor .ProseMirror h3 { font-size: 16px; font-weight: 600; color: #0f172a; }
        .tiptap-editor .ProseMirror a { color: #0ea5e9; text-decoration: underline; }
        .tiptap-editor .ProseMirror code { background: #f1f5f9; font-family: monospace; font-size: 13px; padding: 2px 4px; border-radius: 3px; }
        .tiptap-editor .ProseMirror pre { background: #f1f5f9; padding: 12px; border-radius: 6px; overflow-x: auto; }
        .tiptap-editor .ProseMirror pre code { background: none; padding: 0; font-size: 13px; }
        .tiptap-editor .ProseMirror blockquote { border-left: 3px solid #0ea5e9; padding-left: 12px; color: #64748b; font-style: italic; margin: 0; }
        .tiptap-editor .ProseMirror ul { list-style: disc; padding-left: 20px; }
        .tiptap-editor .ProseMirror ol { list-style: decimal; padding-left: 20px; }
        .tiptap-editor .ProseMirror li { margin-top: 0.25em; }
        .tiptap-editor .ProseMirror img { max-width: 100%; border-radius: 4px; }
        .tiptap-editor .ProseMirror hr { border: none; border-top: 1px solid #e2e8f0; margin: 1em 0; }
        .tiptap-editor .ProseMirror table { border-collapse: collapse; width: 100%; }
        .tiptap-editor .ProseMirror th, .tiptap-editor .ProseMirror td { border: 1px solid #e2e8f0; padding: 6px 10px; font-size: 13px; }
        .tiptap-editor .ProseMirror th { background: #f8fafc; font-weight: 600; }
        .tiptap-editor .ProseMirror p.is-editor-empty:first-child::before { content: attr(data-placeholder); color: #94a3b8; pointer-events: none; float: left; height: 0; }
      `}</style>
      <div className="tiptap-editor">
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}
