#!/usr/bin/env node
/**
 * «INVIO O SPAZIO ATTIVA» SI SCRIVE IN UN POSTO SOLO (22 set 2026).
 *
 * ## Che cosa e' andato storto
 * `lib/a11y.ts` porta `keyActivate`, l'equivalente da tastiera di `onClick`
 * per gli elementi che non possono essere un `<button>` — una riga di tabella,
 * una card che contiene gia' un bottone. Lo usavano in due posti. In altri
 * cinque la stessa cosa era riscritta a mano:
 *
 *     onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { … } }}
 *
 * Sembra identico. Non lo e': a `keyActivate` manca una riga che le copie non
 * avevano,
 *
 *     if (e.target !== e.currentTarget) return
 *
 * e senza quella riga lo Spazio premuto su un CONTROLLO ANNIDATO risale al
 * contenitore e attiva anche lui. In `SimpleTable` voleva dire che premere
 * Spazio su una casella dentro una riga apriva anche la riga; in `FormCanvas`
 * che lo Spazio sulla maniglia di trascinamento selezionava anche il campo.
 * Due difetti veri, nati dal copiare tre righe invece di importarne una.
 *
 * ## La regola
 * Un `onKeyDown` che guarda sia `Enter` sia lo spazio deve essere
 * `keyActivate(...)`. Chi ha bisogno di altro — Ctrl+Invio che manda un
 * messaggio, le frecce di una tendina, Invio che conferma un campo — guarda
 * UN tasto solo e non passa di qui.
 *
 * Uso: node scripts/check-attiva-da-tastiera.mjs
 */
import ts from 'typescript'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const RADICE = process.cwd()
const CARTELLE = ['apps/web/src', 'apps/portal/src']

function tsxIn(dir, fuori = []) {
  for (const v of readdirSync(dir)) {
    const p = join(dir, v)
    if (statSync(p).isDirectory()) { if (v !== 'node_modules' && v !== 'dist' && v !== 'test') tsxIn(p, fuori) }
    else if (v.endsWith('.tsx') && !v.endsWith('.test.tsx')) fuori.push(p)
  }
  return fuori
}

/** I letterali di stringa confrontati con `.key` dentro questo sottoalbero. */
function tastiGuardati(nodo, sf) {
  const tasti = new Set()
  const visita = (n) => {
    if (ts.isBinaryExpression(n)
        && (n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
         || n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)) {
      const [a, b] = [n.left, n.right]
      const guardaKey = (x) => ts.isPropertyAccessExpression(x) && x.name.getText(sf) === 'key'
      const letterale = (x) => ts.isStringLiteral(x) ? x.text : null
      if (guardaKey(a) && letterale(b) !== null) tasti.add(letterale(b))
      if (guardaKey(b) && letterale(a) !== null) tasti.add(letterale(a))
    }
    ts.forEachChild(n, visita)
  }
  visita(nodo)
  return tasti
}

const errori = []

for (const file of CARTELLE.flatMap((c) => tsxIn(join(RADICE, c)))) {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const rel = relative(RADICE, file)

  const visita = (n) => {
    if (ts.isJsxAttribute(n) && n.name.getText(sf) === 'onKeyDown' && n.initializer
        && ts.isJsxExpression(n.initializer) && n.initializer.expression) {
      const tasti = tastiGuardati(n.initializer.expression, sf)
      if (tasti.has('Enter') && tasti.has(' ')) {
        const testo = n.initializer.getText(sf)
        if (!testo.includes('keyActivate')) {
          const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf))
          errori.push(
            `${rel}:${line + 1}  onKeyDown guarda Enter e Spazio scritti a mano: usa keyActivate() di lib/a11y. `
            + `A mano si perde «if (e.target !== e.currentTarget) return», e lo Spazio su un controllo annidato attiva anche il contenitore.`,
          )
        }
      }
    }
    ts.forEachChild(n, visita)
  }
  visita(sf)
}

for (const e of errori) console.error(`ERROR ${e}`)
console.log(`check-attiva-da-tastiera: ${errori.length} copie a mano di «Invio o Spazio attiva».`)
process.exit(errori.length > 0 ? 1 : 0)
