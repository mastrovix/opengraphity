/**
 * L'INDIRIZZO A CUI TORNARE DOPO IL LOGIN.
 *
 * Questo file esiste per un 414 (17 set 2026): `redirectUri:
 * window.location.href` portava dentro la risposta del login precedente, e a
 * ogni giro Keycloak ne accodava un'altra — `#state=A&code=A&state=B&code=B` —
 * finché la riga di richiesta superava gli ottomila caratteri e nginx la
 * rifiutava. Il caso che conta è il TERZO: il frammento ANNIDATO, quello che
 * si era già formato.
 */
import { describe, it, expect } from 'vitest'
import { redirectUriPulito } from '../keycloak.js'

describe('redirectUriPulito', () => {
  it('un indirizzo pulito resta identico', () => {
    expect(redirectUriPulito('http://c-one.localhost/settings/catalog-forms'))
      .toBe('http://c-one.localhost/settings/catalog-forms')
  })

  it('toglie la risposta del login dal frammento', () => {
    const sporco = 'http://c-one.localhost/changes#state=21d18e37&session_state=677da93b&code=11227e46'
    expect(redirectUriPulito(sporco)).toBe('http://c-one.localhost/changes')
  })

  it('toglie una risposta ANNIDATA, che è il caso del 414', () => {
    const annidato = 'http://c-one.localhost/x#state=A&code=A&state=B&code=B&iss=https%3A%2F%2Fkc%2Frealms%2Fc-one'
    expect(redirectUriPulito(annidato)).toBe('http://c-one.localhost/x')
  })

  it('è IDEMPOTENTE: il risultato non cresce riapplicandolo', () => {
    // La proprietà che il difetto violava: ripassarci non deve aggiungere niente.
    let uri = 'http://c-one.localhost/x'
    for (let giro = 0; giro < 5; giro++) {
      uri = redirectUriPulito(`${uri}#state=s${giro}&code=c${giro}&session_state=k`)
      expect(uri).toBe('http://c-one.localhost/x')
    }
  })

  it('toglie anche un ERRORE di login, che arriva nello stesso posto', () => {
    expect(redirectUriPulito('http://c-one.localhost/#error=login_required&error_description=nope'))
      .toBe('http://c-one.localhost/')
  })

  it('toglie gli stessi parametri dalla query (`responseMode: "query"`)', () => {
    expect(redirectUriPulito('http://c-one.localhost/x?code=abc&state=def&keep=1'))
      .toBe('http://c-one.localhost/x?keep=1')
  })

  it('un\'ancora VERA resta: è di chi legge, non di Keycloak', () => {
    expect(redirectUriPulito('http://c-one.localhost/kb/articolo#requisiti'))
      .toBe('http://c-one.localhost/kb/articolo#requisiti')
  })

  it('tiene percorso, query e porta: si torna dove si era', () => {
    expect(redirectUriPulito('http://c-one.localhost:8080/incidents?status=open&page=2#state=A'))
      .toBe('http://c-one.localhost:8080/incidents?status=open&page=2')
  })
})
