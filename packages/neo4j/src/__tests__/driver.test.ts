/**
 * driver.ts — NEO4J_MAX_POOL_SIZE (revisione 2 · D1.1): the pool size is
 * configurable per process, defaults to 50, and a value that is not a
 * positive integer is a configuration error (never NaN passed to the driver).
 */
import { describe, it, expect, vi } from 'vitest'

const driverCalls: Array<{ uri: string; config: Record<string, unknown> }> = []
vi.mock('neo4j-driver', () => {
  const fake = {
    driver: vi.fn((uri: string, _auth: unknown, config: Record<string, unknown>) => {
      driverCalls.push({ uri, config })
      return { verifyConnectivity: vi.fn().mockResolvedValue(undefined), session: vi.fn(), close: vi.fn() }
    }),
    auth: { basic: vi.fn(() => ({})) },
    session: { READ: 'READ', WRITE: 'WRITE' },
    isInt: () => false,
  }
  return { default: fake, ...fake }
})

describe('NEO4J_MAX_POOL_SIZE', () => {
  it('parseMaxPoolSize: default 50, positive integers accepted, anything else throws with the variable name', async () => {
    vi.stubEnv('NEO4J_MAX_POOL_SIZE', '')
    const { parseMaxPoolSize, NEO4J_DEFAULT_MAX_POOL_SIZE } = await import('../driver.js')
    expect(NEO4J_DEFAULT_MAX_POOL_SIZE).toBe(50)
    expect(parseMaxPoolSize(undefined)).toBe(50)
    expect(parseMaxPoolSize('')).toBe(50)
    expect(parseMaxPoolSize('40')).toBe(40)
    expect(parseMaxPoolSize('1')).toBe(1)
    for (const bad of ['0', '-5', '2.5', 'abc', '50x']) {
      expect(() => parseMaxPoolSize(bad)).toThrow(/NEO4J_MAX_POOL_SIZE must be a positive integer/)
    }
    vi.unstubAllEnvs()
  })

  it('the driver is created with maxConnectionPoolSize from the environment (default when unset)', async () => {
    const { getDriver } = await import('../driver.js')
    getDriver()
    expect(driverCalls.length).toBeGreaterThanOrEqual(1)
    expect(driverCalls[0]!.config).toMatchObject({ maxConnectionPoolSize: 50, connectionAcquisitionTimeout: 30_000 })
  })
})

/**
 * La sessione avvolta converte i numeri e traccia le query anche su una
 * transazione ESPLICITA (revisione totale · M-22).
 *
 * `beginTransaction` era l'unico modo di ottenere una transazione non
 * avvolta: le sue `tx.run` restituivano `neo4j.Integer` invece di numeri e le
 * sue query non finivano nel tracciamento. Un chiamante c'è davvero
 * (`backup-neo4j.ts`, che esporta tutto in una sola transazione di lettura).
 */
describe('getSession(): beginTransaction', () => {
  it('la transazione esplicita e avvolta: la sua run non e quella grezza del driver', async () => {
    vi.resetModules()
    const neo4j = (await import('neo4j-driver')).default as unknown as { driver: ReturnType<typeof vi.fn> }
    const txRun = vi.fn(async () => ({ records: [], summary: {} }))
    const rawTx = { run: txRun, commit: vi.fn(), rollback: vi.fn() }
    neo4j.driver.mockReturnValue({
      verifyConnectivity: vi.fn().mockResolvedValue(undefined),
      session: vi.fn(() => ({ beginTransaction: () => rawTx, run: vi.fn(), close: vi.fn() })),
      close: vi.fn(),
    } as never)

    const { getSession } = await import('../driver.js')
    const tx = getSession().beginTransaction()

    // È il segno del wrapping: `run` è la funzione del proxy, non quella del
    // driver — quindi passa da convertResult e dal tracciamento.
    expect(tx.run).not.toBe(txRun)
    await tx.run('RETURN 1')
    expect(txRun).toHaveBeenCalledWith('RETURN 1', undefined)
    // commit/rollback restano quelli veri: il proxy tocca solo `run`.
    expect(tx.commit).toBe(rawTx.commit)
  })
})

