/**
 * OGNI DIAGNOSI HA UNA FRASE, IN TUTTE LE LINGUE.
 *
 * La diagnostica non compone piu prosa: manda una `kind` — che e una chiave —
 * e i soli dati da interpolare, e la frase la scrive il client nella lingua di
 * chi guarda. Il guadagno e vero (il banner era in italiano in un'interfaccia
 * inglese, misurato in un browser) ma apre un modo nuovo di sbagliare, e in
 * silenzio: aggiungere una `kind` nell'API e dimenticare la chiave nel web. Il
 * risultato non e un errore — e un banner che dice «C'e 1 cosa da sistemare» e
 * sotto la chiave grezza.
 *
 * Questo test chiude quella porta: le `kind` le legge dal SORGENTE dell'API, le
 * chiavi dai file di lingua del web, e pretende che si corrispondano. Niente
 * elenchi scritti a mano da tenere allineati — un elenco a mano e' proprio la
 * cosa che ha fatto fallire il guardiano del wiring dei resolver.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// La cwd di vitest qui e `apps/api`.
const REPO = resolve(process.cwd(), '../..')
const LOCALES = join(REPO, 'apps/web/src/i18n/locales')

const issuesSrc = readFileSync(join(process.cwd(), 'src/lib/configurationIssues.ts'), 'utf8')
const gapSrc    = readFileSync(join(process.cwd(), 'src/lib/provisionTenantData.ts'), 'utf8')

/** I valori di un'unione di stringhe letterali, dato il pezzo di sorgente che la contiene. */
function unione(src: string, dopo: string): string[] {
  const i = src.indexOf(dopo)
  if (i < 0) throw new Error(`non trovo «${dopo}» nel sorgente: la regex di questo test e da aggiornare`)
  // Fino al primo `;` o al primo campo successivo: l'unione sta tutta prima.
  const blocco = src.slice(i + dopo.length).split(/\n\s*(?:\}|\/\*\*|export|\w+[?]?:)/)[0]!
  return [...blocco.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!)
}

const ISSUE_KINDS = unione(issuesSrc, 'export type ConfigurationIssueKind =')
const GAP_KINDS   = unione(gapSrc, 'export interface ProvisioningGap {\n  kind:')

function dizionario(lingua: string): Record<string, unknown> {
  const json = JSON.parse(readFileSync(join(LOCALES, `${lingua}.json`), 'utf8')) as Record<string, unknown>
  const sezione = json['configurationIssues']
  if (sezione === undefined) throw new Error(`${lingua}.json non ha la sezione «configurationIssues»`)
  return sezione as Record<string, unknown>
}

/** Una chiave c'e se e scritta, o se ci sono le sue due forme plurali. */
function presente(sezione: Record<string, unknown>, gruppo: string, kind: string): boolean {
  const g = sezione[gruppo] as Record<string, unknown> | undefined
  if (g === undefined) return false
  if (typeof g[kind] === 'string') return true
  return typeof g[`${kind}_one`] === 'string' && typeof g[`${kind}_other`] === 'string'
}

describe('le chiavi della diagnostica esistono in tutte le lingue', () => {
  it('i tipi si leggono davvero dal sorgente (se questo cade, il resto passerebbe su un elenco vuoto)', () => {
    expect(ISSUE_KINDS.length).toBeGreaterThanOrEqual(9)
    expect(GAP_KINDS.length).toBeGreaterThanOrEqual(8)
    expect(ISSUE_KINDS).toContain('schema_degraded')
    expect(GAP_KINDS).toContain('no_teams')
  })

  for (const lingua of ['it', 'en']) {
    it(`${lingua}: ogni diagnosi e ogni buco hanno la loro frase`, () => {
      const sezione = dizionario(lingua)
      const mancanti = [
        ...ISSUE_KINDS.filter((k) => !presente(sezione, 'issue', k)).map((k) => `configurationIssues.issue.${k}`),
        ...GAP_KINDS.filter((k) => !presente(sezione, 'gap', k)).map((k) => `configurationIssues.gap.${k}`),
      ]
      expect(mancanti, `Queste chiavi mancano in ${lingua}.json: il banner mostrerebbe la chiave grezza`).toEqual([])
    })

    it(`${lingua}: nessuna frase avanzata per una diagnosi che non esiste piu`, () => {
      // Una chiave rimasta non rompe niente, ma e' peso morto che si traduce
      // per sempre: se la diagnosi e' stata rimossa, la frase segue.
      const sezione = dizionario(lingua)
      const noti = new Set([...ISSUE_KINDS, ...GAP_KINDS])
      const avanzate: string[] = []
      for (const gruppo of ['issue', 'gap']) {
        for (const chiave of Object.keys((sezione[gruppo] as Record<string, unknown> | undefined) ?? {})) {
          const kind = chiave.replace(/_(one|other)$/, '')
          if (!noti.has(kind)) avanzate.push(`configurationIssues.${gruppo}.${chiave}`)
        }
      }
      expect(avanzate, `Queste frasi non corrispondono a nessuna diagnosi dell'API`).toEqual([])
    })
  }

  /**
   * IL CRICCHETTO. Il difetto non era «una frase sbagliata»: era che l'API
   * scrivesse frasi, cosa che non puo fare bene perche non sa in che lingua
   * guarda chi legge. Scriverne una nuova domani sarebbe indolore e invisibile
   * — compila, gira, e si vede solo cambiando lingua.
   */
  it('la diagnostica non torna a comporre prosa', () => {
    // Un campo `message` sulla voce: e' esattamente cio che e' stato tolto.
    expect(/^\s*message:/m.test(issuesSrc), 'configurationIssues.ts ha di nuovo un campo `message`').toBe(false)
  })
})
