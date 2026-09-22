/**
 * THE SCREEN THAT STOPS THE APP.
 *
 * It comes from the suspended tenant: the app received a definitive refusal
 * and reacted as if it were temporary — refresh, retry, back to login —
 * spinning forever. A definitive refusal deserves the opposite: one sentence,
 * and a stop.
 *
 * Two properties hold it up. It writes TEXT and not HTML (F-19), because the
 * detail can come from the network and `innerHTML` would eat a `<` — or
 * worse, let markup in. And it is idempotent, because the polling queries
 * keep coming back refused one after another (the portal has one every
 * thirty seconds) and each refusal calls this again: redrawing every time
 * would make the page flash exactly while it explains that it has stopped.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mostraSchermataDiStop, resetSchermataDiStop } from '../stopScreen.js'

let root: HTMLElement

beforeEach(() => {
  resetSchermataDiStop()
  document.body.replaceChildren()
  root = document.createElement('div')
  document.body.appendChild(root)
})

describe('mostraSchermataDiStop', () => {
  it('replaces the app with a title and a detail, announced as an alert', () => {
    root.append(document.createElement('main'), document.createElement('nav'))
    mostraSchermataDiStop({ root, titolo: 'Accesso sospeso', dettaglio: 'Contatta chi amministra il servizio.' })

    expect(root.querySelector('main')).toBeNull()
    const box = root.firstElementChild!
    expect(box.getAttribute('role')).toBe('alert')       // a screen reader announces it
    expect(box.textContent).toContain('Accesso sospeso')
    expect(box.textContent).toContain('Contatta chi amministra il servizio.')
  })

  it('the text stays TEXT: markup in the detail is not interpreted (F-19)', () => {
    // The detail can carry a message from the server, and `innerHTML` would
    // either swallow a `<` or execute what follows it.
    mostraSchermataDiStop({ root, titolo: '<b>Sospeso</b>', dettaglio: '<img src=x onerror="alert(1)"> a < b' })
    expect(root.querySelector('b')).toBeNull()
    expect(root.querySelector('img')).toBeNull()
    expect(root.textContent).toContain('<b>Sospeso</b>')
    expect(root.textContent).toContain('a < b')
  })

  it('is idempotent: a second refusal does not redraw, so the page does not flash', () => {
    mostraSchermataDiStop({ root, titolo: 'Primo', dettaglio: 'uno' })
    const box = root.firstElementChild
    mostraSchermataDiStop({ root, titolo: 'Secondo', dettaglio: 'due' })
    expect(root.firstElementChild).toBe(box)             // the same node, untouched
    expect(root.textContent).toContain('Primo')
    expect(root.textContent).not.toContain('Secondo')
  })

  it('once shown, it stays shown even for a different root', () => {
    // The two portal shells mount different roots; the app has stopped
    // either way, and drawing a second screen elsewhere says it twice.
    mostraSchermataDiStop({ root, titolo: 'Sospeso', dettaglio: 'x' })
    const other = document.createElement('div')
    mostraSchermataDiStop({ root: other, titolo: 'Sospeso', dettaglio: 'x' })
    expect(other.children).toHaveLength(0)
  })

  it('the reset is for the tests only, and puts it back to "never shown"', () => {
    mostraSchermataDiStop({ root, titolo: 'Uno', dettaglio: 'x' })
    resetSchermataDiStop()
    mostraSchermataDiStop({ root, titolo: 'Due', dettaglio: 'y' })
    expect(root.textContent).toContain('Due')
  })

  it('an empty detail is still a screen: the title alone says what happened', () => {
    mostraSchermataDiStop({ root, titolo: 'Sospeso', dettaglio: '' })
    expect(root.firstElementChild?.getAttribute('role')).toBe('alert')
    expect(root.textContent).toBe('Sospeso')
  })
})
