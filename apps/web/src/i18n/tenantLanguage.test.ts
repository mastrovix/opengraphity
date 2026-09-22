/**
 * Who decides the language: a person's own choice from the Profile always wins,
 * the tenant default applies to everyone else, and the browser decides nothing.
 *
 * The marker `og.language.chosen` is the only thing that tells «I chose it»
 * apart from «the product set it» (i18next rewrites its own key on every
 * change). If these helpers regress, either a person's choice is silently
 * overwritten by the tenant default at every login, or a tenant switching
 * language is ignored by everyone forever — and a private window, where
 * localStorage throws, must not break the app.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import i18n from './i18n'
import {
  linguaSceltaDallUtente, scegliLinguaPersonale, usaLinguaDellOrganizzazione, applicaLinguaDelCliente,
} from './tenantLanguage'

const KEY = 'og.language.chosen'

let change: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  window.localStorage.clear()
  // The language itself is i18next's business: here we only check WHEN it is asked to change.
  change = vi.spyOn(i18n, 'changeLanguage').mockResolvedValue(i18n.t)
})
afterEach(() => { vi.restoreAllMocks() })

describe('linguaSceltaDallUtente', () => {
  it('is false until the Profile records a choice', () => {
    expect(linguaSceltaDallUtente()).toBe(false)
    window.localStorage.setItem(KEY, 'true')
    expect(linguaSceltaDallUtente()).toBe(true)
  })

  it('is false (not an error) when localStorage is denied', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    expect(linguaSceltaDallUtente()).toBe(false)
  })
})

describe('scegliLinguaPersonale', () => {
  it('records the personal choice and switches language', async () => {
    await scegliLinguaPersonale('it')
    expect(window.localStorage.getItem(KEY)).toBe('true')
    expect(change).toHaveBeenCalledWith('it')
  })

  it('still switches language when the choice cannot be stored', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    await scegliLinguaPersonale('it')
    expect(change).toHaveBeenCalledWith('it')
  })
})

describe('usaLinguaDellOrganizzazione', () => {
  it('forgets the personal choice, so the tenant default applies again', async () => {
    window.localStorage.setItem(KEY, 'true')
    await usaLinguaDellOrganizzazione('en')
    expect(linguaSceltaDallUtente()).toBe(false)
    expect(change).toHaveBeenCalledWith('en')
  })

  it('with no tenant default known yet it only forgets the choice', async () => {
    window.localStorage.setItem(KEY, 'true')
    await usaLinguaDellOrganizzazione(null)
    expect(linguaSceltaDallUtente()).toBe(false)
    expect(change).not.toHaveBeenCalled()
  })

  it('survives a denied localStorage', async () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied') })
    await usaLinguaDellOrganizzazione('it')
    expect(change).toHaveBeenCalledWith('it')
  })
})

describe('applicaLinguaDelCliente', () => {
  it('does nothing when the language is already the tenant one', async () => {
    await applicaLinguaDelCliente(i18n.language)
    expect(change).not.toHaveBeenCalled()
  })

  it('switches to the tenant default otherwise', async () => {
    const other = i18n.language === 'it' ? 'en' : 'it'
    await applicaLinguaDelCliente(other)
    expect(change).toHaveBeenCalledWith(other)
  })
})
