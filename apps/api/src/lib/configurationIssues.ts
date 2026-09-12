/**
 * Cosa c'è da sistemare nella configurazione di QUESTO cliente, in un posto
 * solo (revisione delle otto ondate · A·#3, D·D4, D·#5, C·#8).
 *
 * ## Il difetto, ed è lo stesso quattro volte
 * Il prodotto **sa** quando la configurazione di un cliente è rotta o
 * incompleta, e lo dice a tutti tranne che a chi può rimediare:
 *
 *  - lo **schema degradato** ha l'intestazione HTTP, la metrica e il log — e
 *    l'amministratore del tenant, l'unico che può correggere il tipo colpevole,
 *    vede solo pagine che dicono «Cannot query field»;
 *  - le **matrici incomplete** sono esposte bene da `domainMatrices`
 *    (`missing`/`stale`/`invalid`), ma bisogna andare nella pagina apposta per
 *    saperlo: il sintomo arriva invece all'apertura di un incident;
 *  - i **buchi di configurazione** (nessun workflow, nessuna matrice) li
 *    conosceva solo `migrate --status`;
 *  - le **liste della policy che citano valori fuori vocabolario** non le
 *    guardava nessuno. La migrazione `1810` scrive `retired_statuses` senza
 *    verificare che quei valori siano nel `ci_status` del cliente: chi aveva
 *    già rinominato `decommissioned` si ritrovava una policy che punta al
 *    nulla, cioè i CI dismessi di nuovo dentro la salute dei servizi — lo
 *    stesso difetto C-4 che l'ondata 7 dichiara chiuso, spostato dal codice al
 *    dato. E i valori AGGIUNTI a `ci_status` senza semantica (dal vivo su
 *    c-one: `expired` e `revoked`, con 68 CI sopra) pesano ancora nella salute
 *    dei servizi, senza che nessuna pagina lo dica.
 *
 * Qui si raccolgono tutti, con la stessa forma, per un banner solo. Un
 * controllo che fallisce non nasconde gli altri: diventa lui stesso una voce.
 */
import type { Session } from 'neo4j-driver'
import { getSession } from '@opengraphity/neo4j'
import { getSchemaState } from './schemaCache.js'
import { tenantProvisioningGaps } from './provisionTenantData.js'
import { DOMAIN_MATRIX_KINDS, domainVocabulary, loadDomainMatrix, matrixKey, type DomainMatrixKind } from './domainMatrix.js'
import { CI_STATUS_VOCABULARY } from './eventVocabularies.js'
import { LIFECYCLE_POLICY_LISTS } from './eventPolicy.js'
import { getEventPolicy } from '../services/events/policy.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'configuration-issues' })

export type ConfigurationIssueKind =
  | 'schema_degraded'
  | 'provisioning_gap'
  | 'matrix_incomplete'
  | 'policy_out_of_vocabulary'
  | 'vocabulary_without_semantics'
  | 'check_failed'

export interface ConfigurationIssue {
  kind: ConfigurationIssueKind
  /** `error` = qualcosa è già rotto; `warning` = lo sarà, o è silenziosamente sbagliato. */
  severity: 'error' | 'warning'
  /** Cosa non va, nella lingua del prodotto. */
  message: string
  /** Dove si rimedia: un percorso dell'interfaccia. */
  where: string | null
}

