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
})
