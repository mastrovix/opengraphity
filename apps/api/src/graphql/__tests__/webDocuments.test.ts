/**
 * Contratto API ↔ web: ogni documento GraphQL ITSM del frontend deve validare
 * contro lo schema base dell'API.
 *
 * È la verifica meccanica che mancava: una selection su un campo inesistente
 * (es. `relatedChanges { type status }`), una query verso un campo Query non
 * dichiarato o una variabile non usata passavano inosservate fino al runtime.
 * Qui i documenti vengono estratti dal sorgente (gql`…`) e validati con
 * graphql-js contro buildBaseSDL(); le parti dinamiche dello schema (tipi CI
 * generati dal metamodello) sono fuori dal perimetro di questi file.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parse, validate, buildSchema, specifiedRules, isInputObjectType,
  type DocumentNode, type OperationDefinitionNode, type TypeNode,
} from 'graphql'
import { metamodelSDL } from '@opengraphity/schema-generator'
import { buildBaseSDL } from '../schema-base.js'

const here = dirname(fileURLToPath(import.meta.url))
const webGraphql = join(here, '../../../../web/src/graphql')

// File ITSM del frontend (query + mutation) + i file per dominio in cui è
// stato spezzato l'ex catch-all `admin.ts` (E-17; `admin.ts` è ora un barrel
// di soli re-export, senza documenti). I documenti CMDB usano tipi generati
// dinamicamente e restano fuori. `mutations/ci.ts` è DENTRO (B0-1): la parte
// statica dello schema del metamodello (createCIType/addCIField/… e i loro
// input) è esportata da @opengraphity/schema-generator come `metamodelSDL()` e
// concatenata allo schema base qui sotto, quindi non c'è più motivo di
// escluderlo — l'esclusione a mano è ciò che ha lasciato passare per mesi il
// `chainFamilies` che `UpdateCITypeInput` non dichiarava.
// `fragments.ts` non è nell'elenco: un documento di soli fragment non valida
// da solo (NoUnusedFragments); i fragment vengono validati inlined nei
// documenti che li interpolano (vedi resolveInterpolations).
const FILES = [
  'queries/incident.ts', 'queries/problem.ts', 'queries/change.ts',
  'queries/ci.ts', 'queries/workflow.ts',
  'mutations/incident.ts', 'mutations/problem.ts', 'mutations/change.ts',
  'mutations/workflow.ts',
  // Metamodello dei CI (B0-1): validato contro schema base + metamodelSDL().
  'mutations/ci.ts',
  // ex queries/admin.ts
  'queries/users.ts', 'queries/teams.ts', 'queries/reports.ts', 'queries/dashboard.ts',
  'queries/anomaly.ts', 'queries/enum.ts', 'queries/notifications.ts', 'queries/queue.ts',
  'queries/rules.ts', 'queries/automation.ts', 'queries/sla.ts', 'queries/collaboration.ts',
  'queries/whatIf.ts', 'queries/catalog.ts',
  // ex mutations/admin.ts
  'mutations/serviceRequest.ts', 'mutations/teams.ts', 'mutations/reports.ts', 'mutations/dashboard.ts',
  'mutations/notifications.ts', 'mutations/itil.ts', 'mutations/enum.ts', 'mutations/queue.ts',
  'mutations/rules.ts', 'mutations/automation.ts', 'mutations/sla.ts', 'mutations/collaboration.ts',
  'mutations/catalog.ts',
  // Event Management (ondata 1)
  'queries/events.ts', 'mutations/events.ts',
  // Servizi monitorati (mappa del servizio e albero d'impatto)
  'queries/services.ts', 'mutations/services.ts',
]

// Documenti admin esclusi ESPLICITAMENTE, con motivo. Ogni nuova esclusione
// deve dichiarare il perché — mai un'allowlist "a prescindere".
//
// Change Catalog: l'API (changeCatalogCategories, standardChangeCatalog,
// createChangeFromCatalog, …) è stata rimossa in 00023d0 ma i documenti web
// sono rimasti; nessun componente li importa. Vanno eliminati da
// queries/admin.ts e mutations/admin.ts (fuori dal perimetro report/dashboard
// di questa tranche), dopodiché queste righe spariscono.
const EXCLUDED_DOCUMENTS: Record<string, string> = {}

/** Tutti i template gql`…` di un sorgente (anche non esportati), per nome. */
function collectTemplates(source: string): Map<string, string> {
  const map = new Map<string, string>()
  const re = /(?:export )?const (\w+) = gql`([\s\S]*?)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) map.set(m[1]!, m[2]!)
  return map
}

// Fragment condivisi (`${USER_REF}`, `${TEAM_REF}`): risolti inlined, così la
// selezione dei fragment viene validata contro lo schema come il resto.
const sharedFragments = collectTemplates(readFileSync(join(webGraphql, 'fragments.ts'), 'utf8'))

/**
 * Sostituisce ogni `${NAME}` con il template omonimo (stesso file o
 * fragments.ts), ricorsivamente. Un riferimento non risolvibile è un errore
 * del test, non un documento "saltato" in silenzio.
 */
function resolveInterpolations(body: string, local: Map<string, string>, owner: string, depth = 0): string {
  if (depth > 5) throw new Error(`${owner}: interpolazioni annidate oltre il limite (ciclo?)`)
  return body.replace(/\$\{(\w+)\}/g, (_all, name: string) => {
    const ref = local.get(name) ?? sharedFragments.get(name)
    if (ref === undefined) throw new Error(`${owner}: interpolazione \${${name}} non risolvibile (né nel file né in fragments.ts)`)
    return resolveInterpolations(ref, local, owner, depth + 1)
  })
}

/** Estrae ogni documento esportato, con le interpolazioni di fragment risolte. */
function extractDocuments(source: string): Array<{ name: string; doc: DocumentNode }> {
  const out: Array<{ name: string; doc: DocumentNode }> = []
  const local = collectTemplates(source)
  const re = /export const (\w+) = gql`([\s\S]*?)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    out.push({ name: m[1]!, doc: parse(resolveInterpolations(m[2]!, local, m[1]!)) })
  }
  return out
}

