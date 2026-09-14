/**
 * La chiave del servizio e-mail: rumorosa dove si invia, muta dove non si invia.
 *
 * Prima il controllo era all'IMPORT del modulo: in produzione, senza
 * RESEND_API_KEY, importare `@opengraphity/notifications` faceva cadere il
 * processo. I worker non inviano e-mail, ma lo importano (il canale delle
 * notifiche in-app, l'elenco delle migrazioni): sono entrati in un ciclo di
 * riavvii al primo deploy dell'ondata 5.
 *
 * Il contratto adesso:
 * - importare il modulo non lancia mai;
 * - `assertEmailConfigured()` lancia in produzione senza chiave (l'API la
 *   chiama all'avvio: la configurazione sbagliata si vede subito);
 * - `sendEmail` lancia in produzione senza chiave, invece di finire nel mock.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

async function freshEmailModule(env: { NODE_ENV?: string; RESEND_API_KEY?: string }) {
  vi.resetModules()
  vi.stubEnv('NODE_ENV', env.NODE_ENV ?? 'test')
  vi.stubEnv('RESEND_API_KEY', env.RESEND_API_KEY ?? '')
  return import('../email.js')
}

afterEach(() => { vi.unstubAllEnvs() })

describe('email: la chiave mancante in produzione', () => {
  it('importare il modulo non lancia (un processo che non invia deve poter partire)', async () => {
    await expect(freshEmailModule({ NODE_ENV: 'production' })).resolves.toBeDefined()
  })

  it('assertEmailConfigured lancia in produzione senza chiave, e nomina la variabile', async () => {
    const m = await freshEmailModule({ NODE_ENV: 'production' })
    expect(() => m.assertEmailConfigured()).toThrow(/RESEND_API_KEY is not set in production/)
  })

  it('sendEmail lancia in produzione senza chiave (mai il mock in silenzio)', async () => {
    const m = await freshEmailModule({ NODE_ENV: 'production' })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await expect(m.sendEmail({ to: 'a@example.com', subject: 's', html: 'h' })).rejects.toThrow(/RESEND_API_KEY is not set in production/)
    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('fuori produzione il mock resta una comodità di sviluppo', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const m = await freshEmailModule({ NODE_ENV: 'development' })
    expect(() => m.assertEmailConfigured()).not.toThrow()
    await expect(m.sendEmail({ to: 'a@example.com', subject: 's', html: 'h' })).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[email:mock]'))
    warn.mockRestore(); log.mockRestore()
  })
})
