/**
 * NESSUN ITALIANO CABLATO NEI TESTI CHE ARRIVANO A UNA PERSONA.
 *
 * Revisione del 14 set 2026 · CH-5, IT-14, CO-2, AU-6. Il guardiano della
 * lingua (scripts/check-i18n.mjs) guarda il web e il portale, e
 * `systemTextLint.test.ts` guarda i testi salvati nei ticket. Restavano scoperti:
 *  - i MESSAGGI D'ERRORE dell'API, che arrivano tutti al client (`formatError`
 *    non li maschera): «Il campo "x" è obbligatorio», «Per rigettare usa…»;
 *  - i DETTAGLI DI AUDIT della change, che l'interfaccia mostra così come sono;
 *  - le NOTIFICHE in tempo reale e le ETICHETTE delle attività («Compila
 *    assessment…»).
 * Un cliente inglese li leggeva in italiano.
 *
 * La regola: in quei punti il testo è inglese (la lingua del prodotto, dei log
 * e delle integrazioni); se una persona deve leggerlo nella sua lingua porta
 * una chiave i18n (`ValidationError(message, { key })`, `message_key`,
 * `detail_key`). L'italiano si riconosce come nel guardiano del web: un accento,
 * oppure parole che esistono solo nelle traduzioni italiane.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const API = join(process.cwd(), 'src')
const REPO = join(process.cwd(), '../..')

const flat = (o: unknown, out: string[] = []): string[] => {
  for (const v of Object.values(o as Record<string, unknown>)) {
    if (typeof v === 'string') out.push(v)
    else if (v && typeof v === 'object') flat(v, out)
  }
  return out
}
const words = (vals: string[]) => {
  const set = new Set<string>()
  for (const v of vals) for (const w of v.replace(/\{\{[^}]*\}\}/g, ' ').match(/[A-Za-zÀ-ÿ]{4,}/g) ?? []) set.add(w.toLowerCase())
  return set
}
const EN = words(flat(JSON.parse(readFileSync(join(REPO, 'apps/web/src/i18n/locales/en.json'), 'utf8'))))
const ONLY_IT = new Set([...words(flat(JSON.parse(readFileSync(join(REPO, 'apps/web/src/i18n/locales/it.json'), 'utf8'))))].filter((w) => !EN.has(w)))
const FUNZIONALI = /^(?:della|delle|dello|degli|dalla|dallo|dagli|nella|nelle|nello|negli|alla|allo|alle|agli|nel|nei|sulla|sulle|dei|del|dal|dai|sul|sui|questo|questa|quando|quello|quella|perche|oppure|anche|invece|ancora|nessun|nessuna|nessuno|gli|una|uno|che|con|il|lo|la|di|da|su|tra|fra|è)$/i

export function italiano(testo: string): boolean {
  const t = testo.replace(/\$\{[^}]*\}/g, ' ').replace(/\bnon-/g, 'non_').trim()
  if (t.length < 4) return false
  if (/^[a-z][\w]*(\.[\w]+)+$/.test(t)) return false          // una chiave i18n
  if (/[àèéìòù]/.test(t)) return true
  const ws = t.match(/[A-Za-zÀ-ÿ']+/g) ?? []
  const hits = ws.filter((w) => FUNZIONALI.test(w) || (w.length >= 4 && ONLY_IT.has(w.toLowerCase())))
  const n = ws.filter((w) => w.length > 1).length
  return hits.length >= 2 || (hits.length === 1 && n <= 3)
}

const senzaCommenti = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/gm, (m, p: string) => p + ' '.repeat(m.length - p.length))

function sorgenti(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (!['__tests__', 'scripts', 'migrations'].includes(e.name)) sorgenti(p, out); continue }
    if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

/** I punti in cui un testo arriva a una persona. */
const CHIAMATE = /new\s+[A-Za-z]*Error\(|\baudit\(|\bwriteAudit\(|\.sendToUser\(|\.sendToTenant\(/g
const PROPRIETA = /\b(action|detail|changeDescription):\s*/g

function argomenti(src: string, aperta: number): string {
  let depth = 0; let str: string | null = null
  for (let i = aperta; i < src.length; i++) {
    const c = src[i]!
    if (str) { if (c === '\\') { i++; continue } if (c === str) str = null; continue }
    if (c === "'" || c === '"' || c === '`') { str = c; continue }
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) return src.slice(aperta, i + 1) }
  }
  return src.slice(aperta)
}

const STRINGA = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/gs

/** File che per mestiere contengono l'italiano: le traduzioni. */
const TRADUZIONI = new Set(['packages/notifications/src/texts.ts', 'apps/api/src/lib/systemText.ts'])

describe('testi rivolti alle persone: niente italiano cablato', () => {
  it('errori, audit, notifiche ed etichette delle attività', () => {
    const colpevoli: string[] = []
    const cartelle = [API, join(REPO, 'packages/workflow/src'), join(REPO, 'packages/sla/src'), join(REPO, 'packages/notifications/src')]
    for (const file of cartelle.flatMap((d) => sorgenti(d))) {
      const rel = relative(REPO, file)
      if (TRADUZIONI.has(rel)) continue
      const src = senzaCommenti(readFileSync(file, 'utf8'))
      const riga = (i: number) => src.slice(0, i).split('\n').length
      for (const m of src.matchAll(CHIAMATE)) {
        const aperta = src.indexOf('(', m.index)
        for (const s of argomenti(src, aperta).matchAll(STRINGA)) {
          const testo = s[1] ?? s[2] ?? s[3] ?? ''
          if (italiano(testo)) colpevoli.push(`${rel}:${riga(aperta + s.index)} «${testo.slice(0, 80).replace(/\n/g, ' ')}»`)
        }
      }
      // Messaggi composti fuori dalla chiamata: righe dove si costruisce un
      // messaggio, un dettaglio o l'esito di una riga d'import. I log sono per
      // chi scrive il codice e restano fuori.
      src.split('\n').forEach((linea, i) => {
        if (!/\b(messages?|detail|stepSuffix|fail|warn)\b\s*[(=:]|\bmessages\.push\(/.test(linea)) return
        if (/logger\.|\blog\.(info|warn|error|debug)|console\./.test(linea)) return
        for (const s of linea.matchAll(STRINGA)) {
          const testo = s[1] ?? s[2] ?? s[3] ?? ''
          if (italiano(testo)) colpevoli.push(`${rel}:${i + 1} «${testo.slice(0, 80)}»`)
        }
      })
      // I dossier PDF: ogni stringa è testo stampato (intestazioni, etichette,
      // colonne), e il PDF si scrive nella lingua del cliente.
      if (/apps\/api\/src\/lib\/(pdf\/|\w+Pdf\.ts$)/.test(rel) && !rel.endsWith('pdf/texts.ts')) {
        for (const s of src.matchAll(STRINGA)) {
          const testo = s[1] ?? s[2] ?? s[3] ?? ''
          if (italiano(testo)) colpevoli.push(`${rel}:${riga(s.index)} «${testo.slice(0, 80).replace(/\n/g, ' ')}»`)
        }
      }
      if (rel.includes('graphql/resolvers/change/')) {
        for (const m of src.matchAll(PROPRIETA)) {
          const dopo = src.slice(m.index + m[0].length)
          const s = /^(['"`])((?:(?!\1)[^\\]|\\.)*)\1/.exec(dopo)
          if (s && italiano(s[2]!)) colpevoli.push(`${rel}:${riga(m.index)} «${s[2]!.slice(0, 80)}»`)
        }
      }
    }
    expect(colpevoli).toEqual([])
  })
})
