/**
 * Lint statico (ondata 6): le etichette dei CI si chiedono al metamodello del
 * tenant, non a una lista.
 *
 * `lib/ciLabels.ts` conteneva sedici etichette scritte a mano, e il commento
 * del file lo ammetteva: «aggiungere un tipo di CI vuol dire toccare QUESTO
 * file». Diciassette consumatori ne dipendevano, quindi un tipo creato dal
 * cliente esisteva nel grafo e non contava in nessuno di quei posti — impatto,
 * mappe, ricerca, gruppi dinamici — quasi sempre in silenzio.
 *
 * L'ondata 6 li ha convertiti tutti a `ciLabelsForTenant`. Questa regola
 * meccanica impedisce che la prossima query riapra il buco: fuori dai moduli
 * del NUCLEO, nessuno nomina più le liste statiche. Il nucleo le usa come seme
 * dei tipi spediti col prodotto, ed è l'unico che può.
 *
 * Un caso legittimo si marca con `// ci-labels-ok:` sulla riga stessa o su
 * quella precedente, con la motivazione — come per gli altri lint di questo
 * repo (`tenantScoping`, `enumScoping`, `tenantOnCreate`).
 *
 * Perimetro: tutta l'API. Fuori: i test e `src/scripts/` (strumenti da riga di
 * comando, come negli altri lint).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here   = dirname(fileURLToPath(import.meta.url))
const apiSrc = join(here, '../..')

/** I soli file che possono nominare le liste statiche: sono il seme. */
const CORE = new Set([
  'lib/ciLabels.ts',              // la definizione
  'lib/ciLabelsForTenant.ts',     // unisce il seme ai tipi del tenant
  'lib/ciTypeNameToLabel.ts',     // il verso nome → etichetta
  'lib/ciMetamodelForTenant.ts',  // relazioni e ruoli dal metamodello
])

const STATIC_SOURCES = ['ALL_CI_LABELS', 'TYPE_TO_LABEL']
const EXCLUDED_DIRS  = new Set(['__tests__', 'scripts', 'node_modules', 'dist'])

function listFiles(root: string): string[] {
  const out: string[] = []
  for (const f of readdirSync(root)) {
    const child = join(root, f)
    if (statSync(child).isDirectory()) {
      if (!EXCLUDED_DIRS.has(f)) out.push(...listFiles(child))
    } else if (f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts')) {
      out.push(child)
    }
  }
  return out
}

interface Offender { file: string; line: number; text: string }

function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

export function scanStaticLabelUse(content: string, displayName: string): Offender[] {
  const lines = content.split('\n')
  const out: Offender[] = []
  lines.forEach((line, i) => {
    if (isComment(line)) return
    if (!STATIC_SOURCES.some((s) => line.includes(s))) return
    if (line.includes('ci-labels-ok') || (lines[i - 1] ?? '').includes('ci-labels-ok')) return
    out.push({ file: displayName, line: i + 1, text: line.trim() })
  })
  return out
}

describe('lint: nessuna lista statica di etichette CI fuori dal nucleo', () => {
  it('nessun file dell\'API nomina ALL_CI_LABELS o TYPE_TO_LABEL', () => {
    const offenders: Offender[] = []
    for (const file of listFiles(apiSrc)) {
      const rel = relative(apiSrc, file).split('\\').join('/')
      if (CORE.has(rel)) continue
      offenders.push(...scanStaticLabelUse(readFileSync(file, 'utf8'), rel))
    }
    expect(
      offenders.map((o) => `${o.file}:${o.line}  ${o.text}`),
      'Chiedi le etichette al metamodello del tenant (`ciLabelsForTenant`), non a una lista statica: ' +
      'un tipo creato dal cliente non entrerebbe in impatto, mappe, ricerca e gruppi dinamici. ' +
      'Se il caso è legittimo, marcalo con `// ci-labels-ok: <motivo>`.',
    ).toEqual([])
  })

  it('il lint riconosce un uso nuovo e accetta la marcatura motivata', () => {
    expect(scanStaticLabelUse("const x = ALL_CI_LABELS.join('|')", 'finto.ts')).toHaveLength(1)
    expect(scanStaticLabelUse("// ci-labels-ok: seme dei tipi spediti\nconst x = ALL_CI_LABELS", 'finto.ts')).toHaveLength(0)
    expect(scanStaticLabelUse("const x = TYPE_TO_LABEL['server'] // ci-labels-ok: prova", 'finto.ts')).toHaveLength(0)
    // un commento che ne parla non è un uso
    expect(scanStaticLabelUse(' * prima qui c\'era ALL_CI_LABELS', 'finto.ts')).toHaveLength(0)
  })
})
