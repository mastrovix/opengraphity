/**
 * LA LINGUA NON SI CABLA — e questo test è l'unico modo perché resti vero.
 *
 * La lingua in cui si legge il prodotto è stata una costante nel codice per
 * tutta la vita del progetto, in tre posti diversi che si ignoravano:
 *
 *  - `LINGUA_PREDEFINITA = 'it'` nell'API, che era il ripiego delle etichette:
 *    un cliente irlandese leggeva «Priorità: Bassa» dentro un'interfaccia
 *    inglese, e non c'era modo di cambiarlo se non ricompilando;
 *  - `navigator` nel rilevamento di i18next, nel web e nel portale: decideva il
 *    BROWSER, che non è né la persona né l'azienda — un browser italiano
 *    atterrava in italiano senza che nessuno avesse scelto;
 *  - `fallbackLng: 'it'` nel portale, dove l'`end_user` non ha nessuna pagina
 *    per cambiarla.
 *
 * Correggerli non basta: sostituire `'it'` con `'en'` sarebbe stato scegliere
 * un'altra costante. La lingua predefinita è configurazione del cliente
 * (`lib/tenantLanguage.ts`, pagina Organizzazione), l'elenco delle lingue resta
 * codice perché è l'elenco dei file spediti, e la scelta di una persona vince
 * su quella dell'azienda. Questo test pinna le quattro cose che lo rendono vero.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC    = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO   = path.resolve(SRC, '../../..')
const API    = path.join(REPO, 'apps/api/src')
const PORTAL = path.join(REPO, 'apps/portal/src')

const leggi = (p: string) => fs.readFileSync(p, 'utf8')

describe('la lingua predefinita è configurazione, non codice', () => {
  it('l\'API non dichiara nessuna lingua predefinita del prodotto', () => {
    const labels = leggi(path.join(API, 'lib/enumValueLabels.ts'))
    // `LINGUA_PREDEFINITA` era proprio questo: la risposta alla domanda «in che
    // lingua si legge?» data una volta per tutti i clienti, in un file di
    // utilità sulle etichette.
    // La DICHIARAZIONE, non la parola: il commento che racconta com'era va
    // benissimo, ed e anzi il posto giusto dove tenerne memoria.
    expect(labels).not.toMatch(/(?:export\s+)?const\s+LINGUA_PREDEFINITA/)
    // E il ripiego di `labelFor` deve essere un PARAMETRO: chi chiama dichiara
    // la lingua del cliente, che sa dove prenderla.
    expect(labels).toMatch(/export function labelFor\([^)]*ripiego: Lingua\)/)
  })

  it('la lingua predefinita si legge dal cliente, e la scrive una mutation', () => {
    const tl = leggi(path.join(API, 'lib/tenantLanguage.ts'))
    expect(tl).toMatch(/t\.default_language/)
    expect(tl).toMatch(/export async function setTenantDefaultLanguage/)
  })

  it('né il web né il portale fanno decidere al BROWSER', () => {
    for (const p of [path.join(SRC, 'i18n/i18n.ts'), path.join(PORTAL, 'i18n/i18n.ts')]) {
      const src = leggi(p)
      const detection = /detection:\s*\{[^}]*\}/.exec(src)?.[0] ?? ''
      expect(detection, `${p}: il rilevamento deve esserci`).not.toBe('')
      expect(detection, `${p}: 'navigator' fa decidere la lingua al browser`).not.toContain('navigator')
    }
  })

  it('la scelta di una PERSONA passa da un posto solo, che la registra come scelta', () => {
    /*
      `i18n.changeLanguage` diretto dal Profilo non bastava: i18next scrive la
      lingua corrente in localStorage a ogni cambio, compresi quelli che fa il
      prodotto applicando il default dell'azienda, quindi quel valore non sa
      distinguere «l'ho scelta io» da «me l'ha messa il prodotto». Senza la
      distinzione, il giorno in cui l'azienda cambia lingua non se ne accorge
      nessuno.
    */
    const profilo = leggi(path.join(SRC, 'pages/profile/ProfilePage.tsx'))
    expect(profilo).toMatch(/scegliLinguaPersonale/)
    expect(profilo, 'il Profilo non deve chiamare changeLanguage a mano').not.toMatch(/i18n\.changeLanguage/)
  })

  it('le lingue del prodotto sono le stesse da una parte e dall\'altra', () => {
    // Un file di traduzione in più e un'API che non lo conosce (o il contrario)
    // sono una lingua che si può chiedere e non si può scrivere, o viceversa.
    const spedite = fs.readdirSync(path.join(SRC, 'i18n/locales'))
      .filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')).sort()
    const dichiarate = [...(/export const LINGUE = \[([^\]]+)\]/.exec(leggi(path.join(API, 'lib/enumValueLabels.ts')))?.[1] ?? '')
      .matchAll(/'([a-z]{2})'/g)].map((m) => m[1]!).sort()
    expect(dichiarate).toEqual(spedite)
  })
})
