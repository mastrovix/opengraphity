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

// File ITSM del frontend (query + mutation) + i file admin, che contengono i
// documenti report/dashboard (Ondata 2). I documenti CMDB usano tipi generati
// dinamicamente e restano fuori. `mutations/ci.ts` resta fuori perché
// CREATE_CI_TYPE/ADD_CI_FIELD/ADD_CI_RELATION… vivono nello schema del metamodello.
const FILES = [
  'queries/incident.ts', 'queries/problem.ts', 'queries/change.ts',
  'queries/ci.ts', 'queries/workflow.ts',
  'mutations/incident.ts', 'mutations/problem.ts', 'mutations/change.ts',
  'mutations/workflow.ts',
  'queries/admin.ts', 'mutations/admin.ts',
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

/** Estrae ogni template gql`…` senza interpolazioni. */
function extractDocuments(source: string): Array<{ name: string; doc: DocumentNode }> {
  const out: Array<{ name: string; doc: DocumentNode }> = []
  const re = /export const (\w+) = gql`([\s\S]*?)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    if (m[2]!.includes('${')) continue // frammenti interpolati: fuori perimetro
    out.push({ name: m[1]!, doc: parse(m[2]!) })
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