export async function configurationIssues(tenantId: string): Promise<ConfigurationIssue[]> {
  const out: ConfigurationIssue[] = []
  const session = getSession()
  try {
    for (const check of [checkSchema, checkProvisioning, checkMatrices, checkLifecyclePolicy]) {
      try {
        out.push(...await check(tenantId, session))
      } catch (err) {
        // Un controllo che non gira non deve nascondere gli altri — né sparire.
        log.error({ err, tenantId, check: check.name }, 'Controllo di configurazione fallito')
        out.push({
          kind: 'check_failed', severity: 'warning', where: null,
          message: `Il controllo «${check.name}» non è riuscito: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }
  } finally {
    await session.close()
  }
  return out
}

async function checkSchema(tenantId: string): Promise<ConfigurationIssue[]> {
  const state = await getSchemaState(tenantId)
  if (!state.degraded) return []
  return [{
    kind: 'schema_degraded', severity: 'error', where: '/settings/ci-types',
    message:
      `Una parte del metamodello dei CI non è servibile dall'API, quindi quei tipi non compaiono ` +
      `da nessuna parte: ${state.reason ?? 'motivo non disponibile'}`,
  }]
}

async function checkProvisioning(tenantId: string, session: Session): Promise<ConfigurationIssue[]> {
  const gaps = await tenantProvisioningGaps(session, tenantId)
  if (gaps.length === 0) return []
  return [{
    kind: 'provisioning_gap', severity: 'error', where: '/workflow',
    message:
      `La configurazione di questo cliente è incompleta (${gaps.join('; ')}). ` +
      `Senza, l'apertura di un ticket si ferma. Si rimedia dal disegnatore dei workflow, ` +
      `col pulsante «Completa la configurazione».`,
  }]
}

async function checkMatrices(tenantId: string): Promise<ConfigurationIssue[]> {
  const out: ConfigurationIssue[] = []
  for (const kind of Object.keys(DOMAIN_MATRIX_KINDS) as DomainMatrixKind[]) {
    const spec   = DOMAIN_MATRIX_KINDS[kind]
    const matrix = await loadDomainMatrix(tenantId, kind)
    const inputValues  = await Promise.all(spec.inputs.map((v) => domainVocabulary(tenantId, v)))
    const outputValues = await domainVocabulary(tenantId, spec.output)

    const wanted  = cartesian(inputValues).map((v) => matrixKey(...v))
    const missing = wanted.filter((k) => matrix.entries[k] === undefined)
    const stale   = Object.keys(matrix.entries).filter((k) => !wanted.includes(k))
    const invalid = Object.entries(matrix.entries).filter(([, v]) => !outputValues.includes(v)).map(([k]) => k)
    if (!missing.length && !stale.length && !invalid.length) continue

    const parts: string[] = []
    if (missing.length) parts.push(`${String(missing.length)} combinazioni senza valore (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''})`)
    if (invalid.length) parts.push(`${String(invalid.length)} celle con un valore fuori vocabolario`)
    if (stale.length)   parts.push(`${String(stale.length)} chiavi rimaste da una rinomina`)
    out.push({
      kind: 'matrix_incomplete',
      // Una cella mancante è un errore a runtime (l'apertura di un incident si
      // ferma); una chiave rimasta è residuo, e non ferma niente.
      severity: missing.length || invalid.length ? 'error' : 'warning',
      where: '/settings/domain-matrices',
      message: `Matrice «${kind}»: ${parts.join(', ')}.`,
    })
  }
  return out
}

async function checkLifecyclePolicy(tenantId: string): Promise<ConfigurationIssue[]> {
  const out: ConfigurationIssue[] = []
  const policy = await getEventPolicy(tenantId)
  const values = await domainVocabulary(tenantId, CI_STATUS_VOCABULARY)

  // (a) La policy cita valori che il vocabolario non ha (più).
  const fuori = new Map<string, string[]>()
  for (const list of LIFECYCLE_POLICY_LISTS) {
    const orfani = (policy[list] as readonly string[]).filter((v) => !values.includes(v))
    if (orfani.length) fuori.set(list, orfani)
  }
  if (fuori.size) {
    out.push({
      kind: 'policy_out_of_vocabulary', severity: 'error', where: '/settings/events',
      message:
        `La policy degli allarmi cita stati che il tuo Dizionario non ha (più): ` +
        [...fuori].map(([l, v]) => `${l} → ${v.join(', ')}`).join('; ') +
        `. Quelle liste non si applicano a nessun CI: i CI in quello stato tornano a pesare nella salute dei servizi.`,
    })
  }

  // (b) Valori del vocabolario che NESSUNA lista cita: non hanno semantica, e
  // il caso reale (c-one: `expired`, `revoked`) è passato inosservato per mesi.
  const citati = new Set(LIFECYCLE_POLICY_LISTS.flatMap((l) => policy[l] as readonly string[]))
  const senzaSemantica = values.filter((v) => !citati.has(v))
  // Il primo valore della scala (o il default) è «in servizio» per definizione:
  // non citarlo è la norma, non una dimenticanza.
  const atteso = senzaSemantica.length > 0 && senzaSemantica[0] === values[0] ? senzaSemantica.slice(1) : senzaSemantica
  if (atteso.length) {
    out.push({
      kind: 'vocabulary_without_semantics', severity: 'warning', where: '/settings/events',
      message:
        `Questi stati del ciclo di vita non sono in nessuna lista della policy degli allarmi: ` +
        `${atteso.join(', ')}. Per il prodotto sono CI **in servizio**: i loro allarmi aprono incident e ` +
        `pesano nella salute dei servizi. Se sono stati finali, aggiungili a «ritirati».`,
    })
  }
  return out
}

function cartesian(lists: readonly (readonly string[])[]): string[][] {
  return lists.reduce<string[][]>((acc, list) => acc.flatMap((prefix) => list.map((v) => [...prefix, v])), [[]])
}
