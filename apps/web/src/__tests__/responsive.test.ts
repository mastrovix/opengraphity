/**
 * LA RESPONSIVITÀ COME REGOLA, non come correzione una volta sola
 * (ondata 4 delle quattro decise il 13 set 2026).
 *
 * Fino a oggi in `apps/web` non c'era UNA media query: ogni misura stava negli
 * stili inline, che non possono contenerne. Da lì venivano i difetti visti nel
 * browser — la colonna laterale del dettaglio evento a 129px col testo spezzato
 * carattere per carattere, la pagina che scorreva di lato sulle liste, il
 * titolo che toccava i bottoni a 0px.
 *
 * Correggerli non basta: senza un guardiano la prossima griglia fissa entra
 * domani, e nessuno se ne accorge finché non apre il browser su una finestra
 * stretta. Questo test pinna le tre cose che rendono la regola una regola.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CSS = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8')

function tsx(dir = SRC, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'test') tsx(p, out); continue }
    if (e.name.endsWith('.tsx') && !e.name.includes('.test.')) out.push(p)
  }
  return out
}
const FILES = tsx()
const rel = (p: string) => path.relative(SRC, p)

describe('il livello di breakpoint esiste e sta in un posto solo', () => {
  it('index.css dichiara le classi e le loro soglie', () => {
    for (const cls of ['.og-split', '.og-pair', '.og-scroll-x', '.og-page-header']) {
      expect(CSS, `manca ${cls} in index.css`).toContain(cls)
    }
    // Le due soglie decise: 900px per due colonne 2:1, 700px per due colonne pari.
    expect(CSS).toMatch(/@media \(max-width: 900px\)/)
    expect(CSS).toMatch(/@media \(max-width: 700px\)/)
  })
})

describe('niente griglie a due colonne FISSE negli stili inline', () => {
  /**
   * `gridTemplateColumns: '1fr 1fr'` (o `2fr 1fr`) in uno stile inline non può
   * collassare: sotto i 700px le due colonne si stringono fino a rendere
   * illeggibile il contenuto invece di andare una sotto l'altra. Le classi
   * `og-pair` / `og-split` fanno la stessa cosa e sanno collassare.
   *
   * Se serve davvero una griglia fissa (una tavolozza, una matrice quadrata),
   * si usa un numero di colonne diverso da due: la regola guarda solo il caso a
   * due, che è quello che si rompe leggendo.
   */
  it('nessun file usa due colonne fisse inline', () => {
    const colpevoli: string[] = []
    for (const f of FILES) {
      const src = fs.readFileSync(f, 'utf8')
      for (const m of src.matchAll(/gridTemplateColumns: '(1fr 1fr|2fr 1fr|minmax\(0, 2fr\) minmax\(0, 1fr\))'/g)) {
        const riga = src.slice(0, m.index).split('\n').length
        colpevoli.push(`${rel(f)}:${String(riga)} ${m[1]}`)
      }
    }
    expect(colpevoli, `usa og-pair (colonne pari) o og-split (2:1), che collassano:\n  ${colpevoli.join('\n  ')}`).toEqual([])
  })
})

describe('ogni tabella scorre DENTRO il suo contenitore', () => {
  /**
   * Una tabella larga senza contenitore che scorre spinge il body: la pagina
   * intera scorre di lato, barra laterale compresa, ed è il difetto che si
   * vedeva su ogni lista. Il contenitore va nelle righe PRIMA del `<table>`
   * (`og-scroll-x`, oppure `overflowX` a mano dove c'era già).
   */
  it('nessun <table> senza contenitore che scorre', () => {
    const nudi: string[] = []
    for (const f of FILES) {
      const righe = fs.readFileSync(f, 'utf8').split('\n')
      righe.forEach((r, i) => {
        // Solo un tag vero, non la parola «<table>» dentro un commento: il
        // primo guardiano che ho scritto accusava la docstring di SimpleTable.
        if (!/<table[\s>]/.test(r)) return
        if (/^\s*(\*|\/\/)/.test(r)) return
        /*
          Finestra ampia di proposito: in `DomainMatricesPage` un solo
          contenitore avvolge le DUE tabelle di un ternario, e con tre righe di
          sguardo la seconda risultava nuda. È un'euristica, e lo si dice: se
          un contenitore aperto quindici righe sopra è già stato chiuso, questo
          controllo non lo sa. Preferisco un falso negativo raro a un falso
          positivo che fa disattivare il guardiano.
        */
        const contesto = righe
          .slice(Math.max(0, i - 15), i)
          // I COMMENTI NON CONTANO. Rotto di proposito questo guardiano per
          // vederlo cadere, restava verde: il commento che spiega la regola
          // («dentro og-scroll-x, vedi index.css») la soddisfaceva da solo.
          .filter((r) => !/^\s*(\*|\/\/|\/\*)/.test(r))
          .join('\n')
        if (/og-scroll-x|overflowX/.test(contesto)) return
        nudi.push(`${rel(f)}:${String(i + 1)}`)
      })
    }
    expect(nudi, `avvolgi in <div className="og-scroll-x">:\n  ${nudi.join('\n  ')}`).toEqual([])
  })
})

describe('la testata di pagina va a capo invece di toccarsi', () => {
  it('ListPageHeader usa og-page-header, non una flex inline senza gap', () => {
    const src = fs.readFileSync(path.join(SRC, 'components/ListPageHeader.tsx'), 'utf8')
    expect(src).toContain('className="og-page-header"')
    expect(src).not.toMatch(/justifyContent: 'space-between'/)
  })
})

describe('il testo per lettori di schermo non allunga la pagina', () => {
  /**
   * `position: absolute` senza coordinate resta dove lo mette il flusso. Dentro
   * una tabella larga che scorre nel suo riquadro, il blocco contenitore è la
   * PAGINA: lo span da 1px finiva a x=1195 su una finestra da 731 e la pagina
   * intera scorreva di lato di 465px, barra laterale compresa — invisibile, e
   * per settimane fra gli aperti come «scorrimento orizzontale su
   * monitoring/health, inconcludente».
   */
  it('srOnlyStyle è ancorato a (0, 0)', () => {
    const src = fs.readFileSync(path.join(SRC, 'lib/a11y.ts'), 'utf8')
    expect(src).toMatch(/position: 'absolute', left: 0, top: 0/)
  })

  it('nessuna COPIA dello stile: le copie non si correggono correggendo l\'originale', () => {
    const copie: string[] = []
    for (const f of [...FILES, ...tsx(path.join(SRC, 'lib'))]) {
      const src = fs.readFileSync(f, 'utf8')
      if (rel(f) === 'lib/a11y.ts') continue
      if (/position: 'absolute', width: 1, height: 1/.test(src)) copie.push(rel(f))
    }
    expect(copie, `usa srOnlyStyle da lib/a11y.ts:\n  ${copie.join('\n  ')}`).toEqual([])
  })
})

describe('la lingua dichiarata al browser e' + "'" + ' quella vera', () => {
  /**
   * `<html lang>` era `en` cablato in `index.html` e mai aggiornato: per ogni
   * utente italiano un lettore di schermo leggeva testo italiano con le regole
   * di pronuncia inglesi. Corretto in HTML, sbagliato in italiano — e nessun
   * test poteva prenderlo guardando il solo markup.
   */
  it('i18n allinea documentElement.lang, all\'avvio e a ogni cambio', () => {
    const src = fs.readFileSync(path.join(SRC, 'i18n/i18n.ts'), 'utf8')
    expect(src).toMatch(/document\.documentElement\.lang\s*=/)
    expect(src).toMatch(/i18n\.on\('languageChanged'/)
  })
})
