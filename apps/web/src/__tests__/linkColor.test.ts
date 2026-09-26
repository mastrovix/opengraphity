/**
 * LINKS ARE SUGAR-PAPER BLUE (26 Sep 2026, the owner: «anche i link in carta
 * da zucchero»).
 *
 * The colour of a link was written page by page — 62 of them in brand blue —
 * so a rule in one place would not reach them. They now read `--color-link`,
 * unstyled anchors get it from `index.css`, and this guard reads every page:
 * a link, or a button drawn as one (no background, no border), in brand blue
 * is a regression.
 *
 * What a user loses if this regresses: links of two colours in the same app,
 * one of them the colour of the primary buttons.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function tsx(dir = SRC, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'test') tsx(p, out); continue }
    if (e.name.endsWith('.tsx') && !e.name.includes('.test.')) out.push(p)
  }
  return out
}

const BRAND = /\bcolor:\s*(?:'var\(--color-brand\)'|'var\(--color-brand-hover\)'|'var\(--accent\)'|colors\.brandHover\b|colors\.brand\b)/

/** The attributes of the opening tag at `start`, following braces (an arrow's `=>` does not end the tag). */
function openingTag(source: string, start: number): string {
  let depth = 0
  for (let j = start + 1; j < source.length; j++) {
    const c = source[j]
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0 && source[j - 1] !== '=') return source.slice(start, j)
  }
  return source.slice(start)
}

/** Lines of the links, and of the buttons drawn as links, whose colour is brand blue. */
export function brandColouredLinks(source: string): number[] {
  const lines: number[] = []
  for (const m of source.matchAll(/<(Link|NavLink|a|button)\b/g)) {
    const tag = openingTag(source, m.index)
    const style = /style=\{\{([\s\S]*)\}\}/.exec(tag)?.[1]
    if (!style || !BRAND.test(style)) continue
    const drawnAsLink = m[1] !== 'button'
      || (/background:\s*'(none|transparent)'/.test(style) && /border:\s*('none'|0\b)/.test(style))
    if (drawnAsLink) lines.push(source.slice(0, m.index).split('\n').length)
  }
  return lines
}

/** Lines of the elements drawn in the link colour and NOT underlined: a muted colour alone does not say «click me». */
export function linksNotUnderlined(source: string): number[] {
  const lines: number[] = []
  for (const m of source.matchAll(/<(Link|NavLink|a|button)\b/g)) {
    const style = /style=\{\{([\s\S]*)\}\}/.exec(openingTag(source, m.index))?.[1]
    if (!style || !style.includes("color: 'var(--color-link)'")) continue
    if (!/textDecoration:\s*'underline'/.test(style)) lines.push(source.slice(0, m.index).split('\n').length)
  }
  return lines
}

/**
 * Links whose style says «no underline» although nothing else marks them: no
 * background, no border, no padding — plain text. A card, a tile, a pill or a
 * menu item carries its own surface and is not one of them.
 */
export function plainLinksNotUnderlined(source: string): number[] {
  const lines: number[] = []
  for (const m of source.matchAll(/<(Link|NavLink|a)\b/g)) {
    const tag = openingTag(source, m.index)
    const style = /style=\{\{([\s\S]*)\}\}/.exec(tag)?.[1]
    if (!style || !/textDecoration:\s*'none'/.test(style) || /className=/.test(tag)) continue
    if (/\b(background|backgroundColor|border|borderBottom|padding):/.test(style)) continue
    lines.push(source.slice(0, m.index).split('\n').length)
  }
  return lines
}

/**
 * Buttons drawn as text (no background, no border) that are not toggles, tabs
 * or list rows: «← Back», «Cancel», «Close», «Mark all as read». They are
 * links to the eye, so they are underlined like links.
 */
