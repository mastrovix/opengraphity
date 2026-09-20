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
  rigaDelCliente, LOTTO_CLIENTE_CYPHER, MAX_MESSAGGIO,
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

/**
 * I DUE ARCHIVI (20 set 2026, sera).
 *
 * Nati da una domanda del proprietario: «in un tenant cliente, l'admin non
 * può vedere che errori si sono verificati?». Poteva, ma solo dall'ultimo
 * riavvio — e gli errori dei job di sfondo del suo tenant non li vedeva mai,
 * perché nessun browser li riporta e l'anello li perde.
 */
describe('una riga di un cliente va in due posti diversi', () => {
  const rigaCliente = (extra: Record<string, unknown> = {}) =>
    ({ time: ORA, service: 'opengrafo-worker', module: 'sla', msg: 'SLA engine failed on INC00000042', ...extra })

  it('nella diagnostica di piattaforma come TEMPLATE, e in casa sua col testo VERO', async () => {
    const scritte: { piattaforma: unknown[]; cliente: unknown[] }[] = []
    avviaSink(async (righe, delCliente) => {
      scritte.push({ piattaforma: righe, cliente: delCliente })
      return righe.length + delCliente.length
    })
    registraRigaDelServer(rigaCliente(), 'error', 'c-test')
    await fermaSink()

    const [lotto] = scritte
    expect(lotto!.piattaforma).toHaveLength(1)
    expect(lotto!.cliente).toHaveLength(1)
    // Il numero del ticket sparisce dal template di piattaforma…
    expect((lotto!.piattaforma[0] as { template: string }).template).not.toContain('INC00000042')
    // …e resta nella pagina del cliente, che è la sua e a cui serve.
    expect((lotto!.cliente[0] as { message: string }).message).toContain('INC00000042')
  })

  it('una riga SENZA tenant non entra in casa di nessuno', () => {
    // Avvio, code, bus del metamodello: diagnostica di piattaforma e basta.
    expect(rigaDelCliente(rigaCliente(), 'error', null)).toBeNull()
    expect(rigaDelCliente(rigaCliente(), 'error', '')).toBeNull()
  })

  it('e valgono le stesse due esclusioni della piattaforma', () => {
    expect(rigaDelCliente(rigaCliente(), 'info', 'c-test'), 'solo error e fatal').toBeNull()
    expect(rigaDelCliente(rigaCliente({ module: 'server-log-sink' }), 'error', 'c-test'), 'l\'anello').toBeNull()
  })

  it('il messaggio si taglia dichiarando il taglio', () => {
    const r = rigaDelCliente(rigaCliente({ msg: 'x'.repeat(MAX_MESSAGGIO * 2) }), 'error', 'c-test')!
    expect(r.message).toHaveLength(MAX_MESSAGGIO)
    expect(r.message.endsWith('… [troncato]')).toBe(true)
  })

  it('la query del cliente scrive UNA riga per occorrenza, non un aggregato', () => {
    // Il suo amministratore vuole sapere che cosa è successo alle tre di
    // notte, non quante volte in tutto.
    expect(LOTTO_CLIENTE_CYPHER).toContain('CREATE (l:LogEntry {')
    expect(LOTTO_CLIENTE_CYPHER).toContain('tenant_id: r.tenantId')
    expect(LOTTO_CLIENTE_CYPHER).not.toContain('MERGE')
  })
})
