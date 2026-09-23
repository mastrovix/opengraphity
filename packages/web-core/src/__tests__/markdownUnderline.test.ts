/**
 * The underline of an article (tour of 23 Sep 2026): the KB editor saves it
 * as `<u>text</u>`, and the readers render Markdown without raw HTML. The
 * plugin turns exactly the `<u>` … `</u>` pairs into an underline and leaves
 * every other piece of HTML as it was. The trees below are the ones remark
 * builds: inline HTML arrives as separate `html` nodes around the text.
 */
import { describe, it, expect } from 'vitest'
import { remarkUnderline } from '../markdownUnderline.js'

type Node = { type: string; value?: string; children?: Node[]; data?: { hName?: string } }
const text = (value: string): Node => ({ type: 'text', value })
const html = (value: string): Node => ({ type: 'html', value })
const paragraph = (...children: Node[]): Node => ({ type: 'paragraph', children })
const root = (...children: Node[]): Node => ({ type: 'root', children })
const run = (tree: Node): Node => { remarkUnderline()(tree); return tree }

describe('remarkUnderline', () => {
  it('a <u> … </u> pair becomes an underline element around what it encloses', () => {
    const tree = run(root(paragraph(text('a '), html('<u>'), text('b'), { type: 'strong', children: [text('c')] }, html('</u>'), text(' d'))))
    expect(tree.children![0]!.children).toEqual([
      text('a '),
      { type: 'underline', data: { hName: 'u' }, children: [text('b'), { type: 'strong', children: [text('c')] }] },
      text(' d'),
    ])
  })

  it('works at any depth: in a list item, a heading, a table cell', () => {
    const tree = run(root({ type: 'list', children: [{ type: 'listItem', children: [paragraph(html('<u>'), text('x'), html('</u>'))] }] }))
    const item = tree.children![0]!.children![0]!.children![0]!
    expect(item.children).toEqual([{ type: 'underline', data: { hName: 'u' }, children: [text('x')] }])
  })

  it('every other HTML stays as it is: it is not a way to put markup on the reader\'s page', () => {
    const tree = run(root(paragraph(html('<b>'), text('x'), html('</b>'), html('<u class="x">'), text('y'), html('</u>'), html('<script>alert(1)</script>'))))
    expect(tree.children![0]!.children).toEqual([
      html('<b>'), text('x'), html('</b>'), html('<u class="x">'), text('y'), html('</u>'), html('<script>alert(1)</script>'),
    ])
  })

  it('a <u> never closed is not an underline: it goes back as it was', () => {
    const tree = run(root(paragraph(text('a '), html('<u>'), text('b'))))
    expect(tree.children![0]!.children).toEqual([text('a '), html('<u>'), text('b')])
  })

  it('two pairs in a row are two underlines', () => {
    const tree = run(root(paragraph(html('<u>'), text('a'), html('</u>'), text(' and '), html('<u>'), text('b'), html('</u>'))))
    expect(tree.children![0]!.children!.map((n) => n.type)).toEqual(['underline', 'text', 'underline'])
  })
})
