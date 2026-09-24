/**
 * GUARDIAN: A PROCESS THAT READS THE TENANT SCHEMA HAS REGISTERED IT (wave 7 · C1/C2).
 *
 * lib/tenantSchema.ts is how lib and services reach the tenant's GraphQL
 * schema without importing graphql/ (the layering rule in eslint.config.mjs):
 * graphql/schemaCache.ts registers itself when it is loaded. A process that
 * reaches a module reading the schema and never loads schemaCache fails at
 * the first custom field — "No tenant GraphQL schema in this process". It
 * happened on the first run of the integration suite, whose preparation
 * drives the demo generator outside the server.
 *
 * Every entry point — the server, the workers, the commands in scripts/, the
 * integration suite — is followed through its imports (static and import())
 * down to the modules: if it reaches lib/tenantSchema.ts it must reach
 * graphql/schemaCache.ts too.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY = join(SRC, 'lib', 'tenantSchema.ts')
const REGISTRAR = join(SRC, 'graphql', 'schemaCache.ts')

// One statement at a time, `import type` left out: a type does not load a module.
const STATIC = /^(import|export)\b(?:(?!^(?:import|export)\b)[\s\S])*?\bfrom\s+['"](\.[^'"]+)['"]|^import\s+['"](\.[^'"]+)['"]/gm
const DYNAMIC = /import\(\s*['"](\.[^'"]+)['"]\s*\)/g

function resolveSpec(from: string, spec: string): string | null {
  const base = normalize(join(dirname(from), spec)).replace(/\.js$/, '')
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) if (existsSync(candidate)) return candidate
  return null
}

const depsCache = new Map<string, string[]>()
function deps(file: string): string[] {
  const cached = depsCache.get(file)
  if (cached) return cached
  const text = readFileSync(file, 'utf8')
  const out: string[] = []
  for (const m of text.matchAll(STATIC)) {
    if (/^(import|export)\s+type\s/.test(m[0])) continue
    const r = resolveSpec(file, (m[2] ?? m[3])!)
    if (r) out.push(r)
  }
  for (const m of text.matchAll(DYNAMIC)) {
    const r = resolveSpec(file, m[1]!)
    if (r) out.push(r)
  }
  depsCache.set(file, out)
  return out
}

function reachable(entry: string): Set<string> {
  const seen = new Set([entry])
  const stack = [entry]
  while (stack.length > 0) {
    for (const d of deps(stack.pop()!)) if (!seen.has(d)) { seen.add(d); stack.push(d) }
  }
  return seen
}

const entries = [
  join(SRC, 'index.ts'),
  join(SRC, 'worker.ts'),
  ...readdirSync(join(SRC, 'scripts')).filter((f) => f.endsWith('.ts')).map((f) => join(SRC, 'scripts', f)),
  ...readdirSync(join(SRC, '__integration__')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => join(SRC, '__integration__', f)),
]

describe('the tenant schema is registered wherever it is read', () => {
  it('the reader of the check exists where the rule says (lib/tenantSchema.ts, graphql/schemaCache.ts)', () => {
    expect(existsSync(REGISTRY)).toBe(true)
    expect(readFileSync(REGISTRAR, 'utf8')).toContain('registerTenantSchemaSource(')
  })

  it('the server reaches both: it is the process the registry was made for', () => {
    const r = reachable(join(SRC, 'index.ts'))
    expect(r.has(REGISTRY)).toBe(true)
    expect(r.has(REGISTRAR)).toBe(true)
  })

  it('no entry point reaches the registry without the module that fills it', () => {
    const missing = entries
      .filter((e) => { const r = reachable(e); return r.has(REGISTRY) && !r.has(REGISTRAR) })
      .map((e) => relative(SRC, e))
    expect(missing).toEqual([])
  })
})
