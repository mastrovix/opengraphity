/**
 * OGNI ERRORE CON UNA CHIAVE HA UNA FRASE, IN TUTTE LE LINGUE.
 *
 * Un errore dell'API porta due cose: un `message` inglese e stabile (log,
 * metriche, chi chiama l'API senza interfaccia) e — quando riguarda la persona
 * davanti allo schermo — una CHIAVE, che il client risolve nella lingua di chi
 * guarda (`createI18nLink`).
 *
 * Il modo di sbagliare che questo test chiude: una chiave scritta con un
 * refuso, o aggiunta nell'API e dimenticata nei file di lingua. Non si vede —
 * il client ripiega sul messaggio del server, che è inglese e vero — e allora
 * un utente italiano legge un errore inglese senza che nessuno sappia perché.
 * Il ripiego è deliberato (meglio dell'inglese che una chiave grezza a
 * schermo), e proprio per questo la chiave mancante va trovata qui.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

// La cwd di vitest qui e `apps/api`.
const API     = join(process.cwd(), 'src')
const REPO    = resolve(process.cwd(), '../..')
const LOCALES = join(REPO, 'apps/web/src/i18n/locales')

function sorgenti(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '__tests__') sorgenti(p, out); continue }
    if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

/** Tutte le chiavi `key: 'errors.…'` scritte nell'API, col file che le scrive. */
const USATE = new Map<string, string>()
for (const p of sorgenti(API)) {
  const src = readFileSync(p, 'utf8')
  for (const m of src.matchAll(/key: '(errors\.[A-Za-z0-9_.]+)'/g)) {
    USATE.set(m[1]!, p.slice(API.length + 1))
  }
}

function dizionario(lingua: string): Set<string> {
  const json = JSON.parse(readFileSync(join(LOCALES, `${lingua}.json`), 'utf8')) as Record<string, unknown>
  const fuori = new Set<string>()
  const giu = (n: Record<string, unknown>, pre = '') => {
    for (const [k, v] of Object.entries(n)) {
      if (v !== null && typeof v === 'object') giu(v as Record<string, unknown>, `${pre}${k}.`)
      else fuori.add(`${pre}${k}`)
    }
  }
  giu(json)
  return fuori
}

describe('le chiavi degli errori dell\'API', () => {
  it('l\'API ne dichiara davvero (se questo cade, il resto passerebbe a vuoto)', () => {
    expect(USATE.size).toBeGreaterThanOrEqual(50)
    expect([...USATE.keys()]).toContain('errors.validation.email')
  })

  for (const lingua of ['it', 'en']) {
    it(`${lingua}: nessuna chiave senza frase`, () => {
      const scritte = dizionario(lingua)
      const mancanti = [...USATE].filter(([k]) => !scritte.has(k)).map(([k, f]) => `${k} (${f})`)
      expect(mancanti, `Queste chiavi le scrive l'API ma ${lingua}.json non le ha: l'utente leggerebbe `
        + `il messaggio inglese del server invece dell'errore nella sua lingua`).toEqual([])
    })
  }

  /**
   * IL CRICCHETTO. Il difetto non era «un messaggio sbagliato»: era che l'API
   * scrivesse le frasi in italiano, cosa che non può fare bene perché non sa in
   * che lingua guarda chi legge. Rifarlo domani sarebbe indolore e invisibile.
   */
  it('nessun messaggio d\'errore è scritto in italiano', () => {
    // Parole che in un messaggio inglese non compaiono mai.
    /*
      `non-empty`, `non-negative`: l'inglese tecnico usa «non» col trattino, e
      non è italiano. Senza questa esclusione il guardiano accusava una dozzina
      di messaggi inglesi corretti, e un guardiano che grida al lupo si
      disattiva da sé.
    */
    const RE_ITALIANO = /\b(non(?!-)|deve|devono|essere|nessun|nessuna|già|obbligatorio|vocabolario|questo|cliente|della|degli|impattato|valore|passo)\b/i
    const colpevoli: string[] = []
    for (const p of sorgenti(API)) {
      const src = readFileSync(p, 'utf8')
      // `new ValidationError('…')` / `new ForbiddenError(`…`)`: solo il primo
      // argomento, che è il messaggio.
      /*
        Anche `GraphQLError` grezzo: 132 errori dell'API erano lanciati cosi,
        e la meta portava prosa italiana. Non basta guardare le classi del
        progetto — la strada piu breve per rifare il difetto e proprio quella
        che le scavalca.
      */
      for (const m of src.matchAll(/new (?:Validation|Forbidden|ServiceUnavailable|GraphQL)Error\(\s*(['"`])((?:[^\\]|\\.)*?)\1/g)) {
        const messaggio = m[2]!
        if (RE_ITALIANO.test(messaggio)) colpevoli.push(`${p.slice(API.length + 1)}: ${messaggio.slice(0, 70)}`)
      }
    }
    expect(colpevoli, 'Il messaggio di un errore è per i log e per chi chiama l\'API: inglese. '
      + 'La frase per la persona la scrive il client, dalla chiave in `extensions.i18n`').toEqual([])
  })
})
