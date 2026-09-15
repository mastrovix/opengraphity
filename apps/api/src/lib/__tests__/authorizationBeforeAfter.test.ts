/**
 * PRIMA E DOPO I RUOLI PERSONALIZZATI (ondata 7 di «Nulla cablato»).
 *
 * `fixtures/authorization-before-roles.json` è la fotografia della policy di
 * ruolo com'era su HEAD 2465e5d, presa dal codice di allora: per ognuna delle
 * 410 operazioni, quali dei quattro ruoli la eseguivano. Non si aggiorna: è la
 * storia. Le operazioni nate dopo le decide `operationPermissions.ts`, e
 * l'avvio fallisce se ne manca una.
 *
 * Il test dice che i ruoli di fabbrica fanno ESATTAMENTE quello che facevano i
 * ruoli fissi, tranne le differenze elencate qui sotto, ognuna con il perché.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { RootKind } from '../authorization.js'
import { allowedRoles } from './factoryRoles.js'

const BEFORE = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/authorization-before-roles.json', import.meta.url)), 'utf8')) as Record<string, string[]>

const STAFF = ['admin', 'operator', 'viewer']
const WRITERS = ['admin', 'operator']

/** Le differenze volute: operazione → [prima, dopo, perché]. */
const DECLARED: Record<string, { before: string[]; after: string[]; why: string }> = {
  // Correzione 1 (approvata): chi vede le notifiche le può segnare lette.
  'Mutation.markNotificationRead':     { before: WRITERS, after: STAFF, why: 'viewer manages own notifications' },
  'Mutation.markAllNotificationsRead': { before: WRITERS, after: STAFF, why: 'viewer manages own notifications' },
  'Mutation.dismissAllNotifications':  { before: WRITERS, after: STAFF, why: 'viewer manages own notifications' },
  'Mutation.setMyEmailNotifications':  { before: WRITERS, after: STAFF, why: 'viewer manages own notifications' },
  // Correzione 2 (approvata): le chiamate al modello sono per chi lavora l'incident.
  'Query.triageSuggestion': { before: STAFF, after: WRITERS, why: 'AI triage is for people who work incidents' },
  'Query.resolutionDraft':  { before: STAFF, after: WRITERS, why: 'AI draft is for people who work incidents' },
  // Correzione 3 (approvata): adottare i valori spediti cambia i vocabolari, come il resto del Dizionario.
  'Mutation.adoptShippedValues':       { before: WRITERS, after: ['admin'], why: 'dictionary is metamodel configuration' },
  'Mutation.acknowledgeShippedValues': { before: WRITERS, after: ['admin'], why: 'dictionary is metamodel configuration' },
  // Correzione 4 (approvata): chi crea una dashboard ne salva anche la disposizione.
  'Mutation.saveDashboardLayout': { before: WRITERS, after: STAFF, why: 'viewer saves the layout of own dashboards' },
  // Allineamento, nessun effetto: il resolver (`requireAgent` in collaboration.ts)
  // rifiutava già il viewer; ora lo dice la policy, con il permesso della chat.
  'Query.internalMessages': { before: STAFF, after: WRITERS, why: 'requireAgent already refused viewer' },
}

/**
 * Le operazioni della fotografia che non esistono più, con il perché. La
 * fotografia resta com'è (è la storia); queste non si confrontano, ma si
 * pretende che siano davvero sparite dalla policy.
 */
const RETIRED: Record<string, string> = {
  // Revisione del 15 set 2026 · CM-8: le regole «tipi ammessi» sono diventate esclusioni per tipo di ticket.
  'Query.itilCIRelationRules':          'replaced by Query.ticketCIExclusions',
  'Query.allITILCIRelationRules':       'replaced by Query.ticketCIExclusions',
  'Mutation.createITILCIRelationRule':  'replaced by Mutation.setTicketCIExclusions',
  'Mutation.deleteITILCIRelationRule':  'replaced by Mutation.setTicketCIExclusions',
}

describe('ruoli di fabbrica = ruoli di prima', () => {
  it('la fotografia copre tutte le operazioni di allora', () => {
    expect(Object.keys(BEFORE).length).toBe(410)
  })

  it.each(Object.entries(BEFORE))('%s', (op, before) => {
    const [kind, field] = op.split('.') as [RootKind, string]
    if (RETIRED[op]) {
      expect(() => allowedRoles(kind, field), `${op} è dichiarata ritirata (${RETIRED[op]}) ma la policy la conosce ancora`).toThrow(/no permission rule/)
      return
    }
    const after = allowedRoles(kind, field)
    const declared = DECLARED[op]
    if (declared) {
      expect(before, `${op}: la fotografia non dice più il "prima" dichiarato`).toEqual(declared.before)
      expect(after, `${op}: ${declared.why}`).toEqual(declared.after)
    } else {
      expect(after).toEqual(before)
    }
  })

  it('ogni differenza dichiarata esiste nella fotografia', () => {
    expect(Object.keys(DECLARED).filter((op) => !(op in BEFORE))).toEqual([])
  })
})
