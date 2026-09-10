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
import { parse, validate, buildSchema, specifiedRules, type DocumentNode } from 'graphql'
import { buildBaseSDL } from '../schema-base.js'

const here = dirname(fileURLToPath(import.meta.url))
const webGraphql = join(here, '../../../../web/src/graphql')

// File ITSM del frontend (query + mutation) + i file per dominio in cui è
// stato spezzato l'ex catch-all `admin.ts` (E-17; `admin.ts` è ora un barrel
// di soli re-export, senza documenti). I documenti CMDB usano tipi generati
// dinamicamente e restano fuori. `mutations/ci.ts` resta fuori perché
// CREATE_CI_TYPE/ADD_CI_FIELD/ADD_CI_RELATION… vivono nello schema del metamodello.
// `fragments.ts` non è nell'elenco: un documento di soli fragment non valida
// da solo (NoUnusedFragments); i fragment vengono validati inlined nei
// documenti che li interpolano (vedi resolveInterpolations).
const FILES = [
  'queries/incident.ts', 'queries/problem.ts', 'queries/change.ts',
  'queries/ci.ts', 'queries/workflow.ts',
  'mutations/incident.ts', 'mutations/problem.ts', 'mutations/change.ts',
  'mutations/workflow.ts',
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

// Solo lo schema base: i tipi CI concreti sono generati dal metamodello, ma i
// documenti ITSM selezionano campi dell'interfaccia CIBase (che è nel base SDL)
// e un'interfaccia senza implementazioni è uno schema valido per validate().
const schema = buildSchema(buildBaseSDL())

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
