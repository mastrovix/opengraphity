/**
 * UNDERLINE IN AN ARTICLE (tour of 23 Sep 2026).
 *
 * Markdown has no syntax for underline, so the KB editor saves it as
 * `<u>text</u>` — the one piece of HTML it writes. The readers of an article
 * (web and portal) render Markdown with react-markdown WITHOUT raw HTML, and
 * that is deliberate: an article is written by people, and raw HTML in it
 * would be a way to put anything on the page of whoever reads it. So they
 * printed the tag as text, and the underline the editor offered either showed
 * as «<u>» or was dropped at the next save.
 *
 * This remark plugin turns exactly the pairs `<u>` … `</u>` inside one
 * paragraph (or heading, cell, …) into an underline element, and nothing
 * else: every other HTML — `<b>`, `<script>`, `<u class=…>`, a `<u>` never
 * closed — stays what react-markdown makes of it today.
 */

/** The little of a Markdown syntax tree this plugin reads and writes. */
interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  data?: { hName?: string }
}

/** The tags the KB editor writes around an underline, and the only HTML the readers render. */
export const UNDERLINE_OPEN = '<u>'
export const UNDERLINE_CLOSE = '</u>'

function wrapUnderlines(node: MdNode): void {
  if (!node.children) return
  const out: MdNode[] = []
  let open: MdNode | null = null
  for (const child of node.children) {
    if (child.type === 'html' && child.value === UNDERLINE_OPEN && !open) {
      open = { type: 'underline', data: { hName: 'u' }, children: [] }
      continue
    }
    if (child.type === 'html' && child.value === UNDERLINE_CLOSE && open) {
      out.push(open)
      open = null
      continue
    }
    (open ? open.children! : out).push(child)
  }
  // A `<u>` never closed is not an underline: it goes back as it was.
  if (open) out.push({ type: 'html', value: UNDERLINE_OPEN }, ...open.children!)
  node.children = out
  for (const child of out) wrapUnderlines(child)
}

/** The remark plugin: `remarkPlugins={[remarkGfm, remarkUnderline]}`. */
export function remarkUnderline(): (tree: unknown) => void {
  return (tree) => { wrapUnderlines(tree as MdNode) }
}
