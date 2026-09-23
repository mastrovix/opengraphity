/**
 * AN OUTBOUND CALL THE SSRF GUARD CHECKED DOES NOT FOLLOW REDIRECTS (review of 23 Sep 2026).
 *
 * `assertSafeOutboundUrl` checks the URL a tenant configured. `fetch` follows
 * redirects by default, so a webhook pointed at https://attacker.example/r
 * that answered 307 → http://169.254.169.254/… reached the internal network
 * with the tenant's method, body and headers, and «Test» even returned the
 * internal answer. Every `fetch(` in a file that uses the guard passes
 * `redirect: 'manual'`.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../../..')
const ROOTS = [path.join(REPO, 'apps/api/src'), ...fs.readdirSync(path.join(REPO, 'packages')).map((p) => path.join(REPO, 'packages', p, 'src'))]

function sources(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { if (!['node_modules', '__tests__', 'dist'].includes(entry.name)) sources(full, out) }
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

/** The argument text of every `fetch(` call, brackets balanced. */
function fetchCalls(src: string): string[] {
  const out: string[] = []
  const re = /(?<![\w.])fetch\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    let depth = 0
    let i = m.index + 'fetch'.length
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') { depth--; if (depth === 0) break }
    }
    out.push(src.slice(m.index, i + 1))
  }
  return out
}

describe('outbound calls checked by the SSRF guard', () => {
  it('never follow a redirect', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of sources(root)) {
        const src = fs.readFileSync(file, 'utf8')
        if (!/assertSafeOutboundUrl\(/.test(src)) continue
        for (const call of fetchCalls(src)) {
          if (!/redirect:\s*'manual'/.test(call)) offenders.push(`${path.relative(REPO, file)}: ${call.slice(0, 60)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the guard sees the calls it checks', () => {
    expect(fetchCalls("await fetch(url, { method: 'POST', body: f(x) })")).toEqual(["fetch(url, { method: 'POST', body: f(x) })"])
    expect(fetchCalls('prefetch(url); obj.fetch(url)')).toEqual([])
  })
})
