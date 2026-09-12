/**
 * lib/metamodelBus.ts — l'invalidazione che attraversa i processi (A-16).
 *
 * Il difetto che questi test pinnano: `invalidateSchema(tenantId)` agiva SOLO
 * sul processo che aveva servito la mutation. `worker`, `events-worker` e le
 * altre repliche dell'API tenevano la loro copia delle cache e non venivano
 * mai avvisati — una relazione appena definita veniva rifiutata altrove con
 * «Invalid relation type» per cinque minuti.
 *
 * Perciò qui non si verifica che la funzione esista: si mettono in piedi DUE
 * processi (due istanze del grafo dei moduli, `vi.resetModules()` fra l'una e
 * l'altra) che parlano attraverso un finto Redis condiviso, e si guarda se il
 * SECONDO svuota le SUE cache vere (`lib/cache.ts`, `lib/ciTypeFromLabels.ts`)
 * quando il primo invalida.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Finto Redis: un hub in memoria condiviso da tutti i «processi» ───────────

const hub = vi.hoisted(() => {
  interface FakeClient {
    channels: Set<string>
    emit: (event: string, ...args: unknown[]) => void
  }
  const state = {
    clients:       new Set<FakeClient>(),
    counters:      new Map<string, number>(),
    published:     [] as { channel: string; message: string }[],
    failSubscribe: false,
    incr(key: string): number {
      const v = (state.counters.get(key) ?? 0) + 1
      state.counters.set(key, v)
      return v
    },
    /** Come Redis: restituisce il numero di sottoscrittori che hanno ricevuto. */
    publish(channel: string, message: string): number {
      state.published.push({ channel, message })
      let receivers = 0
      for (const c of [...state.clients]) {
        if (c.channels.has(channel)) {
          receivers++
          c.emit('message', channel, message)
        }
      }
      return receivers
    },
    reset(): void {
      state.clients.clear()
      state.counters.clear()
      state.published.length = 0
      state.failSubscribe = false
    },
  }
  return state
})

vi.mock('ioredis', () => {
  class FakeRedis {
    channels = new Set<string>()
    private handlers = new Map<string, ((...args: unknown[]) => void)[]>()
    constructor(readonly opts: unknown) { hub.clients.add(this) }
    on(event: string, fn: (...args: unknown[]) => void): this {
      const list = this.handlers.get(event) ?? []
      list.push(fn)
      this.handlers.set(event, list)
      return this
    }
    emit(event: string, ...args: unknown[]): void {
      for (const fn of this.handlers.get(event) ?? []) fn(...args)
    }
    subscribe(channel: string): Promise<number> {
      if (hub.failSubscribe) return Promise.reject(new Error('redis non raggiungibile'))
      this.channels.add(channel)
      return Promise.resolve(1)
    }
    quit(): Promise<string> { hub.clients.delete(this); return Promise.resolve('OK') }
    disconnect(): void { hub.clients.delete(this) }
  }
  return { Redis: FakeRedis }
})

// Il publisher usa il client CONDIVISO (lib/bullmq.ts), non una connessione sua.
vi.mock('../bullmq.js', () => ({
  getSharedRedis: () => ({
    incr:    (key: string) => Promise.resolve(hub.incr(key)),
    publish: (channel: string, message: string) => Promise.resolve(hub.publish(channel, message)),
  }),
}))

vi.mock('@opengraphity/events', () => ({
  getRedisConnection: () => ({ host: 'redis-finto', port: 6379 }),
}))

const logChild = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logChild },
}))
// `navigableGraph` serve solo perché reportWhitelist lo importa: qui non legge il grafo.
vi.mock('../navigableGraph.js', () => ({
  getNavigableEntities: vi.fn().mockResolvedValue([]),
  getNavigableRelations: vi.fn().mockResolvedValue([]),
}))

// ── Un «processo»: un grafo dei moduli tutto suo ─────────────────────────────

