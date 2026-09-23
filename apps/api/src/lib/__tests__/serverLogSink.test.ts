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
  registraErroreDelBrowser, SERVIZIO_DEL_BROWSER, type RigaDaScrivere,
  azzeraConteggiDelBrowser, BROWSER_REPORTS_PER_PERSON_PER_DAY,
} from '../serverLogSink.js'

const ORA = Date.parse('2026-09-20T11:34:23.632Z')
const riga = (extra: Record<string, unknown> = {}) => ({
  time: ORA, service: 'opengrafo-api', module: 'graphql', msg: 'boom', ...extra,
})

/**
 * Il consenso all'archivio che attraversa i clienti, acceso.
 *
 * Ogni test che si aspetta righe di PIATTAFORMA deve dirlo: da qui in poi
 * l'archivio senza tenant si scrive solo quando qualcuno ha detto di sì, e
 * un test che non lo dice è un test che descrive un prodotto con
 * l'interruttore spento.
 */
const ACCESO = async (): Promise<boolean> => true

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
    avviaSink(scrittore, ACCESO)
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
    avviaSink(async (righe) => { scritte.push(righe); return righe.length }, ACCESO)
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
    }, ACCESO)
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

/**
 * GLI ERRORI DEL BROWSER (20 set 2026, sera tardi).
 *
 * Il progetto li aveva esclusi dagli analisti: «li scrive chiunque abbia un
 * account del portale, senza rate limit». Il freno adesso c'è, e il segnale
 * valeva troppo per lasciarlo morto: 1.230 righe, di cui 1.074 «SSE
 * notification channel down» che nessuna pagina diceva.
 *
 * Ma il messaggio l'ha scritto un BROWSER, cioè un posto dove un utente può
 * aver messo qualunque cosa. Questi test tengono ferma la regola che conta:
 * nell'archivio senza tenant non entra un messaggio grezzo da NESSUNA
 * sorgente.
 */
describe('un errore del browser entra scrubbato, o non entra', () => {
  it('il messaggio diventa un TEMPLATE, come per il server', async () => {
    const scritte: RigaDaScrivere[] = []
    avviaSink(async (righe) => { scritte.push(...righe); return righe.length }, ACCESO)
    registraErroreDelBrowser(
      'Network error caricando /incidents/b69ea861-374e-4aa1-a67f-17b3789154c8 per mario@acme.it',
      'error', '2026-09-20T19:00:00.000Z',
    )
    await fermaSink()
    const t = scritte[0]!.template
    expect(t).not.toContain('mario@acme.it')
    expect(t).not.toContain('b69ea861')
    expect(t).toContain('<email>')
    expect(t).toContain('<uuid>')
  })

  it('e il numero di un ticket nemmeno: è la stessa regola del server', () => {
    const scritte: RigaDaScrivere[] = []
    avviaSink(async (righe) => { scritte.push(...righe); return righe.length }, ACCESO)
    registraErroreDelBrowser('Impossibile chiudere INC00000042', 'error', '2026-09-20T19:00:00.000Z')
    expect(statoDelSink().inAttesa).toBe(1)
  })

  it('si attacca al CI del web, che la migrazione ha censito', async () => {
    // Senza un CI l'evento sarebbe orfano e nessun incident nascerebbe.
    const scritte: RigaDaScrivere[] = []
    avviaSink(async (righe) => { scritte.push(...righe); return righe.length }, ACCESO)
    registraErroreDelBrowser('boom', 'error', '2026-09-20T19:00:00.000Z')
    await fermaSink()
    expect(scritte[0]!.service).toBe(SERVIZIO_DEL_BROWSER)
    expect(scritte[0]!.module).toBe('frontend')
  })

  /*
   * Review of 23 Sep 2026: twenty POSTs of one person opened a critical event
   * on the platform. One person counts at most three times a day per signature.
   */
  it('one person counts at most three times a day for the same error; another person counts again', () => {
    azzeraConteggiDelBrowser()
    avviaSink(async (righe) => righe.length, ACCESO)
    for (let i = 0; i < 10; i++) registraErroreDelBrowser('SSE channel down', 'error', '2026-09-20T19:00:00.000Z', undefined, 't1/u1')
    expect(BROWSER_REPORTS_PER_PERSON_PER_DAY).toBe(3)
    expect(statoDelSink().inAttesa).toBe(3)
    registraErroreDelBrowser('SSE channel down', 'error', '2026-09-20T19:00:00.000Z', undefined, 't1/u2')
    expect(statoDelSink().inAttesa).toBe(4)
    // A different error of the same person is its own count.
    registraErroreDelBrowser('Export failed', 'error', '2026-09-20T19:00:00.000Z', undefined, 't1/u1')
    expect(statoDelSink().inAttesa).toBe(5)
  })

  it('the next day the person counts again', () => {
    azzeraConteggiDelBrowser()
    avviaSink(async (righe) => righe.length, ACCESO)
    for (let i = 0; i < 4; i++) registraErroreDelBrowser('boom', 'error', '2026-09-20T23:00:00.000Z', undefined, 't1/u1')
    registraErroreDelBrowser('boom', 'error', '2026-09-21T00:01:00.000Z', undefined, 't1/u1')
    expect(statoDelSink().inAttesa).toBe(4)
  })

  it('solo gli errori: un `info` del browser non riempie la diagnostica', () => {
    registraErroreDelBrowser('tutto bene', 'info', '2026-09-20T19:00:00.000Z')
    expect(statoDelSink().inAttesa).toBe(0)
  })

  it('un messaggio vuoto non diventa una classe di errore', () => {
    registraErroreDelBrowser('   ', 'error', '2026-09-20T19:00:00.000Z')
    expect(statoDelSink().inAttesa).toBe(0)
  })

  it('e non lancia mai: un log del browser non fa cadere la rotta', () => {
    expect(() => registraErroreDelBrowser(null as unknown as string, 'error', 'x')).not.toThrow()
  })
})

