/**
 * IL LUCCHETTO DELL'ANALISI (20 set 2026, rimedio c).
 *
 * Rilievo della revisione, verificato per grep: `enqueueProposalScan` — la
 * funzione che PORTAVA il lock — aveva zero chiamanti, mentre il commento in
 * `resolvers/proposals.ts` diceva «per il click basta il lock, che è il
 * `jobId` per minuto». Il lock esisteva, il cammino che lo usava no: due
 * click ravvicinati facevano partire tre chiamate al modello due volte.
 *
 * Tre regole, e la terza è quella su cui è facile sbagliare:
 * si prende una volta sola; si rilascia alla fine anche se il lavoro cade;
 * e se Redis non risponde si PROCEDE — qui si protegge un costo, non il dato
 * di un cliente, e rinunciare all'analisi sarebbe spegnere la funzione per
 * salvare un'ottimizzazione.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/** Un Redis finto con la semantica che conta: SET NX EX, GET, DEL. */
const chiavi = new Map<string, string>()
const redis = {
  rotto: false,
  set: vi.fn(async (k: string, v: string, _ex: string, _s: number, nx: string) => {
    if (redis.rotto) throw new Error('Redis irraggiungibile')
    if (nx === 'NX' && chiavi.has(k)) return null
    chiavi.set(k, v)
    return 'OK'
  }),
  get: vi.fn(async (k: string) => chiavi.get(k) ?? null),
  del: vi.fn(async (k: string) => { chiavi.delete(k); return 1 }),
}

vi.mock('../../lib/bullmq.js', () => ({
  getSharedRedis: () => redis,
  getQueue:  () => ({ add: async () => undefined }),
  createWorker: () => ({}),
}))
vi.mock('@opengraphity/neo4j', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSession: () => ({ executeRead: async () => ({ records: [] }), close: async () => undefined }),
}))

const { conIlLucchetto, LUCCHETTO_SECONDI } = await import('../proposalScanner.js')

beforeEach(() => { chiavi.clear(); redis.rotto = false; vi.clearAllMocks() })

describe('due giri sullo stesso cliente non partono insieme', () => {
  it('il secondo riceve `null` e non esegue niente', async () => {
    let dentro = 0
    const lento = async () => {
      dentro++
      // Mentre il primo lavora, il secondo prova: è il caso vero (due click).
      const secondo = await conIlLucchetto('c-test', async () => { dentro++; return 'ho girato' })
      expect(secondo).toBeNull()
      return 'primo'
    }
    expect(await conIlLucchetto('c-test', lento)).toBe('primo')
    expect(dentro).toBe(1)
  })

  it('clienti diversi non si bloccano a vicenda', async () => {
    const uno = await conIlLucchetto('c-uno', async () =>
      conIlLucchetto('c-due', async () => 'due'))
    expect(uno).toBe('due')
  })

  it('finito il primo, il secondo può girare', async () => {
    await conIlLucchetto('c-test', async () => 'a')
    expect(await conIlLucchetto('c-test', async () => 'b')).toBe('b')
  })
})

describe('il rilascio', () => {
  it('avviene anche se il lavoro FALLISCE: un errore non blocca il cliente per sempre', async () => {
    await expect(conIlLucchetto('c-test', () => Promise.reject(new Error('analista rotto'))))
      .rejects.toThrow('analista rotto')
    expect(chiavi.size).toBe(0)
    expect(await conIlLucchetto('c-test', async () => 'dopo')).toBe('dopo')
  })

  it('rilascia SOLO il proprio: dopo la scadenza il lucchetto può essere di un altro', async () => {
    await conIlLucchetto('c-test', async () => {
      // Qualcun altro riscrive la chiave: il lucchetto era scaduto ed è suo.
      chiavi.set('proposal-scan-lock:c-test', 'token-di-un-altro')
      return 'x'
    })
    // Non lo abbiamo cancellato: sarebbe rimasto scoperto mentre l'altro lavora.
    expect(chiavi.get('proposal-scan-lock:c-test')).toBe('token-di-un-altro')
    expect(redis.del).not.toHaveBeenCalled()
  })

  it('ha una scadenza: un processo che muore non blocca il cliente per sempre', async () => {
    await conIlLucchetto('c-test', async () => 'x')
    expect(redis.set).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'EX', LUCCHETTO_SECONDI, 'NX')
  })
})

describe('quando Redis non risponde', () => {
  it('si PROCEDE: qui si protegge un costo, non il dato di un cliente', async () => {
    // È il verso OPPOSTO al varco dell'archivio (rimedio a), e apposta: là
    // si protegge il perimetro fra i clienti, qui solo una spesa doppia.
    redis.rotto = true
    expect(await conIlLucchetto('c-test', async () => 'girato lo stesso')).toBe('girato lo stesso')
  })
})
