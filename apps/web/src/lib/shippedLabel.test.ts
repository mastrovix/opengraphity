import { describe, it, expect, afterEach } from 'vitest'
import i18n from '@/i18n/i18n'
import { shippedLabel } from './shippedLabel'
import { transitionErrorText } from './transitionError'

afterEach(async () => { await i18n.changeLanguage('en') })

describe('shippedLabel — le etichette dei campi spediti nella lingua di chi guarda', () => {
  it('un campo con l\'etichetta spedita si legge tradotto', async () => {
    expect(shippedLabel('field', 'title', 'Title')).toBe('Title')
    await i18n.changeLanguage('it')
    expect(shippedLabel('field', 'title', 'Title')).toBe('Titolo')
    expect(shippedLabel('relation', 'dependencies', 'Dependencies')).toBe('Dipendenze')
  })

  it('un\'etichetta rinominata dal cliente resta sua, in qualunque lingua', async () => {
    await i18n.changeLanguage('it')
    expect(shippedLabel('field', 'title', 'Oggetto della segnalazione')).toBe('Oggetto della segnalazione')
    expect(shippedLabel('field', 'zona', 'Zona di rete')).toBe('Zona di rete')
    expect(shippedLabel('field', 'title', null)).toBe('title')
  })
})

describe('transitionErrorText — un rifiuto del workflow nella lingua di chi guarda', () => {
  it('la chiave dell\'API vince sul messaggio inglese', async () => {
    await i18n.changeLanguage('it')
    expect(transitionErrorText({ error: 'Concurrent transition', errorKey: 'errors.workflow.concurrentTransition', errorParams: null }, 'x'))
      .toBe('Qualcun altro ha spostato questo ticket nel frattempo: ricarica la pagina e riprova.')
    expect(transitionErrorText({ error: 'n/a', errorKey: 'errors.workflow.transitionSystemOnly', errorParams: [{ name: 'step', value: 'closed' }] }, 'x'))
      .toContain('«closed»')
  })

  it('senza chiave, o con una chiave sconosciuta, il messaggio; senza nessuno dei due il ripiego', () => {
    expect(transitionErrorText({ error: 'boom', errorKey: 'errors.nope.nope' }, 'fallback')).toBe('boom')
    expect(transitionErrorText({ error: null }, 'fallback')).toBe('fallback')
  })
})
