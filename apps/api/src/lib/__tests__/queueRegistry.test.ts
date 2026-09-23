/**
 * lib/queueRegistry.ts (revisione 2 · D2.2): il registro è UNICO e completo.
 * Il test legge i sorgenti (apps/api/src, packages/events|sla|notifications|
 * workflow) e raccoglie ogni nome di coda scritto come letterale —
 * `getQueue('x')`, `getTenantQueue('x'`, `tenantQueue('x'`, `new Queue('x'`,
 * `createWorker('x'`, `createTenantWorkers('x'`, `super('x')` dei consumer,
 * `<NOME>_QUEUE = 'x'` / `QUEUE_NAME = 'x'` — più `CONSUMER_QUEUES`: l'insieme
 * deve coincidere con il registro nei due versi. Una coda nuova senza voce
 * (o una voce senza coda) fa fallire il test.
 *
 * Dal 23 set 2026 una coda è di un tenant (`<nome>@<tenant>`) o della
 * piattaforma: il test pretende che ognuna si apra con l'API del suo ambito,
 * e che BullMQ si istanzi solo nei due moduli che lo incapsulano.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CONSUMER_QUEUES } from '@opengraphity/events'
import {
  QUEUE_REGISTRY, QUEUE_NAMES, QUEUE_GROUPS, QUEUE_SCOPES, TENANT_QUEUE_BASES, PLATFORM_QUEUE_NAMES,
  isRegisteredQueue, isTenantQueueBase, queueEntry,
} from '../queueRegistry.js'

const ROOT = resolve(import.meta.dirname, '../../../../..')
const SCAN_DIRS = [
  join(ROOT, 'apps/api/src'),
  join(ROOT, 'packages/events/src'),
  join(ROOT, 'packages/sla/src'),
  join(ROOT, 'packages/notifications/src'),
  join(ROOT, 'packages/workflow/src'),
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
/** A call whose first argument names a queue: a literal, or a constant defined in the same file. */
const call = (fn: string, arg: string) => new RegExp(`\\b${fn}(?:<[^>]*>)?\\(${arg}`, 'g')
const PATTERNS = [
  call('getQueue', NAME),
  call('getTenantQueue', NAME),
  call('tenantQueue', NAME),
  call('new Queue', NAME),
  call('createWorker', NAME),
  call('createTenantWorkers', NAME),
  call('new TenantWorkerPool', NAME),
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

  it('i nomi sono univoci, senza `:` (BullMQ li rifiuta) né `@` (separa il tenant), e gruppo e ambito sono di quelli dichiarati', () => {
    expect(new Set(QUEUE_NAMES).size).toBe(QUEUE_NAMES.length)
    for (const e of QUEUE_REGISTRY) {
      expect(e.name).not.toContain(':')
      expect(e.name).not.toContain('@')
      expect(QUEUE_GROUPS).toContain(e.group)
      expect(QUEUE_SCOPES).toContain(e.scope)
    }
    expect(QUEUE_GROUPS).toEqual(['events', 'services', 'itsm', 'analysis', 'platform'])
  })

  it('le code della piattaforma sono due — Autoanalisi e manutenzione — e sono il gruppo `platform`; tutte le altre sono per tenant', () => {
    expect(PLATFORM_QUEUE_NAMES).toEqual(['autoanalisi', 'maintenance'])
    for (const e of QUEUE_REGISTRY) expect(e.scope === 'platform', e.name).toBe(e.group === 'platform')
    expect([...TENANT_QUEUE_BASES, ...PLATFORM_QUEUE_NAMES].sort()).toEqual([...QUEUE_NAMES].sort())
    expect(isTenantQueueBase('sla-jobs')).toBe(true)
    expect(isTenantQueueBase('service-impact-consumer')).toBe(true)
    expect(isTenantQueueBase('maintenance')).toBe(false)
    expect(isTenantQueueBase('nope')).toBe(false)
  })

  it('le quattro code dei consumer di dominio sono nel registro, marcate consumer e NON rigiocabili; tutte le altre sono rigiocabili', () => {
    for (const name of CONSUMER_QUEUES) {
      expect(queueEntry(name)).toMatchObject({ consumer: true, retryable: false })
    }
    for (const e of QUEUE_REGISTRY) {
      if (!(CONSUMER_QUEUES as readonly string[]).includes(e.name)) expect(e).toMatchObject({ consumer: false, retryable: true })
    }
  })

  it('le code dell\'Event Management, dei Servizi e delle analisi sono nel gruppo giusto (l\'interfaccia raggruppa per `group`, non per nome)', () => {
    expect(QUEUE_REGISTRY.filter((e) => e.group === 'events').map((e) => e.name)).toEqual(['events-ingest', 'events-correlate', 'events-maintenance'])
    expect(QUEUE_REGISTRY.filter((e) => e.group === 'services').map((e) => e.name)).toEqual(['services-impact', 'service-impact-consumer'])
    expect(QUEUE_REGISTRY.filter((e) => e.group === 'analysis').map((e) => e.name))
      .toEqual(['webhook-delivery', 'report-scheduler', 'anomaly-scanner', 'proposal-scanner', 'discovery-sync', 'embeddings'])
  })

  it('queueEntry su un nome sconosciuto lancia con l\'elenco delle code conosciute', () => {
    expect(() => queueEntry('nope')).toThrow(/Unknown queue: nope \(known: events-ingest, /)
  })
})

