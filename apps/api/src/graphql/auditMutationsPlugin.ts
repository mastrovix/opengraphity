/**
 * Il registro unico delle mutation (giro UI del 15 set 2026 · U-25, scelta del
 * proprietario).
 *
 * ## Il difetto
 * Su 257 mutation dell'API circa 120 non scrivevano nell'Audit Log: fra le
 * altre la creazione di un tipo CI, di un campo ITIL e di una policy SLA, il
 * collegamento di un CI a un incident, la creazione di una change, API key e
 * webhook. Chi doveva ricostruire «chi ha cambiato cosa» trovava un buco
 * proprio sulle scritture di configurazione.
 *
 * ## La regola
 * Ogni mutation RIUSCITA che non ha scritto una voce sua ne riceve una qui:
 * azione `mutation.<nome>`, tipo e id dell'entità (dal tipo restituito e dagli
 * argomenti), gli argomenti con i segreti oscurati. Le voci scritte a mano, con
 * il loro nome leggibile, restano e hanno la precedenza: il conto delle voci
 * della richiesta (`lib/auditScope.ts`) dice se la mutation ne ha già scritta
 * una. Una mutation nuova è coperta da sola; il test di guardia verifica il
 * meccanismo e che le esclusioni qui sotto esistano davvero.
 *
 * Le mutation di una richiesta vengono eseguite in sequenza (GraphQL), quindi
 * il confronto «prima/dopo» del conto è per mutation.
 */
import type { ApolloServerPlugin } from '@apollo/server'
import type { GraphQLContext } from '../context.js'
import { audit } from '../lib/audit.js'
import { auditsWrittenInScope } from '../lib/auditScope.js'
import { logger } from '../lib/logger.js'

const log = logger.child({ module: 'audit-registry' })

/**
 * Mutation che NON vanno nel registro, ognuna col suo perché: non cambiano
 * dati dell'organizzazione (letture, anteprime, esportazioni) o sono scelte
 * personali di chi le fa, e registrarle riempirebbe l'Audit Log di rumore.
 */
export const AUDIT_REGISTRY_SKIPPED: Readonly<Record<string, string>> = {
  markNotificationRead:      'personal inbox state',
  markAllNotificationsRead:  'personal inbox state',
  dismissAllNotifications:   'personal inbox state',
  watchEntity:               'personal subscription',
  unwatchEntity:             'personal subscription',
  setMyEmailNotifications:   'personal preference',
  setMyLanguage:             'personal preference',
  rateKBArticle:             'personal feedback vote',
  previewInboundEvents:      'dry-run, writes nothing',
  askReport:                 'question to the report assistant, writes no organization data',
  exportReportPDF:           'read-only export',
  exportReportExcel:         'read-only export',
}

const SECRET_KEY = /(secret|token|password|passwd|apikey|api_key|signing|credential|authorization|webhookurl|webhook_url|privatekey|private_key)/i
const MAX_STRING = 500
const MAX_ARRAY = 50
const MAX_DEPTH = 4

