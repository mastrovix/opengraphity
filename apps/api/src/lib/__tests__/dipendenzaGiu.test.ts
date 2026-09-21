/**
 * IL PRIMO RIMEDIO TROVATO DAL PRODOTTO SU SÉ STESSO (21 set 2026).
 *
 * L'Autoanalisi ha aperto `PRB00000002`; il fascicolo indicava `bullmq`; il
 * grep che il fascicolo stesso scrive ha portato a `lib/bullmq.ts`, dove tre
 * gestori d'errore scrivevano un `log.error` A OGNI TENTATIVO. Un guasto
 * solo di Redis ha prodotto 952 righe in un giorno su tre processi, e nessuna
 * riga ha mai detto quando è rientrato.
 *
 * Questi test tengono ferme le due cose che rendono il rimedio onesto: la
 * prima caduta si grida SEMPRE, e le ripetizioni taciute si CONTANO — non
 * spariscono.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  guastoDi, ripresaDi, eGiu, scordaGliStati, INTERVALLO_PROMEMORIA,
} from '../dipendenzaGiu.js'

const finto = () => {
  const righe: { livello: string; campi: Record<string, unknown>; msg: string }[] = []
  const f = (livello: string) => (campi: Record<string, unknown>, msg: string) =>
    { righe.push({ livello, campi, msg }) }
  return { log: { error: vi.fn(f('error')), warn: vi.fn(f('warn')), info: vi.fn(f('info')) }, righe }
}
const err = new Error('getaddrinfo ENOTFOUND redis')

beforeEach(() => { scordaGliStati() })

describe('la prima caduta si grida sempre', () => {
  it('esce a error, con l\'errore intero', () => {
    const { log, righe } = finto()
    guastoDi(log as never, 'redis', err, { queue: 'q1' }, 1000)
    expect(righe).toHaveLength(1)
    expect(righe[0]?.livello).toBe('error')
    expect(righe[0]?.campi['err']).toBe(err)
    expect(righe[0]?.campi['queue']).toBe('q1')
    expect(eGiu('redis')).toBe(true)
  })
})

describe('le ripetizioni si tacciono, ma si contano', () => {
  it('cento cadute uguali scrivono UNA riga, non cento', () => {
    const { log, righe } = finto()
    for (let i = 0; i < 100; i++) guastoDi(log as never, 'redis', err, {}, 1000 + i)
    expect(righe).toHaveLength(1)
  })

  it('e il conto esce nella riga di ripresa: niente sparisce', () => {
    const { log, righe } = finto()
    for (let i = 0; i < 100; i++) guastoDi(log as never, 'redis', err, {}, 1000 + i)
    ripresaDi(log as never, 'redis', {}, 1000 + 30_000)
    const ripresa = righe.at(-1)
    expect(ripresa?.livello).toBe('warn')
    expect(ripresa?.campi['taciute']).toBe(99)
    expect(ripresa?.campi['secondi']).toBe(30)
    expect(ripresa?.msg).toContain('back up after 30s')
  })

  it('un guasto LUNGO non diventa silenzio: un promemoria ogni minuto', () => {
    const { log, righe } = finto()
    guastoDi(log as never, 'redis', err, {}, 0)
    guastoDi(log as never, 'redis', err, {}, INTERVALLO_PROMEMORIA - 1)
    expect(righe).toHaveLength(1)
    guastoDi(log as never, 'redis', err, {}, INTERVALLO_PROMEMORIA)
    expect(righe).toHaveLength(2)
    expect(righe[1]?.msg).toContain('STILL down')
    expect(righe[1]?.campi['taciute']).toBe(2)
  })
})

describe('la ripresa', () => {
  it('non si annuncia se non era mai caduto: `ready` arriva anche all\'avvio', () => {
    // Un prodotto che dice «rientrato» quando non era successo niente
    // insegna a non fidarsi di quella riga.
    const { log, righe } = finto()
    ripresaDi(log as never, 'redis', {}, 1000)
    expect(righe).toHaveLength(0)
  })

  it('rimette lo stato a su: la caduta dopo torna a gridare', () => {
    const { log, righe } = finto()
    guastoDi(log as never, 'redis', err, {}, 0)
    ripresaDi(log as never, 'redis', {}, 1000)
    expect(eGiu('redis')).toBe(false)
    guastoDi(log as never, 'redis', err, {}, 2000)
    expect(righe.filter((r) => r.livello === 'error')).toHaveLength(2)
  })

  it('due riprese di fila non scrivono due righe', () => {
    const { log, righe } = finto()
    guastoDi(log as never, 'redis', err, {}, 0)
    ripresaDi(log as never, 'redis', {}, 1000)
    ripresaDi(log as never, 'redis', {}, 1100)
    expect(righe.filter((r) => r.livello === 'warn')).toHaveLength(1)
  })
})

describe('ogni dipendenza ha il suo stato', () => {
  it('la coda giù non zittisce il worker', () => {
    // Il caso vero del 20 set: tre processi, e ognuno deve dire la sua.
    const { log, righe } = finto()
    guastoDi(log as never, 'bullmq:queue:notifications', err, {}, 0)
    guastoDi(log as never, 'bullmq:worker:events', err, {}, 0)
    expect(righe).toHaveLength(2)
    expect(eGiu('bullmq:queue:notifications')).toBe(true)
    expect(eGiu('bullmq:worker:events')).toBe(true)
  })
})
