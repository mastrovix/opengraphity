/**
 * Lint strutturale: ogni mappa di tipo esposta da un modulo di resolver deve
 * essere UNITA nello schema.
 *
 * ## Il difetto che questo test chiude
 * `resolvers/index.ts` unisce i resolver **tipo per tipo, a mano**
 * (`...workflowResolvers.Query`, `...workflowResolvers.Incident`, …). Un
 * modulo che espone una mappa nuova senza che qualcuno la aggiunga a quella
 * lista resta **senza resolver**, e nessun test lo vede: i test unitari
 * chiamano la funzione direttamente, e lo SDL dichiara il campo comunque.
 *
 * È successo con `WorkflowStep.currentInstances` (ondata 2): lo schema
 * dichiarava `Int!`, il resolver predefinito restituiva `undefined`, e aprire
 * il disegnatore dava «Cannot return null for non-nullable field
 * WorkflowStep.currentInstances» — cioè la pagina non si apriva. Il campo
 * funzionava in tutti i test, perché i test non passano dallo schema.
 *
 * ## Come funziona
 * Si costruisce lo schema vero (nessun tipo CI del cliente: basta la parte
 * base) e per ogni campo dichiarato dai moduli si verifica che il campo dello
 * schema abbia un `resolve` proprio. Un campo che nello schema non esiste
 * affatto è un errore diverso e lo si dice: significa SDL e resolver divergenti.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@opengraphity/neo4j', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opengraphity/neo4j')>()
  return { ...actual, getSession: () => { throw new Error('nessuna query in questo test') } }
})

const { buildResolvers } = await import('../resolvers/index.js')
const { buildBaseSDL } = await import('../schema-base.js')
const { makeExecutableSchema } = await import('@graphql-tools/schema')
const { generateSDL, metamodelSDL } = await import('@opengraphity/schema-generator')

/** I moduli che espongono mappe di tipo oltre a Query/Mutation. */
const MODULES = {
  workflow:   await import('../resolvers/workflow.js').then((m) => m.workflowResolvers),
  incident:   await import('../resolvers/incident.js').then((m) => m.incidentResolvers),
  change:     await import('../resolvers/change/index.js').then((m) => m.changeResolvers),
  events:     await import('../resolvers/events.js').then((m) => m.eventResolvers),
  services:   await import('../resolvers/services.js').then((m) => m.serviceResolvers),
  problem:    await import('../resolvers/problem.js').then((m) => m.problemResolvers),
} as Record<string, Record<string, unknown>>

/** Query e Mutation sono uniti per campo e già coperti dai test di RBAC. */
const SKIP = new Set(['Query', 'Mutation'])

describe('ogni mappa di tipo dei moduli è unita nello schema', () => {
  it('nessun campo dichiarato da un modulo resta senza resolver', () => {
    const schema = makeExecutableSchema({
      typeDefs:  [buildBaseSDL(), generateSDL([]) || metamodelSDL()],
      resolvers: buildResolvers([]),
    })

    const missing: string[] = []
    const notInSchema: string[] = []

    for (const [moduleName, resolverMap] of Object.entries(MODULES)) {
      for (const [typeName, fields] of Object.entries(resolverMap)) {
        if (SKIP.has(typeName) || typeof fields !== 'object' || fields === null) continue
        const type = schema.getType(typeName) as { getFields?: () => Record<string, { resolve?: unknown }> } | undefined
        if (!type?.getFields) { notInSchema.push(`${moduleName}: tipo ${typeName}`); continue }
        const schemaFields = type.getFields()
        for (const fieldName of Object.keys(fields as Record<string, unknown>)) {
          const f = schemaFields[fieldName]
          if (!f) { notInSchema.push(`${moduleName}: ${typeName}.${fieldName}`); continue }
          if (typeof f.resolve !== 'function') missing.push(`${moduleName}: ${typeName}.${fieldName}`)
        }
      }
    }

    expect(
      notInSchema,
      'Questi campi hanno un resolver ma non esistono nello SDL: resolver e schema sono divergenti.',
    ).toEqual([])
    expect(
      missing,
      'Questi campi sono dichiarati da un modulo di resolver ma NON sono uniti in `resolvers/index.ts`: ' +
      'lo schema li dichiara e il resolver predefinito restituisce `undefined`, quindi un campo non ' +
      'nullable fa fallire l\'intera richiesta («Cannot return null for non-nullable field»). ' +
      'Aggiungi la mappa di tipo alla lista in `buildResolvers`.',
    ).toEqual([])
  })
})
