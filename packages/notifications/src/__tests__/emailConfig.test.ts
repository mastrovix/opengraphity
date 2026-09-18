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

async function freshEmailModule(env: { NODE_ENV?: string; RESEND_API_KEY?: string; EMAIL_FROM?: string; EMAIL_SEND_DISABLED?: string }) {
  vi.resetModules()
  vi.stubEnv('NODE_ENV', env.NODE_ENV ?? 'test')
  vi.stubEnv('RESEND_API_KEY', env.RESEND_API_KEY ?? '')
  vi.stubEnv('EMAIL_FROM', env.EMAIL_FROM ?? '')
  vi.stubEnv('EMAIL_SEND_DISABLED', env.EMAIL_SEND_DISABLED ?? '')
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

/** Verifica «Cosa resta cablato», ondata 1: il mittente non ricade più in silenzio su un indirizzo di prova. */
describe('email: il mittente mancante in produzione', () => {
  it('assertEmailConfigured lancia in produzione senza EMAIL_FROM, anche con la chiave', async () => {
    const m = await freshEmailModule({ NODE_ENV: 'production', RESEND_API_KEY: 're_test' })
    expect(() => m.assertEmailConfigured()).toThrow(/EMAIL_FROM is not set in production/)
  })

  it('con chiave e mittente in produzione non lancia', async () => {
    const m = await freshEmailModule({ NODE_ENV: 'production', RESEND_API_KEY: 're_test', EMAIL_FROM: 'Acme IT <it@acme.example>' })
    expect(() => m.assertEmailConfigured()).not.toThrow()
  })
})

/**
 * `EMAIL_SEND_DISABLED=true`: spento PER SCELTA, che è il contrario di
 * «configurato male» (18 set 2026).
 *
 * La distinzione è tutta qui: una chiave che manca è un errore e deve fermare
 * l'avvio; una posta spenta è una decisione e deve funzionare — anche in
 * produzione, anche senza chiave, perché pretendere la configurazione della
 * posta per poterla spegnere è una richiesta senza motivo.
 *
 * E deve PARLARE: l'unico modo in cui un interruttore così fa danno è che
 * qualcuno scopra fra sei mesi che le notifiche non uscivano.
 */
describe('email: spenta per scelta', () => {
  it('in produzione e senza chiave NON lancia: non manca niente', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const m = await freshEmailModule({ NODE_ENV: 'production', EMAIL_SEND_DISABLED: 'true' })
    expect(() => m.assertEmailConfigured()).not.toThrow()
    warn.mockRestore()
  })

  it('lo ANNUNCIA all\'avvio, e anche in produzione', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await freshEmailModule({ NODE_ENV: 'production', EMAIL_SEND_DISABLED: 'true' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EMAIL_SEND_DISABLED=true'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sends NO email'))
    warn.mockRestore()
  })

  it('ogni messaggio lascia una riga con destinatario e oggetto, e dice PERCHÉ', async () => {
    // Senza il motivo nella riga, chi legge i log di uno stack muto deve
    // andare a cercare in un file di configurazione.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const m = await freshEmailModule({ NODE_ENV: 'production', EMAIL_SEND_DISABLED: 'true' })
    await m.sendEmail({ to: 'chi@example.com', subject: 'Daily IT digest', html: '<p>x</p>' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[email:disabled]'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('EMAIL_SEND_DISABLED'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('chi@example.com'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Daily IT digest'))
    log.mockRestore(); warn.mockRestore()
  })

  it('con la chiave configurata resta spenta: vince l\'interruttore', async () => {
    // Il caso di chi spegne la posta su uno stage che ha le credenziali vere:
    // se vincesse la chiave, l\'interruttore non servirebbe a niente.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const m = await freshEmailModule({
      NODE_ENV: 'production', EMAIL_SEND_DISABLED: 'true',
      RESEND_API_KEY: 're_chiave_finta', EMAIL_FROM: 'OpenGrafo <no@example.com>',
    })
    await m.sendEmail({ to: 'chi@example.com', subject: 's', html: 'h' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[email:disabled]'))
    log.mockRestore(); warn.mockRestore()
  })

  it('a `false` il contratto di prima è INTATTO: in produzione senza chiave si lancia', async () => {
    const m = await freshEmailModule({ NODE_ENV: 'production', EMAIL_SEND_DISABLED: 'false' })
    expect(() => m.assertEmailConfigured()).toThrow(/RESEND_API_KEY is not set in production/)
  })

  it('un valore che non si capisce impedisce l\'IMPORT: non si manda posta per un errore di battitura', async () => {
    await expect(freshEmailModule({ NODE_ENV: 'production', EMAIL_SEND_DISABLED: 'ture' }))
      .rejects.toThrow(/must be true or false/)
  })
})
