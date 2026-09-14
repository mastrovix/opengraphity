/**
 * NT-2 (revisione del 14 set 2026): i titoli delle notifiche che escono dal
 * prodotto (e-mail, Slack, Teams) sono ricopiati dai file di traduzione del web,
 * che il pannello in-app usa. Qui il patto che impedisce di divergere, e la
 * garanzia che ogni regola di fabbrica abbia un titolo tradotto — 23 su 35 non
 * l'avevano, e il pannello mostrava la chiave.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NOTIFICATION_LANGUAGES, NOTIFICATION_TITLES, formatNotificationDate, notificationText, notificationTitle } from '../texts.js'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const web = Object.fromEntries(NOTIFICATION_LANGUAGES.map((l) => [l, JSON.parse(readFileSync(`${root}apps/web/src/i18n/locales/${l}.json`, 'utf8')) as Record<string, unknown>]))

function flat(node: unknown, prefix: string, out: Record<string, string>): Record<string, string> {
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (typeof v === 'string') out[`${prefix}${k}`] = v
    else flat(v, `${prefix}${k}.`, out)
  }
  return out
}

describe('titoli delle notifiche', () => {
  it('coincidono con i file del web, chiave per chiave e lingua per lingua', () => {
    for (const lang of NOTIFICATION_LANGUAGES) {
      const fromWeb = flat(web[lang]!['notification'], 'notification.', {})
      const fromPkg = Object.fromEntries(Object.entries(NOTIFICATION_TITLES).map(([k, v]) => [k, v[lang]]))
      expect(fromPkg, lang).toEqual(fromWeb)
    }
  })

  it('ogni regola di fabbrica ha il suo titolo tradotto', () => {
    const seed = readFileSync(`${root}apps/api/src/lib/seedNotificationRules.ts`, 'utf8')
    const keys = [...seed.matchAll(/title_key:\s*'([^']+)'/g)].map((m) => m[1]!)
    expect(keys.length).toBeGreaterThan(30)
    for (const k of keys) expect(NOTIFICATION_TITLES[k], k).toBeDefined()
  })

  it('una chiave nota diventa la frase; un testo scritto nella regola resta com\'è', () => {
    expect(notificationTitle({ language: 'it', timeZone: 'Europe/Rome' }, 'notification.incident.created.title')).toBe('Nuovo incident')
    expect(notificationTitle({ language: 'en', timeZone: 'UTC' }, 'Stampanti del terzo piano')).toBe('Stampanti del terzo piano')
  })

  it('testi fissi e date nella lingua e nel fuso del cliente', () => {
    expect(notificationText({ language: 'it', timeZone: 'UTC' }, 'viewDetails')).toBe('Vedi dettagli')
    expect(notificationText({ language: 'en', timeZone: 'UTC' }, 'slaBreachedFor', { type: 'problem', id: 'p-1' })).toBe('SLA breached for problem p-1')
    const at = new Date('2026-09-14T22:30:00Z')
    expect(formatNotificationDate({ language: 'en', timeZone: 'Europe/Rome' }, at)).toContain('15 Sept 2026')
    expect(formatNotificationDate({ language: 'en', timeZone: 'UTC' }, at)).toContain('14 Sept 2026')
  })
})
