/**
 * Ogni `$parametro` scritto in una query deve essere passato (giro nel browser
 * del 14 set 2026).
 *
 * Dal vivo: «New dashboard» falliva con «Expected parameter(s): tenantId». La
 * query che collega la dashboard al suo autore aveva preso `{tenant_id: $tenantId}`
 * quando il cliente è entrato su tutti i nodi delle dashboard, ma i parametri
 * no — e nessun test la eseguiva con un driver vero. Neo4j lo scopre solo al
 * primo utente che clicca.
 *
 * Il guardiano legge il codice: per ogni chiamata con il Cypher in un template
 * senza interpolazioni e i parametri in un oggetto letterale senza spread,
 * i `$nomi` del Cypher devono essere chiavi dell'oggetto. Le chiamate costruite
 * dinamicamente restano fuori (e il conteggio minimo sotto dice che il pattern
 * ne vede comunque tante).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const API_SRC = join(import.meta.dirname, '..', '..')
const PACKAGES = join(API_SRC, '..', '..', '..', 'packages')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (['__tests__', 'node_modules', 'dist'].includes(name)) continue
      walk(full, out)
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

const files = [
  ...walk(API_SRC),
  ...readdirSync(PACKAGES).map((p) => join(PACKAGES, p, 'src')).filter((d) => { try { return statSync(d).isDirectory() } catch { return false } }).flatMap((d) => walk(d)),
]

/** `.run(`…`, {…})` e `runQuery/runQueryOne(session, `…`, {…})`. */
const CALL = /(?:\.run|\brunQuery(?:One)?)\(\s*(?:[A-Za-z_][\w.]*(?:\s+as\s+\w+)?\s*,\s*)?`([^`]*)`\s*,\s*\{((?:[^{}]|\{[^{}]*\})*)\}\s*[,)]/g

const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

interface Violation { where: string; missing: string[] }

function scan(): { checked: number; violations: Violation[] } {
  let checked = 0
  const violations: Violation[] = []
  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(CALL)) {
      const cypher = m[1]!
      const obj = stripComments(m[2]!)
      if (cypher.includes('${') || obj.includes('...')) continue
      checked++
      const used = new Set([...cypher.replace(/'[^']*'|"[^"]*"/g, '').replace(/\/\/.*$/gm, '').matchAll(/\$([A-Za-z_]\w*)/g)].map((x) => x[1]!))
      const topLevel = obj.replace(/\{[^{}]*\}/g, '{}').replace(/\[[^\]]*\]/g, '[]').replace(/\([^()]*\)/g, '()')
      const keys = new Set([...topLevel.matchAll(/(?:^|,)\s*([A-Za-z_]\w*)\s*(?=[:,]|$)/g)].map((x) => x[1]!))
      const missing = [...used].filter((u) => !keys.has(u))
      if (missing.length > 0) {
        const line = src.slice(0, m.index).split('\n').length
        violations.push({ where: `${relative(join(API_SRC, '..', '..', '..'), file)}:${line}`, missing })
      }
    }
  }
  return { checked, violations }
}

describe('parametri Cypher', () => {
  const { checked, violations } = scan()

  it('il pattern vede abbastanza query (se crolla, il guardiano non guarda più niente)', () => {
    expect(checked).toBeGreaterThan(300)
  })

  it('ogni $parametro usato è passato', () => {
    expect(violations).toEqual([])
  })
})
