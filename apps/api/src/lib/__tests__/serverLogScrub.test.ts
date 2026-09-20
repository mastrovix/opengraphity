/**
 * LE REGOLE DELLO SCRUBBING (20 set 2026, ondata 3).
 *
 * Questo è il guardiano della decisione più delicata dell'ondata: persistere
 * i log del server vuol dire costruire un archivio che attraversa il
 * perimetro fra i clienti. La difesa è che la riga grezza non viene MAI
 * scritta — quindi questi test non provano una preferenza di formato,
 * provano che ogni categoria di dato identificante sparisce prima del grafo.
 *
 * Se uno di questi cade, non si aggiusta il test: si aggiusta la regola.
 */
import { describe, it, expect } from 'vitest'
import {
  normalizzaMessaggio, primaRigaDiStack, firmaDi, SEGNAPOSTO, MAX_TEMPLATE, MAX_STACK_HEAD,
} from '../serverLogScrub.js'

const t = (s: string) => normalizzaMessaggio(s).template

describe('quello che non deve arrivare nel grafo', () => {
  it.each([
    ['un indirizzo di posta', 'login failed for mario.rossi@cliente.example.com', SEGNAPOSTO.email],
    ['un URL',                'webhook POST https://hooks.cliente.it/a/b?token=x fallita', SEGNAPOSTO.url],
    ['un id',                 'incident b69ea861-374e-4aa1-a67f-17b3789154c8 non trovato', SEGNAPOSTO.uuid],
    ['un indirizzo IP',       'connessione rifiutata da 10.14.3.201', SEGNAPOSTO.ip],
    ['una data intera',       'job saltato alle 2026-09-20T11:34:23.632Z', SEGNAPOSTO.ts],
    ['un numero',             'timeout dopo 30000 ms', SEGNAPOSTO.num],
    ['una stringa citata',    "campo 'nome_del_cliente' mancante", SEGNAPOSTO.str],
  ])('%s diventa %s', (_nome, riga, segnaposto) => {
    const uscita = t(riga)
    expect(uscita).toContain(segnaposto)
  })

  it('nessun frammento del valore originale sopravvive', () => {
    const uscita = t('utente anna.bianchi@acme.it su https://acme.example/ticket/8812 da 192.168.9.4')
    for (const pezzo of ['anna.bianchi', 'acme.it', 'acme.example', '8812', '192.168']) {
      expect(uscita, `«${pezzo}» è rimasto in «${uscita}»`).not.toContain(pezzo)
    }
  })

  it('un token esadecimale lungo non passa per parola', () => {
    expect(t('firma non valida: 9fd860f5a1b2c3d4')).toContain(SEGNAPOSTO.hex)
  })
})

describe('il template è la FORMA, non il contenuto', () => {
  it('due occorrenze dello stesso errore danno lo stesso template', () => {
    const a = t('Variable `previousTeamName` not defined (line 30, column 16 (offset: 1252))')
    const b = t('Variable `unassignedUserName` not defined (line 7, column 3 (offset: 88))')
    expect(a).toBe(b)
    // Ed è ancora leggibile: chi lo guarda capisce che errore è.
    expect(a).toBe('Variable <str> not defined (line <n>, column <n> (offset: <n>))')
  })

  it('due errori diversi NON collassano nello stesso template', () => {
    expect(t('Variable `x` not defined')).not.toBe(t('Unknown function `x`'))
  })

  it('conta quante sostituzioni ha fatto: zero = frase costante del codice', () => {
    expect(normalizzaMessaggio('Neo4j non raggiungibile').sostituzioni).toBe(0)
    expect(normalizzaMessaggio('utente 12 su 34').sostituzioni).toBe(2)
  })

  it('gli spazi si normalizzano, così un a capo non fa due classi di errore', () => {
    expect(t('a\n  b\t c')).toBe('a b c')
  })
})