interface FakeProcess {
  bus:    typeof import('../metamodelBus.js')
  inv:    typeof import('../schemaInvalidator.js')
  cache:  typeof import('../cache.js')
  labels: typeof import('../ciTypeFromLabels.js')
}

/**
 * Carica un grafo dei moduli nuovo (= un altro processo) e avvia il canale.
 * `vi.resetModules()` svuota la cache dei moduli: i moduli già caricati dal
 * processo precedente restano vivi con il LORO stato, esattamente come due
 * container distinti.
 */
async function startProcess(): Promise<FakeProcess> {
  vi.resetModules()
  const bus    = await import('../metamodelBus.js')
  const inv    = await import('../schemaInvalidator.js')
  const cache  = await import('../cache.js')
  const labels = await import('../ciTypeFromLabels.js')
  bus.startMetamodelBus()
  await vi.waitFor(() => expect(bus.metamodelBusStatus().subscribed).toBe(true))
  return { bus, inv, cache, labels }
}

/** Riempie le cache derivate dal metamodello di un processo per un tenant. */
function warm(p: FakeProcess, tenantId: string): void {
  p.cache.cache.set(p.cache.metamodelCacheKey('allowed_rel_types', tenantId), ['DEPENDS_ON', 'FEEDS'], 300)
  p.cache.cache.set(p.cache.metamodelCacheKey('topology', tenantId), { nodes: [] }, 30)
  p.labels.registerCITypes(tenantId, [{ neo4jLabel: 'LoadBalancer', name: 'load_balancer' }])
}

/** Vero se il processo ha ancora le cache di quel tenant. */
function isWarm(p: FakeProcess, tenantId: string): boolean {
  return p.cache.cache.get(p.cache.metamodelCacheKey('allowed_rel_types', tenantId)) !== null
    && p.labels.hasCITypes(tenantId)
}

beforeEach(() => {
  vi.clearAllMocks()
  hub.reset()
})

afterEach(() => { vi.useRealTimers() })

