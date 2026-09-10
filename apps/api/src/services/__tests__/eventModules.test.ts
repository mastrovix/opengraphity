/**
 * services/events/* — struttura dei moduli (revisione, 3.1): nessun import
 * circolare statico e la regola "pipeline.ts non importa mai ingest.ts né
 * passes.ts". Il grafo si ricava dagli `import … from './x.js'` sorgente
 * (madge non è fra le dipendenze del monorepo); gli import dinamici di
 * deps.ts (motore del workflow, incidentService, coda) sono esclusi apposta:
 * sono l'unico accoppiamento "al momento dell'uso" ammesso e dichiarato.
 * Le facciate (eventService/eventCorrelation/eventStorm) ri-esportano SOLO:
 * un modulo interno che importasse una facciata chiuderebbe il ciclo.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, '../events')
const services = join(here, '..')

const STATIC_IMPORT_RE = /^import\s[^;]*?from\s+'([^']+)'/gm

function localImports(file: string, base: string): string[] {
  const src = readFileSync(join(base, file), 'utf8')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = STATIC_IMPORT_RE.exec(src)) !== null) {
    const spec = m[1]!
    if (spec.startsWith('./')) out.push(spec.slice(2).replace(/\.js$/, '.ts'))
  }
  return out
}

const modules = readdirSync(dir).filter((f) => f.endsWith('.ts'))
const graph = new Map(modules.map((m) => [m, localImports(m, dir)]))

function findCycle(): string[] | null {
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  const visit = (node: string): string[] | null => {
    if (state.get(node) === 'done') return null
    if (state.get(node) === 'visiting') return [...stack.slice(stack.indexOf(node)), node]
    state.set(node, 'visiting'); stack.push(node)
    for (const dep of graph.get(node) ?? []) { const c = visit(dep); if (c) return c }
    stack.pop(); state.set(node, 'done')
    return null
  }
  for (const m of modules) { const c = visit(m); if (c) return c }
  return null
}

describe('services/events — grafo dei moduli', () => {
  it('perimetro atteso', () => {
    for (const m of ['shared.ts', 'types.ts', 'normalize.ts', 'transitions.ts', 'policy.ts', 'ciHealth.ts', 'repo.ts', 'deps.ts', 'incidentWorkflow.ts', 'suppression.ts', 'flapping.ts', 'autoResolve.ts', 'grouping.ts', 'storm.ts', 'sourceCache.ts', 'pipeline.ts', 'passes.ts', 'gauges.ts', 'ingest.ts']) {
      expect(modules, m).toContain(m)
    }
  })

  it('nessun ciclo statico fra i moduli', () => {
    expect(findCycle()).toBeNull()
  })

  it('pipeline.ts non importa ingest.ts né passes.ts; ingest.ts importa pipeline.ts; normalize.ts e shared.ts sono foglie del dominio', () => {
    expect(graph.get('pipeline.ts')).not.toContain('ingest.ts')
    expect(graph.get('pipeline.ts')).not.toContain('passes.ts')
    expect(graph.get('ingest.ts')).toContain('pipeline.ts')
    expect(graph.get('normalize.ts')).toEqual([])
    expect(graph.get('shared.ts')).toEqual([])
    expect(graph.get('types.ts')).toEqual(['shared.ts'])
  })

  it('nessun modulo interno importa le facciate (eventService/eventCorrelation/eventStorm/eventRetention)', () => {
    for (const m of modules) {
      const src = readFileSync(join(dir, m), 'utf8')
      expect(src, m).not.toMatch(/from '\.\.\/event(Service|Correlation|Storm|Retention)\.js'/)
    }
  })

  it('pipeline.ts: ogni passo che riceve la sessione è restituito con `return await` (altrimenti il finally chiude la sessione prima della fine del passo)', () => {
    // Regressione reale (ondata 3): `return correlateFiringEvent(session, …)` dentro
    // try/finally → "You cannot run more transactions on a closed session" e
    // crash dell'API in loop sui job riprovati.
    const src = readFileSync(join(dir, 'pipeline.ts'), 'utf8')
    const bare = src.match(/^\s*(?:if \([^)]*\) )?return (?!await )[A-Za-z]+\(session\b.*$/gm) ?? []
    expect(bare).toEqual([])
    expect((src.match(/return await [A-Za-z]+\(session,/g) ?? []).length).toBeGreaterThanOrEqual(6)
  })

  it('le facciate contengono solo ri-esportazioni (nessun import, nessuna dichiarazione)', () => {
    for (const f of ['eventService.ts', 'eventCorrelation.ts', 'eventStorm.ts']) {
      const src = readFileSync(join(services, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      expect(src, f).not.toMatch(/^\s*(import|const|let|function|class|async)\s/m)
      expect(src, f).toMatch(/^export (\*|\{|type)/m)
    }
  })
})
