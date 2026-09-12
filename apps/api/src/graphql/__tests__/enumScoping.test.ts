/**
 * Lint statico (B1-3): nessun `USES_ENUM` letto senza ambito.
 *
 * Il difetto A-2/C-6 non era un errore di ragionamento in un posto: era la
 * stessa riga copiata in sette. `OPTIONAL MATCH (f)-[:USES_ENUM]->(e)` senza
 * filtro di tenant, e siccome i campi spediti col prodotto vivono su nodi
 * CONDIVISI, quel legame portava i vocabolari del PRIMO cliente che li aveva
 * agganciati in tutti gli altri (dal vivo: 30 campi verso i vocabolari di
 * c-one). Una regola meccanica è l'unico modo per non riaprire il buco alla
 * prossima query.
 *
 * Euristica: ogni riga che porta un `MATCH` (anche `OPTIONAL MATCH`) e
 * attraversa `USES_ENUM` deve avere `tenant_id` sulla riga stessa o entro
 * `LOOKAHEAD` righe (è lì che sta `enumScopeClause(...)`, che si interpola come
 * `WHERE e.tenant_id IN [$tenantId, 'system']`). Un caso legittimo si marca con
 * `// tenant-ok:` sulla riga precedente o su quella stessa, con la motivazione.
 *
 * Perimetro: tutta l'API più `packages/schema-generator` (che genera lo schema
 * dal metamodello e legge gli stessi legami). Fuori: `src/scripts/` — come per
 * `tenantScoping.test.ts`, sono strumenti da riga di comando con guardie
 * proprie (`--tenant` obbligatorio) e nessuno serve richieste di clienti; e i
 * test.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here   = dirname(fileURLToPath(import.meta.url))
const apiSrc = join(here, '../..')
const repoRoot = join(here, '../../../../..')
const GENERATOR_SRC = join(repoRoot, 'packages/schema-generator/src')

/** Quante righe dopo il MATCH possono portare il filtro. */
export const LOOKAHEAD = 3

const EXCLUDED_DIRS = new Set(['__tests__', 'scripts', 'node_modules', 'dist'])

function listFiles(root: string): string[] {
  const out: string[] = []
  for (const f of readdirSync(root)) {
    const child = join(root, f)
    if (statSync(child).isDirectory()) {
      if (!EXCLUDED_DIRS.has(f)) out.push(...listFiles(child))
    } else if (f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts')) {
      out.push(child)
    }
  }
  return out
}

interface Offender { file: string; line: number; text: string }

/** Riga di commento (JSDoc o `//`): parla di USES_ENUM, non lo interroga. */
function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

export function scanEnumScope(content: string, displayName: string): Offender[] {
  const lines = content.split('\n')
  const out: Offender[] = []
  lines.forEach((line, i) => {
    if (!line.includes('USES_ENUM') || !line.includes('MATCH') || isComment(line)) return
    const window = lines.slice(i, i + 1 + LOOKAHEAD).join('\n')
    if (window.includes('tenant_id')) return
    // `enumScopeClause('e')` si interpola in `WHERE e.tenant_id IN […]`: il
    // nome della funzione conta come filtro anche prima dell'interpolazione.
    if (window.includes('enumScopeClause')) return
    if (line.includes('tenant-ok') || (lines[i - 1] ?? '').includes('tenant-ok')) return
    out.push({ file: displayName, line: i + 1, text: line.trim() })
  })
  return out
}

const scan = (file: string, base: string) => scanEnumScope(readFileSync(file, 'utf8'), relative(base, file))

describe('USES_ENUM sempre con ambito di tenant', () => {
  it('l\'euristica accetta filtro/clausola/marcatore e segnala il resto', () => {
    const sample = [
      "OPTIONAL MATCH (f)-[:USES_ENUM]->(e:EnumTypeDefinition)",        // ok: riga dopo
      "  WHERE e.tenant_id IN [$tenantId, 'system']",
      "OPTIONAL MATCH (f)-[:USES_ENUM]->(x:EnumTypeDefinition)",        // ok: nucleo interpolato
      "  ${enumScopeClause('x')}",
      "// tenant-ok: qui il vocabolario lo giudica assertEnumLinkable",
      "MATCH (f)-[:USES_ENUM]->(y:EnumTypeDefinition)",                 // ok: marcatore motivato
      " * Tutti i siti facevano MATCH (f)-[:USES_ENUM]->(e) senza filtro",  // ok: commento
      "OPTIONAL MATCH (f)-[:USES_ENUM]->(z:EnumTypeDefinition)",        // VIOLAZIONE
      "RETURN z.values AS values",
      "MERGE (f)-[:USES_ENUM]->(e)",                                    // non è una lettura
    ].join('\n')
    expect(scanEnumScope(sample, 'sample.ts')).toEqual([
      { file: 'sample.ts', line: 8, text: 'OPTIONAL MATCH (f)-[:USES_ENUM]->(z:EnumTypeDefinition)' },
    ])
  })

  it('il filtro oltre la finestra non basta (la clausola va SUBITO dopo il MATCH)', () => {
    const far = [
      "OPTIONAL MATCH (f)-[:USES_ENUM]->(e:EnumTypeDefinition)",
      "RETURN 1", "RETURN 2", "RETURN 3",
      "WHERE e.tenant_id = $tenantId",
    ].join('\n')
    expect(scanEnumScope(far, 'far.ts')).toHaveLength(1)
  })

  const apiFiles = listFiles(apiSrc)

  it('perimetro non vuoto', () => {
    expect(apiFiles.length).toBeGreaterThan(100)
    expect(existsSync(GENERATOR_SRC)).toBe(true)
  })

  for (const f of apiFiles) {
    it(`api/${relative(apiSrc, f)}`, () => {
      expect(scan(f, apiSrc).map((o) => `${o.file}:${o.line}  ${o.text}`)).toEqual([])
    })
  }

  for (const f of listFiles(GENERATOR_SRC)) {
    it(`schema-generator/${relative(GENERATOR_SRC, f)}`, () => {
      expect(scan(f, GENERATOR_SRC).map((o) => `${o.file}:${o.line}  ${o.text}`)).toEqual([])
    })
  }
})