/*
 * EACH QUEUE THROUGH THE API OF ITS SCOPE (23 Sep 2026).
 *
 * A tenant queue opened as a shared one would put every tenant's work back in
 * one queue — the thing the owner decided to end. `getQueue`/`createWorker`
 * refuse a tenant base at runtime; this catches it before, and the other way
 * round too. BullMQ itself is instantiated in two places only: lib/bullmq.ts
 * (platform queues) and packages/events/src/tenantQueues.ts (tenant queues).
 */
describe('ogni coda si apre con l\'API del suo ambito', () => {
  const files = SCAN_DIRS.flatMap((d) => [...walk(d)])

  /** The queue names the calls to `fn` pass, as literals or as constants of the same file. */
  function namesPassedTo(src: string, fn: string): string[] {
    const constants = new Map<string, string>()
    for (const m of src.matchAll(/\b([A-Z][A-Z0-9_]*)\s*=\s*'([a-z][a-z0-9-]*)'/g)) constants.set(m[1]!, m[2]!)
    const names: string[] = []
    for (const m of src.matchAll(call(fn, `(?:${NAME}|([A-Z][A-Z0-9_]*))`))) {
      const name = m[1] ?? constants.get(m[2]!)
      if (name) names.push(name)
    }
    return names
  }

  it('nessuna coda di tenant aperta come condivisa, nessuna coda della piattaforma aperta come di un tenant', () => {
    const wrong: string[] = []
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      const where = file.slice(ROOT.length + 1)
      for (const fn of ['getQueue', 'createWorker']) {
        for (const name of namesPassedTo(src, fn)) if (isTenantQueueBase(name)) wrong.push(`${where}: ${fn}('${name}') — a tenant queue: getTenantQueue / createTenantWorkers`)
      }
      for (const fn of ['getTenantQueue', 'tenantQueue', 'createTenantWorkers', 'new TenantWorkerPool']) {
        for (const name of namesPassedTo(src, fn)) if (!isTenantQueueBase(name)) wrong.push(`${where}: ${fn}('${name}') — not a tenant queue`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('BullMQ si istanzia solo in lib/bullmq.ts e in packages/events/src/tenantQueues.ts', () => {
    const allowed = ['apps/api/src/lib/bullmq.ts', 'packages/events/src/tenantQueues.ts']
    const stray = files
      .map((file) => file.slice(ROOT.length + 1))
      .filter((where) => !allowed.includes(where))
      .filter((where) => /\bnew (Queue|Worker|QueueEvents|FlowProducer)\b(?:<[^>]*>)?\(/.test(readFileSync(join(ROOT, where), 'utf8')))
    expect(stray).toEqual([])
  })

  it('le guardie vedono davvero le chiamate (i pattern non sono vuoti)', () => {
    const all = files.map((f) => readFileSync(f, 'utf8'))
    expect(all.flatMap((src) => namesPassedTo(src, 'getQueue'))).toEqual(expect.arrayContaining(['maintenance']))
    expect(all.flatMap((src) => namesPassedTo(src, 'createTenantWorkers'))).toEqual(expect.arrayContaining(['webhook-delivery', 'embeddings']))
    expect(all.flatMap((src) => namesPassedTo(src, 'new TenantWorkerPool'))).toEqual(['sla-jobs'])
    expect(all.flatMap((src) => namesPassedTo(src, 'tenantQueue'))).toEqual(expect.arrayContaining(['workflow-jobs', 'notification-jobs', 'sla-jobs']))
  })
})