/** Gli argomenti per la voce: segreti oscurati, testi e liste lunghe tagliati. */
export function auditableArgs(value: unknown, depth = 0, key = ''): unknown {
  if (key && SECRET_KEY.test(key)) return value == null ? value : '[redacted]'
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (${value.length} chars)` : value
  if (depth >= MAX_DEPTH) return '[…]'
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((v) => auditableArgs(v, depth + 1))
    return value.length > MAX_ARRAY ? [...items, `… (${value.length} items)`] : items
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, auditableArgs(v, depth + 1, k)]))
  }
  return String(value)
}

const VERB = /^(create|update|delete|remove|add|set|assign|link|unlink|reorder|regenerate|test|save|complete|reopen|execute|resolve|retry|start|provision|edit|declare|escalate|send|approve|reject|request|cancel|apply|sync|customize|rename|adopt|acknowledge|upload|import|restore|publish|archive|move|clear|reset|toggle|enable|disable|close|take|put|mark|dismiss|confirm)/

/**
 * Il tipo dell'entità: l'oggetto restituito, altrimenti il nome della mutation
 * senza il verbo. Si legge dalla forma testuale del tipo («[Incident!]!») e non
 * con gli helper di `graphql`: con due copie del pacchetto nel workspace un
 * `isObjectType` di una copia rifiuta i tipi dell'altra.
 */
export function auditEntityType(fieldName: string, returnType: { toString(): string }, args: Record<string, unknown> = {}): string {
  const container = containerOf(fieldName, args)
  if (container) return container.type
  const name = String(returnType).replace(/[[\]!]/g, '')
  if (!BUILTIN_SCALARS.has(name) && /^[A-Z]/.test(name)) return name
  const noun = fieldName.replace(VERB, '')
  return noun ? noun.charAt(0).toUpperCase() + noun.slice(1) : fieldName
}

const BUILTIN_SCALARS = new Set(['Boolean', 'String', 'ID', 'Int', 'Float', 'JSON', 'DateTime', 'Upload'])

/**
 * «Aggiungi X A Y»: la voce è di Y. `addCIToChange(changeId, ciId)` restituisce
 * un `ChangeAffectedCI` senza id, e il registro scriveva il tipo del wrapper
 * con l'id della change (secondo giro UI del 15 set 2026). Quando il nome dice
 * a chi si aggiunge o da chi si toglie (`add…ToChange`, `remove…FromProblem`) e c'è
 * l'argomento `changeId`/`problemId`, l'entità è quella.
 */
function containerOf(fieldName: string, args: Record<string, unknown>): { type: string; id: string } | null {
  // Solo aggiungere/togliere: `assignIncidentToTeam` o `linkEventToCI` parlano del primo, non del secondo.
  const m = /^(?:add|remove)[A-Z][A-Za-z]*?(?:To|From)([A-Z][A-Za-z]*)$/.exec(fieldName)
  if (!m) return null
  const noun = m[1]!
  // `changeId` per «…ToChange»; anche `requestId` per «…FromServiceRequest».
  const key = Object.keys(args).find((k) => {
    const prefix = /^(.{3,})Id$/.exec(k)?.[1]
    return prefix !== undefined && noun.toLowerCase().endsWith(prefix.toLowerCase())
  })
  const id = key ? args[key] : undefined
  return (typeof id === 'string' || typeof id === 'number') && String(id) !== '' ? { type: noun, id: String(id) } : null
}

/** L'id dell'entità: il contenitore del nome, `id` fra gli argomenti o nell'input, poi l'id restituito, poi il primo argomento `…Id`. */
export function auditEntityId(args: Record<string, unknown>, result: unknown, fieldName = ''): string {
  const container = containerOf(fieldName, args)
  if (container) return container.id
  const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number') && String(v) !== '' ? String(v) : null
  const input = args['input'] as Record<string, unknown> | undefined
  const fromResult = result && typeof result === 'object' ? str((result as Record<string, unknown>)['id']) : null
  const firstId = Object.entries(args).find(([k, v]) => /Id$/.test(k) && str(v))?.[1]
  return str(args['id']) ?? str(input?.['id']) ?? fromResult ?? str(firstId) ?? ''
}

export function auditMutationsPlugin(): ApolloServerPlugin<GraphQLContext> {
  return {
    async requestDidStart() {
      return {
        async executionDidStart(requestContext) {
          if (requestContext.operation?.operation !== 'mutation') return
          return {
            willResolveField({ info, contextValue, args }) {
              if (info.parentType.name !== 'Mutation') return
              const before = auditsWrittenInScope()
              return (error, result) => {
                if (error || info.fieldName in AUDIT_REGISTRY_SKIPPED) return
                const after = auditsWrittenInScope()
                if (before === null || after === null) {
                  // Nessun registro possibile senza il conto della richiesta: si dice, non si tace.
                  log.error({ mutation: info.fieldName, tenantId: contextValue.tenantId }, 'Audit registry: the request has no audit scope, the mutation could not be checked for an audit entry')
                  return
                }
                if (after > before) return
                void audit(contextValue, `mutation.${info.fieldName}`, auditEntityType(info.fieldName, info.returnType, args), auditEntityId(args, result, info.fieldName), {
                  args: auditableArgs(args),
                  source: 'audit-registry',
                })
              }
            },
          }
        },
      }
    },
  }
}
