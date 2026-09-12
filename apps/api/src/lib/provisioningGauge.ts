/**
 * «Quali clienti sono incompleti» come metrica, non solo come riga di
 * `migrate --status` (revisione delle otto ondate · D·D4).
 *
 * ## Il difetto
 * Il prodotto **sa** che un tenant è incompleto: `tenantProvisioningGaps`
 * esiste dall'ondata 8. Ma la chiamavano solo `migrate --status` e una
 * migrazione a colpo singolo già marcata applicata — nessuna metrica, nessun
 * banner. Quindi bisognava che a qualcuno venisse in mente di lanciare
 * `migrate --status`: `c-two` è stato incompleto per giorni e nessuno lo
 * sapeva, perché il sintomo arriva al primo `createIncident`. E lo stato è
 * raggiungibile anche **dopo** la migrazione: basta disattivare un workflow, o
 * creare un tenant da una migrazione futura.
 *
 * ## Come
 * Un gauge `tenant_provisioning_gaps{tenant}` = quante cose mancano a quel
 * cliente. Si ricalcola al massimo una volta ogni `REFRESH_MS`, su richiesta di
 * chi passa: `/health` (che qualcuno interroga sempre) e `/metrics`. Non serve
 * uno scheduler nuovo per una configurazione che cambia di rado, e non si paga
 * una query per tenant a ogni sonda.
 */
import { getSession } from '@opengraphity/neo4j'
import { tenantProvisioningGaps } from './provisionTenantData.js'
import { tenantProvisioningGapsGauge } from '../middleware/metrics.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'provisioning-gauge' })

/** Ogni cinque minuti: è configurazione, non uno stato che cambia al secondo. */
const REFRESH_MS = 5 * 60_000

let lastRun = 0
let inFlight: Promise<Record<string, string[]>> | null = null
let lastResult: Record<string, string[]> = {}

/** Il tenant condiviso non è un cliente: non ha dashboard né workflow, per costruzione. */
const SHARED_TENANT = 'system'

/**
 * I buchi per tenant, dalla cache o ricalcolati. Ritorna sempre qualcosa: se il
 * database non risponde, l'ultimo risultato noto e un log — una sonda di salute
 * non deve diventare la ragione per cui il processo sembra rotto.
 */
export async function provisioningGaps(): Promise<Record<string, string[]>> {
  const now = Date.now()
  if (now - lastRun < REFRESH_MS) return lastResult
  if (inFlight) return inFlight

  inFlight = (async () => {
    const session = getSession()
    try {
      const r = await session.run('MATCH (t:Tenant) RETURN t.id AS id ORDER BY id')
      const out: Record<string, string[]> = {}
      for (const rec of r.records) {
        const tenantId = String(rec.get('id'))
        if (tenantId === SHARED_TENANT) continue
        const gaps = await tenantProvisioningGaps(session, tenantId)
        out[tenantId] = gaps
        tenantProvisioningGapsGauge.set({ tenant: tenantId }, gaps.length)
      }
      lastResult = out
      lastRun = Date.now()
      const incompleti = Object.entries(out).filter(([, g]) => g.length > 0)
      if (incompleti.length) {
        log.warn({ incompleti: Object.fromEntries(incompleti) },
          'Clienti con la configurazione incompleta: il sintomo arriverà al primo ticket. ' +
          'Si rimedia da Impostazioni → Workflow (o con la mutation provisionTenantData).')
      }
      return out
    } finally {
      await session.close()
    }
  })().catch((err: unknown) => {
    log.error({ err }, 'Buchi di configurazione non calcolabili: resta l\'ultimo risultato noto')
    return lastResult
  }).finally(() => { inFlight = null })

  return inFlight
}
