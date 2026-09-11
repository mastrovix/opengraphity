/**
 * lib/queueRegistry.ts (revisione 2 · D2.2): il registro è UNICO e completo.
 * Il test legge i sorgenti (apps/api/src, packages/events|sla|notifications)
 * e raccoglie ogni nome di coda scritto come letterale — `getQueue('x')`,
 * `new Queue('x'`, `createWorker('x'`, `super('x')` dei consumer,
 * `<NOME>_QUEUE = 'x'` / `QUEUE_NAME = 'x'` — più `CONSUMER_QUEUES`: l'insieme
 * deve coincidere con il registro nei due versi. Una coda nuova senza voce
 * (o una voce senza coda) fa fallire il test.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CONSUMER_QUEUES } from '@opengraphity/events'
import { QUEUE_REGISTRY, QUEUE_NAMES, QUEUE_GROUPS, isRegisteredQueue, queueEntry } from '../queueRegistry.js'

const ROOT = resolve(import.meta.dirname, '../../../../..')
const SCAN_DIRS = [
  join(ROOT, 'apps/api/src'),
  join(ROOT, 'packages/events/src'),
  join(ROOT, 'packages/sla/src'),
  join(ROOT, 'packages/notifications/src'),
]

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist' || entry === 'scripts') continue
      yield* walk(full)
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      yield full
    }
  }
}

const NAME = `'([a-z][a-z0-9-]*)'`
const PATTERNS = [
  new RegExp(`\\bgetQueue(?:<[^>]*>)?\\(${NAME}`, 'g'),
  new RegExp(`\\bnew Queue(?:<[^>]*>)?\\(${NAME}`, 'g'),
  new RegExp(`\\bcreateWorker(?:<[^>]*>)?\\(${NAME}`, 'g'),
  new RegExp(`\\bsuper\\(${NAME}\\)`, 'g'),
  new RegExp(`\\b[A-Z0-9_]*QUEUE[A-Z0-9_]*\\s*=\\s*${NAME}`, 'g'),
]

function queueNamesInSources(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      const src = readFileSync(file, 'utf8')
      for (const re of PATTERNS) {
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(src)) !== null) {
          const name = m[1]!
          const list = found.get(name) ?? []
          list.push(file.slice(ROOT.length + 1))
          found.set(name, list)
        }
      }
    }
  }
  for (const name of CONSUMER_QUEUES) {
    const list = found.get(name) ?? []
    list.push('packages/events/src/publisher.ts (CONSUMER_QUEUES)')
    found.set(name, list)
  }
  return found
}

describe('QUEUE_REGISTRY ↔ code create dal codice', () => {
  const inSources = queueNamesInSources()

  it('trova davvero le code nei sorgenti (il pattern non è vuoto)', () => {
    expect(inSources.size).toBeGreaterThanOrEqual(15)
    expect([...inSources.keys()]).toEqual(expect.arrayContaining(['events-ingest', 'services-impact', 'workflow-jobs', 'sla-jobs', 'discovery-sync', 'embeddings']))
  })

  it('ogni coda creata dal codice è nel registro', () => {
    const missing = [...inSources.entries()].filter(([name]) => !isRegisteredQueue(name)).map(([name, files]) => `${name} (${files.join(', ')})`)
    expect(missing).toEqual([])
  })

  it('ogni voce del registro corrisponde a una coda creata dal codice (niente voci fantasma)', () => {
    const phantom = QUEUE_NAMES.filter((name) => !inSources.has(name))
    expect(phantom).toEqual([])
  })

  it('i nomi sono univoci, senza `:` (BullMQ li rifiuta) e ogni gruppo è uno dei quattro dichiarati', () => {
    expect(new Set(QUEUE_NAMES).size).toBe(QUEUE_NAMES.length)
    for (const e of QUEUE_REGISTRY) {
      expect(e.name).not.toContain(':')
      expect(QUEUE_GROUPS).toContain(e.group)
    }
    expect(QUEUE_GROUPS).toEqual(['events', 'services', 'itsm', 'platform'])
  })

  it('le quattro code dei consumer di dominio sono nel registro, marcate consumer e NON rigiocabili; tutte le altre sono rigiocabili', () => {
    for (const name of CONSUMER_QUEUES) {
      expect(queueEntry(name)).toMatchObject({ consumer: true, retryable: false })
    }
    for (const e of QUEUE_REGISTRY) {
      if (!(CONSUMER_QUEUES as readonly string[]).includes(e.name)) expect(e).toMatchObject({ consumer: false, retryable: true })
    }
  })

  it('le code dell\'Event Management e dei Servizi sono nel gruppo giusto (l\'interfaccia raggruppa per `group`, non per nome)', () => {
    expect(QUEUE_REGISTRY.filter((e) => e.group === 'events').map((e) => e.name)).toEqual(['events-ingest', 'events-correlate', 'events-maintenance'])
    expect(QUEUE_REGISTRY.filter((e) => e.group === 'services').map((e) => e.name)).toEqual(['services-impact', 'service-impact-consumer'])
  })

  it('queueEntry su un nome sconosciuto lancia con l\'elenco delle code conosciute', () => {
    expect(() => queueEntry('nope')).toThrow(/Unknown queue: nope \(known: events-ingest, /)
  })
})