/**
 * LA SESSIONE AVVOLTA (22 set 2026).
 *
 * `wrapSession` e `wrapManagedTransaction` erano il pezzo più scoperto del
 * pacchetto: quarantaquattro istruzioni su novanta mai toccate. Fanno due cose
 * che il resto del prodotto dà per scontate, e che se smettessero si
 * vedrebbero solo a valle e per caso:
 *
 *  1. **ogni `run` passa da `convertResult`**, quindi un `neo4j.Integer` esce
 *     come numero. Chi legge un conteggio non deve sapere che esiste
 *     `.toNumber()`;
 *  2. **ogni `run` finisce nel tracciamento**, anche quando la query FALLISCE
 *     — è `finally`, non `then`: una query lenta che poi esplode è esattamente
 *     quella che si vuole vedere nelle metriche.
 *
 * E `beginTransaction` è avvolta come le altre due: era l'unico modo di
 * ottenere una transazione NON avvolta, e `backup-neo4j.ts` ci leggeva i
 * conteggi — ricevendo `Integer` invece di numeri (revisione totale · M-22).
 */
describe('la sessione avvolta', () => {
  /** Un driver finto le cui sessioni registrano quello che ricevono. */
  async function conSessione(sessioneFinta: Record<string, unknown>) {
    vi.resetModules()
    vi.doMock('neo4j-driver', () => {
      const fake = {
        driver: vi.fn(() => ({
          verifyConnectivity: vi.fn().mockResolvedValue(undefined),
          session: vi.fn(() => sessioneFinta),
          close: vi.fn().mockResolvedValue(undefined),
        })),
        auth: { basic: vi.fn(() => ({})) },
        session: { READ: 'READ', WRITE: 'WRITE' },
        // `convertResult` chiama `.toNumber()` sull'oggetto stesso: l'Integer
        // finto deve portarselo, come quello vero.
        isInt: (v: unknown) => typeof v === 'object' && v !== null && 'low' in (v as object),
      }
      return { default: fake, ...fake }
    })
    return import('../driver.js')
  }

  /** Un Integer di Neo4j come lo restituisce il driver vero. */
  const intero = (n: number) => ({ low: n, high: 0, toNumber: () => n })

  const risultato = (valore: unknown) => ({
    records: [{ keys: ['n'], get: () => valore, toObject: () => ({ n: valore }) }],
  })

  it('`run` converte gli Integer di Neo4j in numeri', async () => {
    const run = vi.fn(async () => risultato(intero(42)))
    const { getSession } = await conSessione({ run })
    const s = getSession()
    const out = await (s as unknown as { run: (q: string) => Promise<{ records: Array<{ get: () => unknown }> }> }).run('RETURN 1')
    expect(out.records[0]!.get()).toBe(42)
  })

  it('e traccia ogni query, anche quella che FALLISCE', async () => {
    const run = vi.fn(async () => { throw new Error('deadlock') })
    const { getSession, registerSessionTracker } = await conSessione({ run })
    const viste: string[] = []
    registerSessionTracker((_ms, q) => viste.push(q))
    const s = getSession()
    await (s as unknown as { run: (q: string) => Promise<unknown> }).run('MATCH (n) RETURN n')
      .catch(() => { /* il punto è che sia tracciata lo stesso */ })
    expect(viste).toEqual(['MATCH (n) RETURN n'])
    registerSessionTracker(null)
  })

  it('`executeRead` e `executeWrite` avvolgono la transazione che danno al chiamante', async () => {
    const txRun = vi.fn(async () => risultato(intero(7)))
    const esegui = vi.fn((work: (tx: unknown) => unknown) => work({ run: txRun }))
    const { getSession } = await conSessione({ executeRead: esegui, executeWrite: esegui })
    const s = getSession() as unknown as { executeRead: (w: (tx: { run: (q: string) => Promise<{ records: Array<{ get: () => unknown }> }> }) => unknown) => unknown }
    const out = await s.executeRead(async (tx) => (await tx.run('RETURN count(n)')).records[0]!.get()) as unknown
    expect(out).toBe(7)
  })

  it('`beginTransaction` è avvolta come le altre: era l\'unico modo di averne una NUDA', async () => {
    const txRun = vi.fn(async () => risultato(intero(3)))
    const begin = vi.fn(() => ({ run: txRun, commit: vi.fn(), rollback: vi.fn() }))
    const { getSession } = await conSessione({ beginTransaction: begin })
    const s = getSession() as unknown as { beginTransaction: () => { run: (q: string) => Promise<{ records: Array<{ get: () => unknown }> }> } }
    const tx = s.beginTransaction()
    expect((await tx.run('RETURN 1')).records[0]!.get()).toBe(3)
  })

  it('tutto il resto della sessione passa intatto: `close` è quello vero', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    const { getSession } = await conSessione({ close, prop: 'valore' })
    const s = getSession() as unknown as { close: () => Promise<void>; prop: string }
    await s.close()
    expect(close).toHaveBeenCalled()
    expect(s.prop).toBe('valore')
  })

  it('il modo di accesso e il database arrivano al driver', async () => {
    const sessionFactory = vi.fn(() => ({ run: vi.fn() }))
    vi.resetModules()
    vi.doMock('neo4j-driver', () => {
      const fake = {
        driver: vi.fn(() => ({ verifyConnectivity: vi.fn().mockResolvedValue(undefined), session: sessionFactory, close: vi.fn() })),
        auth: { basic: vi.fn(() => ({})) },
        session: { READ: 'READ', WRITE: 'WRITE' },
        isInt: () => false,
      }
      return { default: fake, ...fake }
    })
    const { getSession } = await import('../driver.js')
    getSession('neo4j', 'WRITE' as never)
    expect(sessionFactory).toHaveBeenCalledWith({ database: 'neo4j', defaultAccessMode: 'WRITE' })
  })

  it('`closeDriver` chiude e dimentica: il driver dopo è nuovo', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    vi.resetModules()
    const fatti: unknown[] = []
    vi.doMock('neo4j-driver', () => {
      const fake = {
        driver: vi.fn(() => { const d = { verifyConnectivity: vi.fn().mockResolvedValue(undefined), session: vi.fn(), close }; fatti.push(d); return d }),
        auth: { basic: vi.fn(() => ({})) },
        session: { READ: 'READ', WRITE: 'WRITE' },
        isInt: () => false,
      }
      return { default: fake, ...fake }
    })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { getDriver, closeDriver } = await import('../driver.js')
    const primo = getDriver()
    await closeDriver()
    expect(close).toHaveBeenCalled()
    expect(getDriver()).not.toBe(primo)
  })

  it('e chiudere due volte non esplode', async () => {
    vi.resetModules()
    vi.doMock('neo4j-driver', () => {
      const fake = {
        driver: vi.fn(() => ({ verifyConnectivity: vi.fn().mockResolvedValue(undefined), session: vi.fn(), close: vi.fn().mockResolvedValue(undefined) })),
        auth: { basic: vi.fn(() => ({})) },
        session: { READ: 'READ', WRITE: 'WRITE' },
        isInt: () => false,
      }
      return { default: fake, ...fake }
    })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { closeDriver } = await import('../driver.js')
    await closeDriver()
    await expect(closeDriver()).resolves.toBeUndefined()
  })
})