describe('il giro completo fra due processi (A-16)', () => {
  it('il secondo processo svuota le SUE cache quando il primo invalida, e non ripubblica', async () => {
    const a = await startProcess()
    const b = await startProcess()
    // Due processi davvero distinti: identità e cache separate.
    expect(a.bus.BUS_ORIGIN).not.toBe(b.bus.BUS_ORIGIN)
    expect(a.cache.cache).not.toBe(b.cache.cache)

    warm(a, 'c-two'); warm(a, 'c-one')
    warm(b, 'c-two'); warm(b, 'c-one')
    expect(isWarm(a, 'c-two')).toBe(true)
    expect(isWarm(b, 'c-two')).toBe(true)

    a.inv.invalidateSchema('c-two')

    // Il processo che serve la mutation svuota subito, in modo sincrono.
    expect(isWarm(a, 'c-two')).toBe(false)
    // L'altro processo — che prima non veniva mai avvisato — svuota le sue.
    await vi.waitFor(() => expect(isWarm(b, 'c-two')).toBe(false))

    // Gli altri tenant non vengono toccati, in nessuno dei due processi.
    expect(isWarm(a, 'c-one')).toBe(true)
    expect(isWarm(b, 'c-one')).toBe(true)

    // Un messaggio solo: il ricevitore NON ripubblica (niente rimbalzo).
    expect(hub.published).toHaveLength(1)
    expect(hub.published[0]?.channel).toBe(a.bus.METAMODEL_CHANNEL)
  })

  it('la relazione appena definita è ammessa subito dall\'altro processo (il difetto originale)', async () => {
    const a = await startProcess()
    const b = await startProcess()
    // Entrambi hanno in cache i tipi di relazione di PRIMA (senza FEEDS_FROM).
    const key = b.cache.metamodelCacheKey('allowed_rel_types', 'c-two')
    a.cache.cache.set(key, ['DEPENDS_ON'], 300)
    b.cache.cache.set(key, ['DEPENDS_ON'], 300)

    a.inv.invalidateSchema('c-two')

    // La cache dell'altro processo è caduta: alla prossima richiesta rilegge
    // il metamodello e trova la relazione nuova, invece di rifiutarla per 300 s.
    await vi.waitFor(() => expect(b.cache.cache.get(key)).toBeNull())
  })

  it('ogni cache registrata viene svuotata e dichiarata nel log, in entrambi i processi', async () => {
    const a = await startProcess()
    await import('../reportWhitelist.js')   // registra 'report-whitelist' in questo processo
    const b = await startProcess()
    await import('../reportWhitelist.js')

    expect(a.inv.registeredMetamodelCacheClearers()).toEqual(
      expect.arrayContaining(['memory-cache', 'ci-type-labels', 'report-whitelist']),
    )

    a.inv.invalidateSchema('c-two')
    expect(a.inv.lastInvalidation()).toMatchObject({
      tenantId: 'c-two',
      published: true,
      failed: [],
      cleared: expect.arrayContaining(['memory-cache', 'ci-type-labels', 'report-whitelist']),
    })
    await vi.waitFor(() => expect(logChild.info).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'c-two', cleared: expect.arrayContaining(['memory-cache']) }),
      expect.stringContaining('cambiato in un altro processo'),
    ))
    expect(b.bus.metamodelBusStatus().subscribed).toBe(true)
  })

  it('il messaggio che torna a chi l\'ha pubblicato non rifà il lavoro', async () => {
    const a = await startProcess()
    const seen: string[] = []
    a.inv.registerMetamodelCacheClearer('spia', (t) => seen.push(t))

    a.inv.invalidateSchema('c-two')
    await vi.waitFor(() => expect(hub.published).toHaveLength(1))
    // Il proprio messaggio arriva (A è sottoscritto) ma viene scartato: una
    // sola passata di svuotamento, non due.
    expect(seen).toEqual(['c-two'])
  })

  it('un messaggio duplicato o fuori ordine viene scartato (version monotona)', async () => {
    const a = await startProcess()
    const b = await startProcess()
    const seen: string[] = []
    b.inv.registerMetamodelCacheClearer('spia', (t) => seen.push(t))

    a.inv.invalidateSchema('c-two')
    await vi.waitFor(() => expect(seen).toEqual(['c-two']))

    // Lo stesso messaggio riconsegnato: version già applicata → niente.
    const replay = hub.published[0]!
    hub.publish(replay.channel, replay.message)
    expect(seen).toEqual(['c-two'])

    // Una version più alta invece passa.
    a.inv.invalidateSchema('c-two')
    await vi.waitFor(() => expect(seen).toEqual(['c-two', 'c-two']))
  })
})

