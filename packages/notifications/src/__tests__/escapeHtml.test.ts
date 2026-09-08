import { describe, it, expect } from 'vitest'
import { escapeHtml } from '../escapeHtml.js'

describe('escapeHtml (D-11 / C-13)', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<script>alert("x") & 'y'</script>`))
      .toBe('&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;')
  })
  it('leaves plain text untouched and stringifies non-strings', () => {
    expect(escapeHtml('Incident INC-42 — DB down')).toBe('Incident INC-42 — DB down')
    expect(escapeHtml(42)).toBe('42')
  })
  it('maps null/undefined to an empty string', () => {
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
  })
  it('neutralises an attribute-breaking payload', () => {
    const out = escapeHtml(`" onmouseover="alert(1)`)
    expect(out).not.toContain('"')
    expect(out).toBe('&quot; onmouseover=&quot;alert(1)')
  })
})
