/**
 * Lint statico: chi **scrive** il metamodello tira la leva dell'invalidazione.
 *
 * ## Il difetto che questa regola chiude
 * L'ondata 5 ha dato al metamodello un punto unico —
 * `invalidateSchema(tenantId)`, che svuota le cache di questo processo e
 * pubblica sul canale Redis perché gli altri svuotino le loro — e dieci cache
 * vi si sono iscritte. Ma le mutation aggiunte dopo, che rendono
 * personalizzabili proprio le cose per cui il canale esiste, non lo chiamavano:
 * `resolvers/enumType.ts` non lo importava nemmeno, e le matrici di dominio e i
 * tipi di change pre-approvati svuotavano solo la **loro** cache locale.
 * Misurato dal vivo nella revisione delle otto ondate: 0 messaggi sul canale
 * per `updateEnumType`, `customizeEnumType`, `updateDomainMatrix` e
 * `updatePreApprovedChangeTypes`, contro 1 per `addCIField`. Conseguenza: dopo
 * una rinomina nel Dizionario lo stesso processo API rifiutava il valore nuovo
 * e accettava quello rimosso — e i worker, che non servono mai quelle
 * mutation, per sempre.
 *
 * Non era un errore di ragionamento in un posto: era il fatto che **niente lo
 * verificava**. Da qui una regola meccanica.
 *
 * ## La regola
 * Nel perimetro che serve le richieste dei clienti (`graphql/resolvers/`,
 * `rest/`), un file che contiene una query Cypher che **scrive** un nodo del
 * metamodello (`EnumTypeDefinition`, `DomainMatrix`, `CITypeDefinition`,
 * `CIFieldDefinition`, `ITILTypeDefinition`, o la proprietà
 * `pre_approved_change_types` del tenant) deve chiamare `invalidateSchema(`.
 *
 * Fuori perimetro, e perché:
 *  - `scripts/` (migrazioni, seed, onboarding): processi a colpo singolo, dove
 *    non esiste nessuna cache viva da svuotare né nessun altro processo da
 *    avvisare. `lib/seedEnumTypes.ts` e `lib/domainMatrixSeed.ts` sono chiamati
 *    solo da lì (verificato: nessun chiamante in `graphql/` o `rest/`);
 *  - `lib/`: non è un perimetro di richiesta. L'unica eccezione è verificata a
 *    parte qui sotto, perché è una scrittura di mutation che vive in un lib:
 *    `setPreApprovedChangeTypes`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here   = dirname(fileURLToPath(import.meta.url))
const apiSrc = join(here, '../..')

/** Le etichette e le proprietà che sono metamodello del cliente. */
const METAMODEL = [
  'EnumTypeDefinition',
  'DomainMatrix',
  'CITypeDefinition',
  'CIFieldDefinition',
  'CIRelationDefinition',
  'ITILTypeDefinition',
  'pre_approved_change_types',
]

/**
 * Cosa conta come scrittura del metamodello, e cosa no.
 *
 * Non basta che la query nomini l'etichetta: `questionAdmin.ts` fa
 * `MATCH (ct:CITypeDefinition) MERGE (ct)-[:HAS_QUESTION]->(q) SET rel.weight`
 * — tocca una **relazione verso altro**, non la definizione del tipo, e nessuna
 * cache del metamodello ne dipende. Conta se il nodo del metamodello è
 * **creato** (`MERGE`/`CREATE` sul suo binding) o se è lui l'oggetto di un
 * `SET`/`REMOVE`/`DELETE`.
 */
const CLAUSE_BEFORE = /\b(OPTIONAL\s+MATCH|MATCH|MERGE|CREATE)\b(?![\s\S]*\b(?:OPTIONAL\s+MATCH|MATCH|MERGE|CREATE)\b)/

function listFiles(root: string): string[] {
  const out: string[] = []
  for (const f of readdirSync(root)) {
    const child = join(root, f)
    if (statSync(child).isDirectory()) {
      if (f !== '__tests__' && f !== 'node_modules' && f !== 'dist') out.push(...listFiles(child))
    } else if (f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts')) {
      out.push(child)
    }
  }
  return out
}

/**
 * I letterali template (le query Cypher stanno tutte lì). Si guarda dentro il
 * letterale e non la riga, perché la clausola di scrittura e l'etichetta sono
 * su righe diverse — ed è il letterale intero a essere una query.
 */
function templateLiterals(src: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < src.length) {
    const start = src.indexOf('`', i)
    if (start === -1) break
    let j = start + 1
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue }
      if (src[j] === '`') break
      j += 1
    }
    out.push(src.slice(start + 1, j))
    i = j + 1
  }
  return out
}

