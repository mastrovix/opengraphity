/**
 * L'ALTEZZA VERA DEL VIEWPORT (20 set 2026, dal giro su iPad).
 *
 * «Non si vede il pulsante avanti in basso a destra»: su Safari di iOS/iPadOS
 * `100vh` è l'altezza della finestra con le barre del browser NASCOSTE, cioè
 * più alta di quello che si vede. Il guscio dell'app è alto `100vh` con
 * `overflow: hidden`: la sua ultima striscia — dove sta la barra dei pulsanti
 * del wizard dei report — finiva sotto la barra di Safari, irraggiungibile,
 * perché la pagina non scorre e il canvas si prende il dito.
 *
 * La regola sta nel foglio di stile (`--vh-app`, con `@supports` per chi non
 * conosce `100dvh`) e questo guardiano la tiene: un `100vh` scritto a mano in
 * un componente rifà il difetto su una pagina sola, ed è il modo in cui
 * questi difetti tornano.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Fuori dal guscio dell'app, quindi fuori dalla regola: le schermate di
 * errore che si disegnano quando React non è nemmeno partito (non hanno
 * barre, non hanno wizard, e non possono leggere una variabile del tema).
 */
const FUORI_PERIMETRO = ['main.tsx']

function sorgenti(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { sorgenti(p, out); continue }
    if (/\.(tsx?|css)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

describe('l’altezza del viewport', () => {
  it('nessun componente scrive 100vh a mano: si usa var(--vh-app)', () => {
    const colpevoli = sorgenti(SRC)
      .filter((p) => !FUORI_PERIMETRO.includes(path.basename(p)))
      // `index.css` è dove la regola è DEFINITA, e `style.css` è il foglio di
      // base della pagina di login, che scorre e non ha il problema.
      .filter((p) => !/index\.css$|style\.css$/.test(p))
      .filter((p) => /100vh/.test(fs.readFileSync(p, 'utf8')))
      .map((p) => path.relative(SRC, p))
    expect(colpevoli).toEqual([])
  })

  it('la variabile è definita, e ha il ripiego per chi non conosce dvh', () => {
    const css = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8')
    expect(css).toMatch(/:root\s*\{\s*--vh-app:\s*100vh;\s*\}/)
    expect(css).toMatch(/@supports \(height: 100dvh\)/)
    expect(css).toMatch(/--vh-app:\s*100dvh/)
  })
})
