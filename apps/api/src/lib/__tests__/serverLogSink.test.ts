/**
 * LE REGOLE DEL SINK (20 set 2026, ondata 3).
 *
 * Non provano che Neo4j scriva — quello lo prova il deploy. Provano le
 * regole che, se saltano, fanno danni silenziosi:
 *
 *  - non si persiste tutto (il fossile di aprile era per l'86% rumore);
 *  - il sink non parla di sé stesso (l'anello);
 *  - una riga di log non può far cadere il gesto che l'ha prodotta;
 *  - quando il database è giù, il sink perde righe invece di mangiarsi la
 *    memoria del processo che doveva osservare;
 *  - nel grafo non finisce mai il messaggio grezzo.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  rigaDaLog, registraRigaDelServer, svuota, avviaSink, fermaSink, statoDelSink, azzeraSink,
  LIVELLI_PERSISTITI, MODULI_ESCLUSI, MAX_IN_ATTESA, LOTTO_CYPHER,
} from '../serverLogSink.js'

const ORA = Date.parse('2026-09-20T11:34:23.632Z')
const riga = (extra: Record<string, unknown> = {}) => ({
  time: ORA, service: 'opengrafo-api', module: 'graphql', msg: 'boom', ...extra,
})

beforeEach(() => { azzeraSink() })

describe('che cosa si persiste, e che cosa no', () => {
  it('solo error e fatal', () => {
    expect(LIVELLI_PERSISTITI).toEqual(new Set(['error', 'fatal']))
    expect(rigaDaLog(riga(), 'error')).not.toBeNull()
    expect(rigaDaLog(riga(), 'fatal')).not.toBeNull()
    for (const basso of ['info', 'warn', 'debug', 'trace']) {
      expect(rigaDaLog(riga(), basso), `«${basso}» non va nel grafo`).toBeNull()
    }
  })

  it('l\'anello: il sink e il connettore non finiscono nel proprio archivio', () => {
    for (const modulo of MODULI_ESCLUSI) {
      expect(rigaDaLog(riga({ module: modulo }), 'error'), modulo).toBeNull()
    }
  })
})

describe('la riga che finisce nel grafo', () => {
  it('porta il TEMPLATE, mai il messaggio grezzo', () => {
    const r = rigaDaLog(riga({ msg: 'utente mario@acme.it non trovato' }), 'error')!
    expect(r.template).not.toContain('mario@acme.it')
    expect(r.template).toBe('utente <email> non trovato')
  })

  it('porta il `service`, che `bufferLog` invece butta via', () => {
    // Era il difetto chiuso da serviceName.ts nei log di Loki: tre processi
    // indistinguibili. Ripeterlo nel grafo sarebbe stato comico.
    expect(rigaDaLog(riga({ service: 'opengrafo-events-worker' }), 'error')!.service)
      .toBe('opengrafo-events-worker')
  })

  it('il giorno è la chiave insieme alla firma', () => {
    const r = rigaDaLog(riga(), 'error')!
    expect(r.day).toBe('2026-09-20')
    expect(r.timestamp).toBe('2026-09-20T11:34:23.632Z')
  })

  it('due errori uguali in giorni diversi: stessa firma, giorni diversi', () => {
    const a = rigaDaLog(riga(), 'error')!
    const b = rigaDaLog(riga({ time: ORA + 86_400_000 }), 'error')!
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(a.day).not.toBe(b.day)
  })

  it('prende lo stack da `err.stack` e da `stack` nudo, e ne tiene una riga sola', () => {
    const daErr  = rigaDaLog(riga({ err: { stack: 'Error: x\n    at f (/app/a.js:1:2)' } }), 'error')!
    const daNudo = rigaDaLog(riga({ stack: 'Error: x\n    at f (/app/a.js:1:2)' }), 'error')!
    expect(daErr.stackHead).toContain('at f')
    expect(daNudo.stackHead).toContain('at f')
    expect(daErr.stackHead).not.toContain('\n')
  })

  it('senza stack, `null` — non una stringa vuota', () => {
    expect(rigaDaLog(riga(), 'error')!.stackHead).toBeNull()
  })
})

describe('la coda', () => {
  it('una riga malformata non lancia: un log non fa cadere chi lo ha scritto', () => {
    expect(() => registraRigaDelServer(null as unknown as Record<string, unknown>, 'error')).not.toThrow()
    expect(() => registraRigaDelServer({ time: 'non un numero' }, 'error')).not.toThrow()
  })

  it('oltre il tetto scarta la PIÙ VECCHIA e lo conta', () => {
    for (let i = 0; i < MAX_IN_ATTESA + 10; i++) registraRigaDelServer(riga({ msg: `e${i}` }), 'error')
    expect(statoDelSink().inAttesa).toBe(MAX_IN_ATTESA)
    expect(statoDelSink().scartate).toBe(10)
  })

  it('quando il database è giù perde le righe invece di crescere all\'infinito', async () => {
    // Rimetterle in coda vuol dire che il sink dei log uccide il processo che
    // doveva osservare, proprio mentre quel processo è già in difficoltà.
    const scrittore = vi.fn().mockRejectedValue(new Error('Neo4j irraggiungibile'))
    avviaSink(scrittore)
    registraRigaDelServer(riga(), 'error')
    registraRigaDelServer(riga({ msg: 'altro' }), 'error')
    await svuota()
    expect(statoDelSink().inAttesa).toBe(0)
    expect(statoDelSink().scartate).toBe(2)
    expect(statoDelSink().fallimenti).toBe(1)
    expect(statoDelSink().ultimoErrore).toContain('Neo4j irraggiungibile')
    await fermaSink()
  })

  it('lo spegnimento scrive quello che resta', async () => {
    const scritte: unknown[][] = []
    avviaSink(async (righe) => { scritte.push(righe); return righe.length })
    registraRigaDelServer(riga(), 'error')
    await fermaSink()
    expect(scritte).toHaveLength(1)
    expect(statoDelSink().scritte).toBe(1)
    expect(statoDelSink().inAttesa).toBe(0)
  })

  it('senza scrittore collegato non succede niente: è il caso dei test e degli script', async () => {
    registraRigaDelServer(riga(), 'error')
    await svuota()
    expect(statoDelSink().inAttesa).toBe(1)
    expect(statoDelSink().fallimenti).toBe(0)
  })
})

describe('la query del lotto', () => {
  it('è un MERGE su (firma, giorno), e il conteggio si incrementa senza rileggere', () => {
    expect(LOTTO_CYPHER).toContain('MERGE (l:ServerLogEntry {fingerprint: r.fingerprint, day: r.day})')
    expect(LOTTO_CYPHER).toContain('l.count = l.count + 1')
    // `count` parte da 0 ON CREATE e il SET lo porta a 1: un solo posto che
    // incrementa, così una riga non vale due.
    expect(LOTTO_CYPHER).toContain('l.count = 0')
  })

  it('non scrive nessun campo che l\'allowlist non prevede', () => {
    // L'allowlist del progetto: timestamp, livello, modulo, template, stack.
    // Più servizio, firma e giorno, che sono la chiave. `tenant_id` NON c'è,
    // ed è la decisione 3 in testa a serverLogSink.ts.
    expect(LOTTO_CYPHER).not.toContain('tenant_id')
    expect(LOTTO_CYPHER).not.toContain('message')
    expect(LOTTO_CYPHER).not.toMatch(/\bl\.data\b/)
  })
})