export function textButtonsNotUnderlined(source: string): number[] {
  const lines: number[] = []
  for (const m of source.matchAll(/<button\b/g)) {
    const tag = openingTag(source, m.index)
    const style = /style=\{\{([\s\S]*)\}\}/.exec(tag)?.[1]
    if (!style || !/background(Color)?:\s*'(none|transparent)'/.test(style) || !/border:\s*('none'|0\b)/.test(style)) continue
    // Toggles, tabs (their mark is the bottom border), rows and column headers (they inherit the font of their table).
    if (/aria-expanded|role=|className=|aria-label=/.test(tag) || /width:\s*'100%'|flex:\s*1\b|borderBottom:|font:\s*'inherit'/.test(style)) continue
    const bodyStart = m.index + tag.length + 1
    const body = source.slice(bodyStart, source.indexOf('</button>', bodyStart)).replace(/&\w+;/g, '').replace(/<[A-Z]\w*[^>]*\/>/g, '')
    if (!/\{t\(|[A-Za-zÀ-ú]{3,}/.test(body)) continue
    if (!/textDecoration:\s*'underline'/.test(style)) lines.push(source.slice(0, m.index).split('\n').length)
  }
  return lines
}

/** The shared `linkStyle` constants of a page: brand blue, or not underlined. */
export function linkStyleConstantsWrong(source: string): number[] {
  const lines: number[] = []
  for (const m of source.matchAll(/const \w*[lL]inkStyle\w*\s*(?::[^=]+)?=\s*\{([^}]*)\}/g)) {
    if (BRAND.test(m[1]) || /textDecoration:\s*'none'/.test(m[1])) lines.push(source.slice(0, m.index).split('\n').length)
  }
  return lines
}

/**
 * Plain-text links left without underline on purpose (the breadcrumb, chrome
 * like the sidebar, carries a class and is not counted): a task row and an article card whose link is the whole
 * row or card, the pills of the event correlation (the pill is the surface),
 * and RowLink — the name of a table row, which the row itself opens.
 */
const PLAIN_NO_UNDERLINE: Record<string, number> = {
  'pages/MyTasksPage.tsx': 1,
  'pages/events/eventCorrelation.tsx': 2,
  'pages/knowledge-base/KnowledgeBasePage.tsx': 1,
  'components/ui/RowLink.tsx': 1,
}

const everywhere = (scan: (s: string) => number[]) =>
  tsx().flatMap((f) => scan(fs.readFileSync(f, 'utf8')).map((l) => `${path.relative(SRC, f)}:${String(l)}`))

describe('the colour of the links', () => {
  it('the scan sees a brand-blue link, a link-like button, and past an arrow before the style', () => {
    expect(brandColouredLinks(`<Link to="/x" style={{ color: 'var(--color-brand)' }}>x</Link>`)).toEqual([1])
    expect(brandColouredLinks(`<button onClick={() => go()} style={{ background: 'none', border: 'none', color: colors.brand }}>x</button>`)).toEqual([1])
    // A real button (with its background) keeps the brand colour: it is not a link.
    expect(brandColouredLinks(`<button style={{ background: 'var(--color-brand)', color: 'var(--color-brand)' }}>x</button>`)).toEqual([])
    expect(brandColouredLinks(`<Link to="/x" style={{ color: 'var(--color-link)' }}>x</Link>`)).toEqual([])
  })

  it('no link of the app is brand blue', () => {
    const found = tsx().flatMap((f) => brandColouredLinks(fs.readFileSync(f, 'utf8')).map((l) => `${path.relative(SRC, f)}:${String(l)}`))
    expect(found).toEqual([])
  })

  it('every link is underlined too (26 Sep 2026, the owner: «non si capisce che si può cliccare»)', () => {
    expect(linksNotUnderlined(`<Link to="/x" style={{ color: 'var(--color-link)' }}>x</Link>`)).toEqual([1])
    const found = tsx().flatMap((f) => linksNotUnderlined(fs.readFileSync(f, 'utf8')).map((l) => `${path.relative(SRC, f)}:${String(l)}`))
    expect(found).toEqual([])
  })

  it('a plain-text link is underlined, except the few left so on purpose (26 Sep 2026, «controlla a tappeto»)', () => {
    expect(plainLinksNotUnderlined(`<Link to="/x" style={{ color: 'var(--color-slate-dark)', textDecoration: 'none' }}>x</Link>`)).toEqual([1])
    expect(plainLinksNotUnderlined(`<Link to="/x" style={{ padding: 8, border: '1px solid', textDecoration: 'none' }}>card</Link>`)).toEqual([])
    const perFile: Record<string, number> = {}
    for (const at of everywhere(plainLinksNotUnderlined)) { const f = at.slice(0, at.lastIndexOf(':')); perFile[f] = (perFile[f] ?? 0) + 1 }
    expect(perFile).toEqual(PLAIN_NO_UNDERLINE)
  })

  it('a button drawn as text («← Back», «Cancel», «Close») is underlined', () => {
    expect(textButtonsNotUnderlined(`<button type="button" onClick={go} style={{ background: 'none', border: 'none', color: 'var(--color-slate)' }}>{t('common.cancel')}</button>`)).toEqual([1])
    // A toggle, or a × with only an aria-label, is not a link.
    expect(textButtonsNotUnderlined(`<button type="button" aria-expanded={open} style={{ background: 'none', border: 'none' }}>{t('x')}</button>`)).toEqual([])
    expect(textButtonsNotUnderlined(`<button type="button" aria-label="remove" style={{ background: 'none', border: 'none' }}>&times;</button>`)).toEqual([])
    expect(everywhere(textButtonsNotUnderlined)).toEqual([])
  })

  it('the shared linkStyle constants are link blue and underlined', () => {
    expect(linkStyleConstantsWrong(`const linkStyle = { color: colors.brand, textDecoration: 'none', fontWeight: 500 } as const`)).toEqual([1])
    expect(everywhere(linkStyleConstantsWrong)).toEqual([])
  })

  it('an anchor with no colour of its own gets the link colour from the base layer', () => {
    const css = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8')
    expect(css).toMatch(/--color-link:\s*#[0-9a-f]{6};/i)
    expect(css).toMatch(/@layer base\s*\{[\s\S]*?\ba \{ color: var\(--color-link\); text-decoration: underline;/)
  })
})
