/**
 * I tipi di change **pre-approvati**, come dato del cliente (ondata 8: l'ultimo
 * letterale di dominio del programma).
 *
 * ## Il difetto
 * Una change di tipo `standard` è pre-approvata — è la nozione ITIL di
 * cambiamento pre-autorizzato: riavviare un servizio, applicare una patch di
 * routine — e nel codice questo era scritto quattro volte nello stesso modo:
 * `if (changeType === 'standard') return`. Era **il nome** a decidere.
 *
 * Ma il cliente può rinominare i valori del vocabolario `change_type` (è una
 * decisione presa). Quindi chi rinominava `standard` in `preautorizzata` si
 * ritrovava quelle change a chiedere di nuovo l'approvazione completa, e chi
 * aggiungeva un tipo che considerava pre-approvato (`routine`) non veniva
 * riconosciuto.
 *
 * ## Perché non era fra i critici
 * Perché sbaglia in una direzione sola: chiede **più** approvazione, non meno.
 * Nessuna change passa senza le firme che dovrebbe avere — accade il
 * contrario, con un errore visibile davanti a un amministratore. È il motivo
 * per cui è stato dichiarato aperto nell'ondata 7 e chiuso qui, invece di
 * essere infilato di corsa in un'ondata già verificata.
 *
 * ## La forma, e perché una lista e non una matrice
 * Le matrici dell'ondata 7 traducono un valore di dominio in un altro, e il
 * valore d'uscita appartiene a un vocabolario del cliente. Qui no: «essere
 * pre-approvato» è un concetto del **codice**, non un valore che il cliente
 * possa rinominare — se potesse, il codice non saprebbe più quale modo
 * significa «salta le approvazioni». Quindi il cliente decide **quali tipi**
 * sono pre-approvati, e quello è un insieme: una lista sul tenant, validata
 * contro il suo vocabolario `change_type`.
 */
import { getSession } from '@opengraphity/neo4j'
import { registerMetamodelCacheClearer } from './schemaInvalidator.js'
import { assertDomainValue, domainVocabulary } from './domainMatrix.js'
import { ValidationError } from './errors.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'change-policy' })

/** Il valore iniziale: esattamente il letterale che il codice usava. */
export const DEFAULT_PRE_APPROVED_CHANGE_TYPES: readonly string[] = ['standard']

const cache = new Map<string, Promise<readonly string[]>>()

registerMetamodelCacheClearer('pre-approved-change-types', (tenantId: string) => {
  cache.delete(tenantId)
})

export function invalidatePreApprovedChangeTypes(tenantId?: string): void {
  if (tenantId) { cache.delete(tenantId); return }
  cache.clear()
}

/**
 * I tipi di change pre-approvati di questo cliente.
 *
 * La proprietà assente (tenant creato prima della migrazione) **non** è una
 * lista vuota: sarebbe «nessun tipo pre-approvato», cioè un cambio di
 * comportamento silenzioso nella direzione opposta a quella di prima. Si usa
 * il valore iniziale e lo si dice nei log una volta per tenant.
 */
export async function preApprovedChangeTypes(tenantId: string): Promise<readonly string[]> {
  const hit = cache.get(tenantId)
  if (hit) return hit

  const load = (async (): Promise<readonly string[]> => {
    const session = getSession()
    try {
      const r = await session.executeRead((tx) =>
        tx.run(`MATCH (t:Tenant {id: $tenantId}) RETURN t.pre_approved_change_types AS types`, { tenantId }),
      )
      if (!r.records.length) throw new Error(`Tenant ${tenantId} inesistente: non si può stabilire quali change sono pre-approvate`)
      const raw = r.records[0].get('types')
      if (raw == null) {
        log.info(
          { tenantId, initial: DEFAULT_PRE_APPROVED_CHANGE_TYPES },
          'Nessuna lista di tipi di change pre-approvati sul tenant: si usa quella di fabbrica ' +
          '(applica la migrazione 20260918_1920 per renderla esplicita e modificabile)',
        )
        return DEFAULT_PRE_APPROVED_CHANGE_TYPES
      }
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
        throw new Error(`Tenant ${tenantId}: pre_approved_change_types non è una lista di stringhe (${JSON.stringify(raw)})`)
      }
      return raw as string[]
    } finally {
      await session.close()
    }
  })().catch((err: unknown) => {
    cache.delete(tenantId)
    throw err
  })

  cache.set(tenantId, load)
  return load
}

/** Questo tipo di change salta la catena di approvazioni? */
export async function isPreApprovedChangeType(tenantId: string, changeType: string | null | undefined): Promise<boolean> {
  if (typeof changeType !== 'string' || changeType === '') return false
  return (await preApprovedChangeTypes(tenantId)).includes(changeType)
}

/**
 * Valida e salva la lista. Ogni valore deve essere nel vocabolario
 * `change_type` **del cliente**: una lista con un tipo che non esiste sarebbe
 * una pre-approvazione che non si applica a nulla, cioè il difetto di prima
 * con un nome nuovo.
 */
export async function setPreApprovedChangeTypes(tenantId: string, types: readonly string[]): Promise<readonly string[]> {
  const seen = new Set<string>()
  for (const t of types) {
    await assertDomainValue(tenantId, 'change_type', t)
    if (seen.has(t)) throw new ValidationError(`Il tipo di change "${t}" compare due volte nella lista dei pre-approvati.`)
    seen.add(t)
  }
  const session = getSession()
  try {
    const r = await session.executeWrite((tx) =>
      tx.run(
        `MATCH (t:Tenant {id: $tenantId})
         SET t.pre_approved_change_types = $types, t.updated_at = $now
         RETURN t.pre_approved_change_types AS types`,
        { tenantId, types: [...types], now: new Date().toISOString() },
      ),
    )
    if (!r.records.length) throw new ValidationError(`Tenant ${tenantId} inesistente`)
    cache.delete(tenantId)
    return r.records[0].get('types') as string[]
  } finally {
    await session.close()
  }
}

/** I tipi fra cui scegliere: il vocabolario `change_type` del cliente. */
export async function changeTypeVocabulary(tenantId: string): Promise<readonly string[]> {
  return domainVocabulary(tenantId, 'change_type')
}