/**
 * `convertIntegers` — quello che esce da una `run` avvolta (22 set 2026).
 *
 * Non è esportato: si esercita da dove lo esercita il prodotto, cioè una
 * sessione avvolta. Deve scendere dentro liste, mappe e NODI — un nodo di
 * Neo4j porta i suoi valori sotto `properties`, e se quel ramo smettesse di
 * funzionare ogni conteggio letto da un nodo tornerebbe a essere un oggetto
 * `{low, high}` invece di un numero. Il chiamante non se ne accorge finché non
 * fa un'addizione.
 */
describe('la conversione dei valori che escono da una run', () => {
  const intero = (n: number) => ({ low: n, high: 0, toNumber: () => n })

  async function conValore(valore: unknown) {
    vi.resetModules()
    vi.doMock('neo4j-driver', () => {
      const fake = {
        driver: vi.fn(() => ({
          verifyConnectivity: vi.fn().mockResolvedValue(undefined),
          session: vi.fn(() => ({
            run: vi.fn(async () => ({ records: [{ get: () => valore }] })),
          })),
          close: vi.fn(),
        })),
        auth: { basic: vi.fn(() => ({})) },
        session: { READ: 'READ', WRITE: 'WRITE' },
        isInt: (v: unknown) => typeof v === 'object' && v !== null && 'low' in (v as object) && 'toNumber' in (v as object),
      }
      return { default: fake, ...fake }
    })
    const { getSession } = await import('../driver.js')
    const s = getSession() as unknown as { run: (q: string) => Promise<{ records: Array<{ get: () => unknown }> }> }
    return (await s.run('RETURN x')).records[0]!.get()
  }

  it('un Integer da solo', async () => {
    expect(await conValore(intero(42))).toBe(42)
  })

  it('un BigInt: anche quello diventa un numero', async () => {
    expect(await conValore(7n)).toBe(7)
  })

  it('dentro una lista, anche annidata', async () => {
    expect(await conValore([intero(1), [intero(2)]])).toEqual([1, [2]])
  })

  it('dentro una mappa, anche annidata', async () => {
    expect(await conValore({ n: intero(3), dentro: { m: intero(4) } }))
      .toEqual({ n: 3, dentro: { m: 4 } })
  })

  it('dentro le `properties` di un NODO, che è il caso che conta davvero', async () => {
    const nodo = { identity: intero(9), labels: ['Incident'], properties: { conteggio: intero(5), nome: 'INC1' } }
    const out = await conValore(nodo) as { properties: Record<string, unknown>; identity: unknown }
    expect(out.properties).toEqual({ conteggio: 5, nome: 'INC1' })
    expect(out.identity).toBe(9)
  })

  it('null, undefined e i valori normali passano intatti', async () => {
    expect(await conValore(null)).toBeNull()
    expect(await conValore(undefined)).toBeUndefined()
    expect(await conValore('testo')).toBe('testo')
    expect(await conValore(3.5)).toBe(3.5)
    expect(await conValore(true)).toBe(true)
  })

  it('un risultato senza `records` non si tocca', async () => {
    vi.resetModules()
    vi.doMock('neo4j-driver', () => {
      const fake = {
        driver: vi.fn(() => ({
          verifyConnectivity: vi.fn().mockResolvedValue(undefined),
          session: vi.fn(() => ({ run: vi.fn(async () => ({ summary: { counters: 1 } })) })),
          close: vi.fn(),
        })),
        auth: { basic: vi.fn(() => ({})) },
        session: { READ: 'READ', WRITE: 'WRITE' },
        isInt: () => false,
      }
      return { default: fake, ...fake }
    })
    const { getSession } = await import('../driver.js')
    const s = getSession() as unknown as { run: (q: string) => Promise<unknown> }
    expect(await s.run('CREATE (n)')).toEqual({ summary: { counters: 1 } })
  })
})

