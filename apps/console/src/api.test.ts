/**
 * «[OBJECT OBJECT]» AL POSTO DEL MOTIVO (21 set 2026).
 *
 * `messaggio()` nasce da un difetto vero, trovato provando la console il 17
 * settembre: `updateToken()` di Keycloak rifiuta con `{ error,
 * error_description }` e non con un `Error`, e la pagina mostrava «[object
 * Object]». Su una pagina che CREA e CANCELLA tenant è il peggior messaggio
 * possibile: chi guarda non sa se l'azione è passata.
 *
 * Questi sono i primi test della console, che dal 17 settembre non ne aveva
 * nessuno — e `vitest run` senza test esce con errore, quindi teneva rossa
 * la CI di tutto il repository senza che si vedesse.
 */
import { describe, it, expect, vi } from 'vitest'

// `api.ts` importa Keycloak e il ciclo di rinnovo: qui si prova la funzione
// pura, non il browser attorno.
vi.mock('./keycloak', () => ({ keycloak: { token: 'x', authenticated: true } }))
vi.mock('./tokenRefresh', () => ({ refreshToken: async () => 'x' }))

const { messaggio } = await import('./api')

describe('il motivo di un rifiuto si legge sempre', () => {
  it('un Error porta il suo messaggio', () => {
    expect(messaggio(new Error('tenant già presente'))).toBe('tenant già presente')
  })

  it('una stringa è già il motivo', () => {
    expect(messaggio('non autorizzato')).toBe('non autorizzato')
  })

  it('il rifiuto di Keycloak NON diventa «[object Object]»', () => {
    // La forma vera che arriva da `updateToken()`, ed è il difetto del 17 set.
    const rifiutoDiKeycloak = { error: 'invalid_grant', error_description: 'Session not active' }
    expect(messaggio(rifiutoDiKeycloak)).toBe('Session not active')
    expect(messaggio(rifiutoDiKeycloak)).not.toContain('[object')
  })

  it('senza descrizione resta il codice dell\'errore', () => {
    expect(messaggio({ error: 'invalid_grant' })).toBe('invalid_grant')
  })

  it('`message` viene prima di `error`: è il più specifico dei due', () => {
    expect(messaggio({ message: 'il motivo', error: 'generico' })).toBe('il motivo')
  })
})

describe('quando un motivo non c\'è, lo si DICE', () => {
  // Una forma vuota a schermo fa credere che non sia successo niente.
  it.each([null, undefined, {}, '', new Error(''), 42, { error: '' }])(
    'niente di leggibile in %s → lo dichiara', (e) => {
      expect(messaggio(e)).toBe('Unexpected error (no message)')
    })
})
