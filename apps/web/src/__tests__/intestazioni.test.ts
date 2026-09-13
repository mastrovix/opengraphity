/**
 * LE INTESTAZIONI DI PAGINA SI SOMIGLIANO, e non per caso.
 *
 * Il titolo e il sottotitolo di una pagina sono scritti a mano in ogni pagina —
 * non c'è un componente che li imponga — e hanno derivato: le pagine del menu
 * Configurazione avevano il sottotitolo in `--color-slate-light`, tutte le
 * altre in `--color-slate-dark`. Un colore più chiaro su una pagina sola non
 * si nota; su un intero gruppo di pagine si vede passando da un menu all'altro,
 * ed è quello che è stato notato.
 *
 * Nessun test lo prendeva, perché ogni pagina è corretta da sé: sbagliata è la
 * DIFFERENZA. Questo test guarda l'insieme.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function tsx(dir = SRC, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'test') tsx(p, out); continue }
    if (e.name.endsWith('.tsx') && !e.name.includes('.test.')) out.push(p)
  }
  return out
}

const FILES = tsx().map((p) => ({ rel: path.relative(SRC, p), src: fs.readFileSync(p, 'utf8') }))

describe('intestazioni di pagina: un colore solo', () => {
  it('il sottotitolo di una pagina è sempre --color-slate-dark', () => {
    // La forma del sottotitolo: il paragrafo sotto il titolo, `marginTop: 4`.
    const RE = /fontSize: 'var\(--font-size-body\)', color: ([^,]+), marginTop: 4, marginBottom: 0/g
    const fuoriRiga: string[] = []
    let trovati = 0
    for (const { rel, src } of FILES) {
      for (const m of src.matchAll(RE)) {
        trovati += 1
        if (m[1] !== "'var(--color-slate-dark)'") fuoriRiga.push(`${rel}: ${m[1]!}`)
      }
    }
    // Se la regex non trova più niente, il resto passerebbe a vuoto.
    expect(trovati).toBeGreaterThanOrEqual(25)
    expect(fuoriRiga, 'Questi sottotitoli hanno un colore diverso dagli altri').toEqual([])
  })

  it("l'icona del titolo è sempre --color-icon-accent", () => {
    const RE = /size=\{22\} color="(var\(--color-[a-z-]+\))"/g
    const fuoriRiga: string[] = []
    let trovati = 0
    for (const { rel, src } of FILES) {
      // `PageTitle.tsx` documenta l'uso nel suo commento: è documentazione, non una pagina.
      if (rel === 'components/PageTitle.tsx') continue
      for (const m of src.matchAll(RE)) {
        trovati += 1
        if (m[1] !== 'var(--color-icon-accent)') fuoriRiga.push(`${rel}: ${m[1]!}`)
      }
    }
    expect(trovati).toBeGreaterThanOrEqual(40)
    expect(fuoriRiga, "Queste icone di titolo hanno un colore diverso dalle altre").toEqual([])
  })

  /*
    Il test sopra guarda le icone scritte come `size={22} color="…"`: un'icona
    SENZA colore e di un'altra misura non corrisponde alla regex, quindi non
    veniva nemmeno contata. Cosi l'SLA Report (`<Gauge size={20} />`) e il
    Catalogo servizi hanno avuto per mesi un titolo con l'icona nera e piu
    piccola. Qui si parte dall'altro lato: OGNI icona passata a un titolo di
    pagina, qualunque forma abbia.
  */
  it("nessuna icona passata a un titolo di pagina dichiara una misura o un colore diversi da quelli del titolo", () => {
    const RE = /<(PageTitle|ListPageHeader)\b[\s\S]{0,300}?icon=\{(<[A-Z]\w*[^>]*\/>)\}/g
    const fuoriRiga: string[] = []
    let trovati = 0
    for (const { rel, src } of FILES) {
      for (const m of src.matchAll(RE)) {
        trovati += 1
        const icona = m[2]!
        // Misura e colore li impone PageTitle: un'icona senza props e giusta.
        // Una che ne DICHIARA di diversi e sbagliata lo stesso — nel codice
        // afferma un valore che a schermo non c'e.
        const misura = /size=\{(\d+)\}/.exec(icona)?.[1]
        const colore = /color="([^"]+)"/.exec(icona)?.[1]
        if ((misura !== undefined && misura !== '22') || (colore !== undefined && colore !== 'var(--color-icon-accent)')) {
          fuoriRiga.push(`${rel}: ${icona}`)
        }
      }
    }
    expect(trovati).toBeGreaterThanOrEqual(40)
    expect(fuoriRiga, 'Queste icone di titolo non hanno la misura o il colore delle altre').toEqual([])
  })

  it('un titolo scritto a mano (<h1> con un\'icona) non sfugge alla regola: si usa PageTitle', () => {
    // L'Assistente AI aveva il suo <h1> con `<Sparkles size={20} color="var(--color-brand)" />`:
    // fuori da PageTitle, quindi fuori dal test sopra.
    const RE = /<h1\b[^>]*>([\s\S]{0,260}?)<\/h1>/g
    const fuoriRiga: string[] = []
    for (const { rel, src } of FILES) {
      if (rel === 'components/PageTitle.tsx') continue
      for (const m of src.matchAll(RE)) {
        const icona = /<[A-Z]\w*\s[^>]*size=\{\d+\}[^>]*\/>/.exec(m[1]!)
        if (icona) fuoriRiga.push(`${rel}: ${icona[0]}`)
      }
    }
    expect(fuoriRiga, 'Questi titoli hanno un\'icona in un <h1> scritto a mano: usa PageTitle').toEqual([])
  })
})
