/**
 * IL FATTORE AMBIENTE DELL'ASSESSMENT — dato del cliente.
 *
 * Revisione del 14 set 2026 · CH-3. `environmentScore` confrontava l'ambiente
 * del CI con due letterali: `production` → 3, `staging` → 1, tutto il resto 0.
 * Il vocabolario `environment` però è del cliente: un ambiente rinominato
 * (`prod`) o aggiunto (`collaudo`) otteneva il punteggio minimo, e il rischio
 * della change risultava più basso del vero senza un errore.
 *
 * Ora il punteggio viene dalla matrice di dominio `environment_risk`, seminata
 * con i valori di prima (il primo giorno non cambia niente) e modificabile
 * dalla pagina Matrici di dominio. Un ambiente che la matrice non conosce è un
 * errore che lo nomina, non uno 0.
 *
 * Un CI senza ambiente dichiarato non aggiunge rischio (0), come prima: non c'è
 * un valore da tradurre, e bloccare l'assessment per un campo facoltativo della
 * CMDB sarebbe sproporzionato.
 */
import { DOMAIN_MATRIX_KINDS } from './domainMatrix.js'
import { resolveDomainValue } from './domainValue.js'

/** La scala del punteggio ambiente: i valori che la formula dell'assessment accetta. */
export const ENV_RISK_SCALE = DOMAIN_MATRIX_KINDS.environment_risk.scale

export async function environmentRiskScore(tenantId: string, environment: string | null | undefined): Promise<number> {
  if (environment == null || environment === '') return 0
  const value = await resolveDomainValue(tenantId, 'environment_risk', environment)
  return Number(value)
}