function writesMetamodel(src: string): string[] {
  const hits: string[] = []
  const add = (label: string): void => { if (!hits.includes(label)) hits.push(label) }

  for (const lit of templateLiterals(src)) {
    // La proprietà del tenant: è metamodello anche se non è un nodo suo.
    if (/\bSET\s+\w+\.pre_approved_change_types\b/.test(lit)) add('pre_approved_change_types')

    for (const label of METAMODEL) {
      if (label === 'pre_approved_change_types') continue
      const binding = new RegExp(`\\((\\w+)\\s*:\\s*${label}\\b`, 'g')
      let m: RegExpExecArray | null
      while ((m = binding.exec(lit)) !== null) {
        const variable = m[1]!
        const clause   = CLAUSE_BEFORE.exec(lit.slice(0, m.index))?.[1]?.toUpperCase()
        // Creato qui: è una scrittura del nodo.
        if (clause === 'MERGE' || clause === 'CREATE') { add(label); continue }
        // Letto qui, ma poi modificato o cancellato: anche.
        const touched = new RegExp(`\\b(?:SET|REMOVE)\\s+${variable}\\.|\\b(?:DETACH\\s+)?DELETE\\s+(?:[\\w\\s,]*\\b)?${variable}\\b`)
        if (touched.test(lit)) add(label)
      }
    }
  }
  return hits
}

describe('chi scrive il metamodello tira la leva dell\'invalidazione', () => {
  const perimeter = [join(apiSrc, 'graphql/resolvers'), join(apiSrc, 'rest')]
    .flatMap((d) => listFiles(d))

  it('il perimetro contiene i file attesi (la regola non è vacua)', () => {
    const names = perimeter.map((f) => relative(apiSrc, f))
    expect(names).toContain('graphql/resolvers/enumType.ts')
    expect(names).toContain('graphql/resolvers/domainMatrix.ts')
    expect(names).toContain('graphql/resolvers/ciTypeMetamodel.ts')
    expect(names.length).toBeGreaterThan(20)
  })

  it('nessuna scrittura di metamodello senza `invalidateSchema`', () => {
    const offenders: { file: string; labels: string[] }[] = []
    for (const file of perimeter) {
      const src    = readFileSync(file, 'utf8')
      const labels = writesMetamodel(src)
      if (labels.length === 0) continue
      if (!src.includes('invalidateSchema(')) offenders.push({ file: relative(apiSrc, file), labels })
    }
    expect(offenders, offenders.map((o) => `${o.file} scrive [${o.labels.join(', ')}] e non chiama invalidateSchema()`).join('\n')).toEqual([])
  })

  it('i quattro file che scrivono metamodello sono riconosciuti come tali', () => {
    const writers = perimeter
      .filter((f) => writesMetamodel(readFileSync(f, 'utf8')).length > 0)
      .map((f) => relative(apiSrc, f))
      .sort()
    // Se questa lista cambia, è una scrittura di metamodello nuova: va bene,
    // ma deve passare dalla riga sopra (e da questa).
    expect(writers).toEqual([
      'graphql/resolvers/ciTypeMetamodel.ts',
      'graphql/resolvers/domainMatrix.ts',
      'graphql/resolvers/enumType.ts',
      'graphql/resolvers/itilTypeResolvers.ts',
    ])
  })

  it('`setPreApprovedChangeTypes` tira la leva dov\'è la scrittura', () => {
    const src = readFileSync(join(apiSrc, 'lib/changePolicy.ts'), 'utf8')
    const fn  = src.slice(src.indexOf('export async function setPreApprovedChangeTypes'))
    expect(fn).toContain('invalidateSchema(tenantId)')
  })

  it('ogni mutation dei vocabolari invalida: nessuna esclusa', () => {
    const src = readFileSync(join(apiSrc, 'graphql/resolvers/enumType.ts'), 'utf8')
    for (const name of ['createEnumType', 'updateEnumType', 'deleteEnumType', 'customizeEnumType']) {
      const start = src.indexOf(`export async function ${name}(`)
      expect(start, `${name} non trovata`).toBeGreaterThan(-1)
      const next = ['createEnumType', 'updateEnumType', 'deleteEnumType', 'customizeEnumType', 'export const enumTypeResolvers']
        .map((n) => src.indexOf(n === 'export const enumTypeResolvers' ? n : `export async function ${n}(`))
        .filter((i) => i > start)
      const body = src.slice(start, Math.min(...next, src.length))
      expect(body, `${name} non chiama vocabularyChanged()`).toContain('vocabularyChanged(ctx.tenantId)')
    }
  })
})
