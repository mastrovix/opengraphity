/**
 * GLI ULTIMI BORDI.
 *
 * Tre punti che restavano senza prova, e sono tutti «cosa succede quando
 * manca il contesto»: nessuna lingua attiva, nessun documento in cui
 * disegnare, nessun token ancora.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import i18n from '@/i18n/i18n'

afterEach(() => { vi.restoreAllMocks() })

describe('format: senza una lingua attiva si LANCIA', () => {
  it('non si indovina un locale: le date uscirebbero nel formato di un paese a caso', async () => {
    const { fmtDate } = await import('./lib/format')
    const lingua = vi.spyOn(i18n, 'resolvedLanguage', 'get').mockReturnValue(undefined as unknown as string)
    const lingua2 = vi.spyOn(i18n, 'language', 'get').mockReturnValue('' as unknown as string)
    // `fmtDate` cattura l'errore e torna il valore grezzo: meglio l'ISO di
    // una data nel formato sbagliato.
    expect(fmtDate('2026-09-08T08:30:00Z')).toBe('2026-09-08T08:30:00Z')
    lingua.mockRestore(); lingua2.mockRestore()
  })
})

describe('notify: lo stesso messaggio non si ripete', () => {
  it('una raffica di fallimenti mostra un avviso solo', async () => {
    // Il giro di polling in sottofondo fallisce a ogni tentativo: senza la
    // deduplica la pagina si riempirebbe di banner identici.
    const { notifyError } = await import('./lib/notify')
    document.getElementById('portal-error-host')?.remove()
    notifyError('Network error')
    notifyError('Network error')
    notifyError('Network error')
    const host = document.getElementById('portal-error-host')!
    expect(host.children.length).toBe(1)
    host.remove()
  })

  it('messaggi diversi si vedono entrambi', async () => {
    const { notifyError, notifyInfo } = await import('./lib/notify')
    document.getElementById('portal-error-host')?.remove()
    notifyError('Primo problema')
    notifyInfo('Tornato tutto a posto')
    const host = document.getElementById('portal-error-host')!
    expect(host.children.length).toBe(2)
    host.remove()
  })
})