describe('il tetto sulla lunghezza', () => {
  it('un payload loggato per sbaglio viene tagliato, e la riga lo dichiara', () => {
    const lungo = `errore ${'x'.repeat(MAX_TEMPLATE * 2)}`
    const r = normalizzaMessaggio(lungo)
    expect(r.tagliato).toBe(true)
    expect(r.template.length).toBe(MAX_TEMPLATE + 1) // + il carattere di taglio
    expect(r.template.endsWith('…')).toBe(true)
  })

  it('una frase normale non è tagliata', () => {
    expect(normalizzaMessaggio('connessione persa').tagliato).toBe(false)
  })
})

describe('la prima riga di stack', () => {
  it('tiene il LUOGO, non il messaggio', () => {
    const stack = 'Error: qualcosa\n    at scriviProposta (/app/dist/lib/proposals.js:120:15)\n    at altro (/app/x.js:1:1)'
    const riga = primaRigaDiStack(stack)
    expect(riga).toContain('scriviProposta')
    expect(riga).not.toContain('Error: qualcosa')
    // E passa comunque dallo scrubbing: riga e colonna sono numeri.
    expect(riga).toContain(SEGNAPOSTO.num)
  })

  it('senza righe `at` prende la prima, sempre scrubbata', () => {
    expect(primaRigaDiStack('rotto su 10.0.0.1')).toContain(SEGNAPOSTO.ip)
  })

  it('niente stack, niente riga — non una stringa vuota travestita', () => {
    expect(primaRigaDiStack(undefined)).toBeNull()
    expect(primaRigaDiStack('')).toBeNull()
    expect(primaRigaDiStack('   ')).toBeNull()
    expect(primaRigaDiStack({ non: 'una stringa' })).toBeNull()
  })

  it('ha un tetto suo', () => {
    const riga = primaRigaDiStack(`at ${'q'.repeat(MAX_STACK_HEAD * 2)}`)
    expect(riga!.length).toBeLessThanOrEqual(MAX_STACK_HEAD + 1)
  })
})

describe('la firma', () => {
  it('stessa classe di errore, stessa firma', () => {
    const parti = { service: 'opengrafo-api', module: 'graphql', level: 'error', template: 'Variable <str> not defined' }
    expect(firmaDi(parti)).toBe(firmaDi({ ...parti }))
  })

  it.each(['service', 'module', 'level', 'template'] as const)('cambiare %s cambia la firma', (campo) => {
    const parti = { service: 'opengrafo-api', module: 'graphql', level: 'error', template: 'x' }
    expect(firmaDi({ ...parti, [campo]: 'altro' })).not.toBe(firmaDi(parti))
  })

  it('NON contiene il tenant: lo stesso guasto su tre clienti è un guasto solo', () => {
    // Se la firma portasse il tenant, lo stesso bug aprirebbe tre incident
    // sullo stesso CI di piattaforma. La firma è una classe di errore.
    const f = firmaDi({ service: 's', module: 'm', level: 'error', template: 'boom' })
    expect(f).toHaveLength(32)
    expect(f).toMatch(/^[0-9a-f]{32}$/)
  })
})

/**
 * I NUMERI DEI TICKET (20 set 2026, sera).
 *
 * Difetto trovato da un test scritto per un'altra cosa: la regola sui numeri
 * pretende un confine di parola, e in `INC00000042` le cifre sono attaccate
 * alle lettere. Quindi il numero di un ticket di un cliente entrava nel
 * template — cioè nell'unico archivio che attraversa i clienti.
 */
describe('un identificativo con le lettere attaccate alle cifre', () => {
  it.each(['INC00000042', 'CHG00000003', 'PRB00012', 'SRV-001', 'srv_042'])(
    '«%s» non passa', (id) => {
      expect(t(`qualcosa su ${id} è andato storto`)).not.toContain(id)
      expect(t(`qualcosa su ${id} è andato storto`)).toContain(SEGNAPOSTO.id)
    })

  it('il messaggio vero che l\'ha fatto scoprire', () => {
    expect(t('SLA engine failed on INC00000042')).toBe('SLA engine failed on <id>')
  })

  it('ma una parola con una cifra sola resta quella che è', () => {
    // `utf8`, `p90`: due lettere e DUE cifre come minimo.
    expect(t('codifica utf8 con p90 alto')).toBe('codifica utf8 con p90 alto')
  })
})
