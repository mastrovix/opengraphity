const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Escapes the five HTML-significant characters so user-controlled text
 * (ticket titles, comments, names) can be interpolated into an HTML email
 * body or attribute without becoming markup. `null`/`undefined` → ''.
 * Idempotent-safe: escaping already escaped text double-escapes it, so call
 * it exactly once, at the interpolation point.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch)
}
