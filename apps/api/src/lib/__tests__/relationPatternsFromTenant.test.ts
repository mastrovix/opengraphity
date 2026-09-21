/**
 * LE TRAVERSATE DEI CI SEGUONO LE RELAZIONI DEL TENANT (revisione del 15 set 2026 · CM-3).
 *
 * `impactRelPatternForTenant` era dichiarata «una sorgente sola», ma cinque
 * traversate — il blast radius del grafo nel dettaglio del CI, il what-if,
 * l'impatto della change, le catene, le applicazioni impattate dall'incident —
 * avevano ognuna la sua lista scritta nel codice: tre senza `INSTALLED_ON`,
 * nessuna con le relazioni del cliente. Dal vivo un arco `PROTECTS` fra firewall
 * e server entrava nell'impatto e non nel blast radius dello stesso server.
 *
 * Il guardiano: nessun sorgente scrive una lista di tipi di relazione dei CI
 * (`-[:DEPENDS_ON|HOSTED_ON…`). Chi la vuole la chiede a
 * `lib/ciMetamodelForTenant.ts`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SERVICE_RELATIONSHIP_TYPES } from '../serviceVocabularies.js'

const SRC = join(process.cwd(), 'src')
const CORE = SERVICE_RELATIONSHIP_TYPES.join('|')
// `[:A|B` o `[r:A|B` con almeno due tipi, di cui il primo è uno dei quattro spediti.
const LITERAL_LIST = new RegExp(String.raw`\[\w*:(${CORE})\|`)

function sorgenti(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (!['__tests__', 'migrations', 'scripts'].includes(e.name)) out.push(...sorgenti(p)) }
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** Le righe di codice, senza i commenti (dove un esempio è lecito). */
function codice(text: string): string[] {
  return text.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
}

describe('nessuna lista di tipi di relazione scritta nel codice', () => {
  it.each(['graphql/resolvers/dynamic-ci.ts', 'graphql/resolvers/whatif.ts', 'graphql/resolvers/change/queries.ts', 'lib/chainCalculator.ts', 'graphql/resolvers/incident.ts'])(
    '%s legge le relazioni dal tenant', (file) => {
      const text = readFileSync(join(SRC, file), 'utf8')
      expect(text).toMatch(/(impactRelPatternForTenant|serviceRelPatternForTenant)\(/)
    })

  it('in tutta l\'API nessun sorgente elenca i tipi di relazione dei CI a mano', () => {
    const colpevoli: string[] = []
    for (const file of sorgenti(SRC)) {
      for (const line of codice(readFileSync(file, 'utf8'))) {
        if (LITERAL_LIST.test(line)) colpevoli.push(`${file.slice(SRC.length + 1)}: ${line.trim()}`)
      }
    }
    expect(colpevoli, 'Usa serviceRelPatternForTenant / impactRelPatternForTenant (lib/ciMetamodelForTenant.ts): '
      + 'una lista scritta qui ignora le relazioni del cliente e diverge dalle altre viste.').toEqual([])
  })
})
