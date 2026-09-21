/**
 * L'indirizzo pubblico dei link in uscita: rumoroso quando serve un link,
 * mai all'import.
 *
 * Prima `appUrl.ts` lanciava all'IMPORT in produzione senza APP_URL, e il
 * worker, che non costruisce link ma importa il pacchetto, cadeva all'avvio.
 * L'API resta protetta all'avvio da `validateConfig('api')` (chiave `appUrl`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

async function freshAppUrl(env: { NODE_ENV: string; APP_URL?: string }) {
  vi.resetModules()
  vi.stubEnv('NODE_ENV', env.NODE_ENV)
  vi.stubEnv('APP_URL', env.APP_URL ?? '')
  return import('../appUrl.js')
}

afterEach(() => { vi.unstubAllEnvs() })

describe('appUrl', () => {
  it('importare il modulo in produzione senza APP_URL non lancia', async () => {
    await expect(freshAppUrl({ NODE_ENV: 'production' })).resolves.toBeDefined()
  })

  it('chiedere il link in produzione senza APP_URL lancia, e nomina la variabile', async () => {
    const m = await freshAppUrl({ NODE_ENV: 'production' })
    expect(() => m.appUrl()).toThrow(/APP_URL is not set in production/)
  })

  it('con APP_URL restituisce quello; fuori produzione il localhost è una comodità', async () => {
    expect((await freshAppUrl({ NODE_ENV: 'production', APP_URL: 'https://app.example.test' })).appUrl()).toBe('https://app.example.test')
    expect((await freshAppUrl({ NODE_ENV: 'development' })).appUrl()).toBe('http://localhost:5173')
  })
})