describe('un canale muto non passa inosservato', () => {
  it('nessuno in ascolto → warn esplicito, non un silenzio', async () => {
    vi.resetModules()
    const bus = await import('../metamodelBus.js')
    const inv = await import('../schemaInvalidator.js')
    // Publisher registrato ma nessun subscriber: come un solo processo che
    // pubblica nel vuoto perché nessun altro sta ascoltando.
    inv.registerMetamodelPublisher(bus.publishMetamodelChange)

    inv.invalidateSchema('c-two')
    await vi.waitFor(() => expect(logChild.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'c-two', receivers: 0 }),
      expect.stringContaining('nessun processo in ascolto'),
    ))
  })

  it('sottoscrizione fallita → error che lo dice, e riprovata fino a riuscire', async () => {
    vi.useFakeTimers()
    hub.failSubscribe = true
    vi.resetModules()
    const bus = await import('../metamodelBus.js')
    const inv = await import('../schemaInvalidator.js')
    const cache = await import('../cache.js')
    bus.startMetamodelBus()

    await vi.waitFor(() => expect(logChild.error).toHaveBeenCalledWith(
      expect.objectContaining({ retryInMs: bus.RESUBSCRIBE_DELAY_MS }),
      expect.stringContaining('sottoscrizione FALLITA'),
    ))
    expect(bus.metamodelBusStatus().subscribed).toBe(false)

    // Redis torna: il ritentativo riesce e il processo riprende ad ascoltare.
    hub.failSubscribe = false
    await vi.advanceTimersByTimeAsync(bus.RESUBSCRIBE_DELAY_MS + 1)
    expect(bus.metamodelBusStatus().subscribed).toBe(true)

    // E da quel momento i messaggi arrivano davvero.
    const key = cache.metamodelCacheKey('allowed_rel_types', 'c-two')
    cache.cache.set(key, ['DEPENDS_ON'], 300)
    hub.publish(bus.METAMODEL_CHANNEL, JSON.stringify({ tenantId: 'c-two', version: 99, origin: 'un-altro-processo' }))
    expect(cache.cache.get(key)).toBeNull()
    await bus.stopMetamodelBus()
    expect(inv.hasMetamodelPublisher()).toBe(false)
  })

  it('disconnessione → subscribed falso e warn; alla riconnessione (`ready`) si ri-sottoscrive', async () => {
    const p = await startProcess()
    const client = [...hub.clients][0] as unknown as { emit: (e: string) => void }

    client.emit('close')
    expect(p.bus.metamodelBusStatus().subscribed).toBe(false)
    expect(logChild.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('sottoscrizione persa'))

    client.emit('ready')
    await vi.waitFor(() => expect(p.bus.metamodelBusStatus().subscribed).toBe(true))
  })

  it('un messaggio malformato è un errore nel log, non uno svuotamento a caso', async () => {
    const p = await startProcess()
    const seen: string[] = []
    p.inv.registerMetamodelCacheClearer('spia', (t) => seen.push(t))

    hub.publish(p.bus.METAMODEL_CHANNEL, 'non-json')
    hub.publish(p.bus.METAMODEL_CHANNEL, JSON.stringify({ tenantId: '', version: 1, origin: 'x' }))
    hub.publish(p.bus.METAMODEL_CHANNEL, JSON.stringify({ version: 1, origin: 'x' }))

    expect(seen).toEqual([])
    expect(logChild.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('non è JSON'))
    expect(logChild.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('malformato'))
  })

  it('una cache che lancia non ferma le altre ed è raccolta in `failed`', async () => {
    const p = await startProcess()
    p.inv.registerMetamodelCacheClearer('rotta', () => { throw new Error('boom') })
    const seen: string[] = []
    p.inv.registerMetamodelCacheClearer('spia', (t) => seen.push(t))

    p.inv.invalidateSchema('c-two')
    expect(seen).toEqual(['c-two'])
    expect(p.inv.lastInvalidation()?.failed).toEqual([{ name: 'rotta', error: 'boom' }])
  })

  it('senza canale attivo l\'invalidazione è locale e lo dichiara', async () => {
    vi.resetModules()
    const inv = await import('../schemaInvalidator.js')
    expect(inv.hasMetamodelPublisher()).toBe(false)
    inv.invalidateSchema('c-two')
    expect(inv.lastInvalidation()).toMatchObject({ tenantId: 'c-two', published: false })
  })
})

describe('la versione del metamodello', () => {
  it('è un INCR per tenant: cresce a ogni cambiamento e non si mescola fra clienti', async () => {
    const a = await startProcess()
    a.inv.invalidateSchema('c-one')
    a.inv.invalidateSchema('c-two')
    a.inv.invalidateSchema('c-one')
    await vi.waitFor(() => expect(hub.published).toHaveLength(3))
    const versions = hub.published.map((p) => JSON.parse(p.message) as { tenantId: string; version: number })
    expect(versions).toEqual([
      { tenantId: 'c-one', version: 1, origin: expect.any(String) },
      { tenantId: 'c-two', version: 1, origin: expect.any(String) },
      { tenantId: 'c-one', version: 2, origin: expect.any(String) },
    ])
    expect(a.bus.metamodelVersionKey('c-one')).toBe('og:metamodel:version:c-one')
  })
})