// Schema base + parte STATICA del metamodello: i tipi CI concreti sono
// generati per tenant, ma i documenti ITSM selezionano campi dell'interfaccia
// CIBase (che è nel base SDL) e un'interfaccia senza implementazioni è uno
// schema valido per validate(). `metamodelSDL()` aggiunge le mutation del
// disegnatore dei tipi CI e i loro input (B0-1).
const schema = buildSchema(buildBaseSDL() + metamodelSDL())

// Regola "variabile non usata": graphql-js la include già (NoUnusedVariablesRule).
const rules = specifiedRules

describe('documenti GraphQL del web ITSM ↔ schema API', () => {
  const stubbed = readdirSync(webGraphql).length > 0
  it('la cartella dei documenti web esiste', () => {
    expect(stubbed).toBe(true)
  })

  for (const rel of FILES) {
    const source = readFileSync(join(webGraphql, rel), 'utf8')
    const docs = extractDocuments(source)
    it(`${rel}: contiene documenti`, () => {
      expect(docs.length).toBeGreaterThan(0)
    })
    for (const { name, doc } of docs) {
      const excludedWhy = EXCLUDED_DOCUMENTS[name]
      if (excludedWhy) {
        it.skip(`${rel} › ${name} (escluso: ${excludedWhy})`, () => {})
        continue
      }
      it(`${rel} › ${name} valida contro lo schema`, () => {
        const errors = validate(schema, doc, rules)
        expect(errors.map((e) => e.message)).toEqual([])
      })
    }
  }

  it('ogni documento in EXCLUDED_DOCUMENTS esiste davvero (niente esclusioni fantasma)', () => {
    const all = new Set(FILES.flatMap((rel) => extractDocuments(readFileSync(join(webGraphql, rel), 'utf8')).map((d) => d.name)))
    for (const name of Object.keys(EXCLUDED_DOCUMENTS)) expect(all.has(name), name).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Parte 2 (B0-1): le VARIABILI passate dal web ↔ gli input dello schema.
//
// Il buco che ha fatto passare A-7: il documento `UPDATE_CI_TYPE` era valido
// (`$input: UpdateCITypeInput!` esiste), ma la pagina metteva dentro l'oggetto
// una chiave — `chainFamilies` — che quell'input non dichiarava. Nessun
// controllo statico la vedeva e Apollo rifiutava OGNI salvataggio a runtime.
// Qui i siti di chiamata del web vengono letti dal sorgente: le chiavi
// letterali dell'oggetto `variables` devono essere variabili dichiarate dal
// documento, e le chiavi letterali di un oggetto passato a una variabile di
// tipo input devono essere campi di quell'input.
// ─────────────────────────────────────────────────────────────────────────────

const webSrc = join(here, '../../../../web/src')

/** Tutti i .ts/.tsx sotto una cartella. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(p)
  }
  return out
}

/** Indice nome documento → documento GraphQL, su TUTTI i file di graphql/. */
function indexAllDocuments(): Map<string, DocumentNode> {
  const index = new Map<string, DocumentNode>()
  for (const file of walk(webGraphql)) {
    const source = readFileSync(file, 'utf8')
    const local = collectTemplates(source)
    const re = /export const (\w+) = gql`([\s\S]*?)`/g
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) {
      const name = m[1]!
      // Un documento di soli fragment non è un'operazione: lo salta.
      const doc = parse(resolveInterpolations(m[2]!, local, name))
      if (doc.definitions.some((d) => d.kind === 'OperationDefinition')) index.set(name, doc)
    }
  }
  return index
}

/** Indice dell'ultima `}` che chiude la `{` all'indice `open`. */
function matchBrace(src: string, open: number): number {
  let depth = 0
  let quote: string | null = null
  for (let i = open; i < src.length; i++) {
    const c = src[i]!
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '{' || c === '[' || c === '(') depth++
    else if (c === '}' || c === ']' || c === ')') { depth--; if (depth === 0) return i }
  }
  return -1
}

interface Entry { key: string | null; value: string }

/**
 * Voci di primo livello di un oggetto letterale (`body` senza le graffe
 * esterne). `key: null` = spread o chiave calcolata: non verificabile
 * staticamente, e viene saltata invece di essere indovinata.
 */
function objectEntries(body: string): Entry[] {
  const out: Entry[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  const push = (chunk: string) => {
    const s = chunk.trim()
    if (!s) return
    if (s.startsWith('...')) { out.push({ key: null, value: s }); return }
    const m = /^(?:(['"])([\w$]+)\1|([A-Za-z_$][\w$]*))\s*:([\s\S]*)$/.exec(s)
    if (!m) { out.push({ key: null, value: s }); return }   // shorthand / computed
    out.push({ key: m[2] ?? m[3]!, value: (m[4] ?? '').trim() })
  }
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '{' || c === '[' || c === '(') depth++
    else if (c === '}' || c === ']' || c === ')') depth--
    else if (c === ',' && depth === 0) { push(body.slice(start, i)); start = i + 1 }
  }
  push(body.slice(start))
  return out
}

/** Nome del tipo nudo di una variabile GraphQL (`[String!]!` → `String`). */
function namedType(t: TypeNode): string {
  return t.kind === 'NamedType' ? t.name.value : namedType(t.type)
}

/** Corpo di un oggetto letterale senza le graffe esterne. */
function objectBody(literal: string): string {
  return literal.slice(1, -1)
}

interface CallSite { file: string; hook: string; docName: string; variables: string }

/**
 * Siti di chiamata `NOME({ variables: { … } })` dove NOME è legato a un
 * documento via useMutation/useQuery/useLazyQuery, più le `useQuery(DOC, {
 * variables: … })` inline.
 */
function collectCallSites(): CallSite[] {
  const sites: CallSite[] = []
  for (const file of walk(webSrc)) {
    if (file.includes('/graphql/')) continue
    const src = readFileSync(file, 'utf8')

    // 1. useQuery/useMutation(DOC, { variables: {…} }) — variabili inline
    const inline = /use(?:Lazy)?(?:Query|Mutation|Subscription)\s*(?:<[\s\S]*?>)?\s*\(\s*([A-Z][A-Z0-9_]*)\s*,/g
    let m: RegExpExecArray | null
    while ((m = inline.exec(src)) !== null) {
      const open = src.indexOf('{', m.index + m[0].length - 1)
      if (open === -1) continue
      const close = matchBrace(src, open)
      if (close === -1) continue
      const options = src.slice(open + 1, close)
      const varsEntry = objectEntries(options).find((e) => e.key === 'variables')
      if (varsEntry && varsEntry.value.startsWith('{')) {
        sites.push({ file, hook: m[1]!, docName: m[1]!, variables: objectBody(varsEntry.value) })
      }
    }

    // 2. const [fn] = useMutation(DOC …) → fn({ variables: {…} })
    const bound = /const\s*\[\s*([A-Za-z_$][\w$]*)[^\]]*\]\s*=\s*use(?:Lazy)?(?:Query|Mutation)\s*(?:<[\s\S]*?>)?\s*\(\s*([A-Z][A-Z0-9_]*)/g
    const bindings = new Map<string, string>()
    while ((m = bound.exec(src)) !== null) bindings.set(m[1]!, m[2]!)
    for (const [fn, docName] of bindings) {
      const callRe = new RegExp(`\\b${fn}\\s*\\(\\s*\\{`, 'g')
      while ((m = callRe.exec(src)) !== null) {
        const open = src.indexOf('{', m.index + m[0].length - 1)
        const close = matchBrace(src, open)
        if (close === -1) continue
        const varsEntry = objectEntries(src.slice(open + 1, close)).find((e) => e.key === 'variables')
        if (varsEntry && varsEntry.value.startsWith('{')) {
          sites.push({ file, hook: fn, docName, variables: objectBody(varsEntry.value) })
        }
      }
    }
  }
  return sites
}

describe('variabili delle chiamate del web ↔ input dello schema API', () => {
  const documents = indexAllDocuments()
  const sites = collectCallSites()

  it('trova documenti e siti di chiamata (se questo scende a zero, il controllo non controlla più nulla)', () => {
    expect(documents.size).toBeGreaterThan(100)
    expect(sites.length).toBeGreaterThan(30)
  })

  it('ogni chiave letterale passata in `variables` è una variabile dichiarata dal documento', () => {
    const problems: string[] = []
    for (const site of sites) {
      const doc = documents.get(site.docName)
      if (!doc) continue   // documento non nel web/graphql (import esterno): niente da confrontare
      const op = doc.definitions.find((d): d is OperationDefinitionNode => d.kind === 'OperationDefinition')!
      const declared = new Set((op.variableDefinitions ?? []).map((v) => v.variable.name.value))
      for (const entry of objectEntries(site.variables)) {
        if (entry.key === null) continue
        if (!declared.has(entry.key)) {
          problems.push(`${site.file.replace(webSrc, 'web/src')}: ${site.hook} → ${site.docName} passa "${entry.key}", non dichiarata (dichiarate: ${[...declared].join(', ') || 'nessuna'})`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('ogni chiave letterale di un oggetto passato a una variabile di tipo input è un campo di quell\'input', () => {
    const problems: string[] = []
    for (const site of sites) {
      const doc = documents.get(site.docName)
      if (!doc) continue
      const op = doc.definitions.find((d): d is OperationDefinitionNode => d.kind === 'OperationDefinition')!
      const byName = new Map((op.variableDefinitions ?? []).map((v) => [v.variable.name.value, namedType(v.type)]))
      for (const entry of objectEntries(site.variables)) {
        if (entry.key === null || !entry.value.startsWith('{')) continue
        const typeName = byName.get(entry.key)
        if (!typeName) continue   // già segnalato dal test precedente
        const type = schema.getType(typeName)
        // I tipi input generati per tenant dal metamodello (Create<Tipo>Input)
        // non stanno nello schema statico: fuori perimetro, non un errore.
        if (!type || !isInputObjectType(type)) continue
        const fields = type.getFields()
        for (const field of objectEntries(objectBody(entry.value))) {
          if (field.key === null) continue
          if (!(field.key in fields)) {
            problems.push(`${site.file.replace(webSrc, 'web/src')}: ${site.hook} → ${site.docName}, $${entry.key} (${typeName}) non ha il campo "${field.key}"`)
          }
        }
      }
    }
    expect(problems).toEqual([])
  })
})