/**
 * LE VARIABILI D'AMBIENTE IN PRODUZIONE (22 set 2026).
 *
 * I valori di sviluppo esistono SOLO fuori produzione: in produzione una
 * `NEO4J_*` mancante è un errore di configurazione — e per la password è un
 * buco di sicurezza. Meglio non partire che collegarsi «per sbaglio» a
 * localhost con le credenziali di esempio.
 */
describe('in produzione non si parte con i valori di sviluppo', () => {
  it('una variabile mancante fa fallire il caricamento del modulo, e dice QUALE', async () => {
    vi.resetModules()
    vi.stubEnv('NODE_ENV', 'production')
    // Le altre ci sono: manca solo la password, che e' quella che conta di piu'.
    vi.stubEnv('NEO4J_URI', 'neo4j://db:7687')
    vi.stubEnv('NEO4J_USER', 'neo4j')
    vi.stubEnv('NEO4J_PASSWORD', '')
    vi.doMock('neo4j-driver', () => {
      const fake = {
        driver: vi.fn(() => ({ verifyConnectivity: vi.fn().mockResolvedValue(undefined), session: vi.fn(), close: vi.fn() })),
        auth: { basic: vi.fn(() => ({})) }, session: { READ: 'READ', WRITE: 'WRITE' }, isInt: () => false,
      }
      return { default: fake, ...fake }
    })
    await expect(import('../driver.js')).rejects.toThrow(/NEO4J_PASSWORD is not set in production/)
    vi.unstubAllEnvs()
  })
})

/**
 * IL FALLIMENTO DELLA CONNESSIONE (22 set 2026).
 *
 * Un processo che non raggiunge Neo4j non deve venire su «sano» per poi
 * fallire sparpagliato su ogni query successiva: esce, e l'orchestratore lo
 * riavvia. Sotto un test runner no — uscire ucciderebbe il worker di vitest —
 * e allora l'errore si scrive e ogni query fallisce per conto suo.
 */
describe('quando Neo4j non risponde', () => {
  it('sotto test si SCRIVE e non si esce: uccidere il worker nasconderebbe il resto', async () => {
    vi.resetModules()
    // Il test prima ha lasciato `NODE_ENV=production`: qui si torna allo
    // sviluppo, altrimenti il modulo non si carica affatto.
    vi.unstubAllEnvs()
    const errore = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const esci = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    vi.doMock('neo4j-driver', () => {
      const fake = {
        driver: vi.fn(() => ({
          verifyConnectivity: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
          session: vi.fn(), close: vi.fn(),
        })),
        auth: { basic: vi.fn(() => ({})) }, session: { READ: 'READ', WRITE: 'WRITE' }, isInt: () => false,
      }
      return { default: fake, ...fake }
    })
    await import('../driver.js')
    // `verifyConnectivity` è una promessa: si aspetta il giro dopo.
    await new Promise((r) => setImmediate(r))
    expect(errore.mock.calls.flat().join(' ')).toContain('FATAL')
    expect(esci).not.toHaveBeenCalled()
    errore.mockRestore(); esci.mockRestore()
  })
})
