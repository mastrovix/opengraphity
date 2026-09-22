#!/usr/bin/env node
/**
 * OGNI CONTROLLO HA UN NOME CHE SI SENTE (22 set 2026).
 *
 * ## Il buco fra due regole
 * `jsx-a11y/label-has-associated-control` — accesa — guarda le `<label>` che
 * ESISTONO e pretende che portino a un controllo. Un `<input>` senza NESSUNA
 * etichetta non le interessa: non c'e' una label da controllare.
 *
 * Dall'altra parte, `jsx-a11y/control-has-associated-label` guarderebbe proprio
 * quello, ma non capisce `<label htmlFor>`: su questo repository segnalava 163
 * controlli, e 58 erano legati a una label per `htmlFor` — falsi positivi che
 * avrebbero insegnato a non credere alla regola. Resta spenta, e il motivo sta
 * in `eslint.config.mjs`.
 *
 * In mezzo alle due c'era il caso vero: un controllo che non ha ne' una label,
 * ne' un `id` a cui una label si agganci, ne' un `aria-label`. Chi usa uno
 * screen reader lo sente come «casella di testo», e basta. Erano
 * quarantadue.
 *
 * ## Perche' un parser e non un selettore eslint
 * Con `no-restricted-syntax` il selettore non sa guardare gli ANTENATI, quindi
 * un `<label>Nome <input/></label>` — che e' corretto — veniva segnalato lo
 * stesso: 115 invece di 42. Un guardiano che sbaglia due volte su tre insegna
 * a ignorarlo. Con l'AST si guarda anche chi sta sopra.
 *
 * ## Che cosa conta come nome
 * `aria-label`, `aria-labelledby`, `title`, un `id` (c'e' una `<label htmlFor>`
 * che lo cerca, e a quella ci pensa la regola eslint), o una `<label>` che
 * avvolge il controllo.
 *
 * ## E quello che non ha bisogno di un nome
 * - `type="hidden"`: non e' un controllo.
 * - `display: 'none'` nello stile: il browser lo toglie dall'albero di
 *   accessibilita'. Sono i quattro selettori di file che stanno dietro a un
 *   bottone: il nome ce l'ha il bottone, e darne uno anche a loro sarebbe
 *   arredamento per una stanza in cui non entra nessuno.
 * - `aria-hidden="true"`: la sentinella invisibile di `SyncSourcesTab`, che
 *   esiste solo per far scattare la validazione del browser.
 * - `{...spread}`: gli attributi non si vedono da qui, e tirare a indovinare
 *   sarebbe peggio che tacere.
 *
 * Uso: node scripts/check-etichette-controlli.mjs
 */
import ts from 'typescript'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const RADICE = process.cwd()
const CARTELLE = ['apps/web/src', 'apps/portal/src']
const CONTROLLI = new Set(['input', 'textarea', 'select'])
const DANNO_IL_NOME = new Set(['id', 'aria-label', 'aria-labelledby', 'title'])

function tsxIn(dir, fuori = []) {
  for (const v of readdirSync(dir)) {
    const p = join(dir, v)
    if (statSync(p).isDirectory()) { if (v !== 'node_modules' && v !== 'dist' && v !== 'test') tsxIn(p, fuori) }
    else if (v.endsWith('.tsx') && !v.endsWith('.test.tsx')) fuori.push(p)
  }
  return fuori
}

const senzaNome = []

for (const file of CARTELLE.flatMap((c) => tsxIn(join(RADICE, c)))) {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const rel = relative(RADICE, file)
  let dentroLabel = 0

  const visita = (n) => {
    const apreUnaLabel = ts.isJsxElement(n) && n.openingElement.tagName.getText(sf) === 'label'
    if (apreUnaLabel) dentroLabel++

    const apre = ts.isJsxSelfClosingElement(n) ? n : (ts.isJsxOpeningElement(n) ? n : null)
    if (apre && CONTROLLI.has(apre.tagName.getText(sf)) && dentroLabel === 0) {
      const props = apre.attributes.properties
      const attrs = props.filter(ts.isJsxAttribute)
      const nome = (a) => a.name.getText(sf)
      const valore = (a) => a.initializer?.getText(sf) ?? ''

      const haSpread = props.some(ts.isJsxSpreadAttribute)
      const haNome = attrs.some((a) => DANNO_IL_NOME.has(nome(a)))
      const eNascosto = attrs.some((a) => nome(a) === 'type' && valore(a).includes('hidden'))
        || attrs.some((a) => nome(a) === 'style' && /display:\s*'none'/.test(valore(a)))
        || attrs.some((a) => nome(a) === 'aria-hidden' && valore(a).includes('true'))

      if (!haSpread && !haNome && !eNascosto) {
        const { line } = sf.getLineAndCharacterOfPosition(apre.getStart(sf))
        senzaNome.push(`${rel}:${line + 1}  <${apre.tagName.getText(sf)}> non ha ne' label, ne' id, ne' aria-label: chi lo sente non sa che cos'e'.`)
      }
    }

    ts.forEachChild(n, visita)
    if (apreUnaLabel) dentroLabel--
  }
  visita(sf)
}

for (const r of senzaNome) console.error(`ERROR ${r}`)
console.log(`check-etichette-controlli: ${senzaNome.length} controlli senza nome.`)
process.exit(senzaNome.length > 0 ? 1 : 0)