/**
 * IL VARCO SULL'ARCHIVIO CHE ATTRAVERSA I CLIENTI (20 set 2026, rimedio a).
 *
 * Rilievo della revisione, verificato: la RACCOLTA girava anche con
 * `platformSelfAnalysis` spento. L'interruttore governava la lettura e non la
 * scrittura, quindi il prodotto costruiva l'archivio che attraversa il
 * perimetro fra i clienti anche per chi aveva spento tutto.
 *
 * Le due metà della regola, e sono diverse: la riga di PIATTAFORMA ha bisogno
 * del consenso, quella del CLIENTE no — sono i suoi dati, e la sua pagina Log
 * li deve avere comunque.
 */
describe('a interruttore spento l\'archivio di piattaforma non si scrive', () => {
  const SPENTO = async (): Promise<boolean> => false

  it('le righe di piattaforma si buttano, e si CONTANO', async () => {
    const scritte: RigaDaScrivere[] = []
    avviaSink(async (righe) => { scritte.push(...righe); return righe.length }, SPENTO)
    registraRigaDelServer(riga(), 'error')
    await fermaSink()
    expect(scritte).toHaveLength(0)
    // Non è una perdita silenziosa: «stiamo buttando» resta una cosa che si sa.
    expect(statoDelSink().senzaConsenso).toBe(1)
  })

  it('ma la riga del CLIENTE passa lo stesso: è casa sua', async () => {
    const delCliente: unknown[] = []
    avviaSink(async (righe, suoi) => { delCliente.push(...suoi); return righe.length + suoi.length }, SPENTO)
    registraRigaDelServer(riga({ msg: 'SLA engine failed' }), 'error', 'c-test')
    await fermaSink()
    expect(delCliente).toHaveLength(1)
    expect(statoDelSink().senzaConsenso).toBe(1)
  })

  it('se il consenso non si può CHIEDERE, la risposta è no', async () => {
    // Database giù, tenant di piattaforma assente: un archivio che attraversa
    // il perimetro si costruisce su un sì, non sull'impossibilità di chiedere.
    const scritte: RigaDaScrivere[] = []
    avviaSink(
      async (righe) => { scritte.push(...righe); return righe.length },
      async () => { throw new Error('Neo4j irraggiungibile') },
    )
    registraRigaDelServer(riga(), 'error')
    await fermaSink()
    expect(scritte).toHaveLength(0)
    expect(statoDelSink().senzaConsenso).toBe(1)
    // E non è contato come un GUASTO del sink: il sink ha funzionato.
    expect(statoDelSink().fallimenti).toBe(0)
  })

  it('senza predicato vale no: uno script che non dichiara il consenso non archivia', async () => {
    const scritte: RigaDaScrivere[] = []
    avviaSink(async (righe) => { scritte.push(...righe); return righe.length })
    registraRigaDelServer(riga(), 'error')
    await fermaSink()
    expect(scritte).toHaveLength(0)
  })

  it('anche l\'errore del BROWSER passa dal varco', async () => {
    const scritte: RigaDaScrivere[] = []
    avviaSink(async (righe) => { scritte.push(...righe); return righe.length }, SPENTO)
    registraErroreDelBrowser('boom', 'error', '2026-09-20T19:00:00.000Z')
    await fermaSink()
    expect(scritte).toHaveLength(0)
  })
})
