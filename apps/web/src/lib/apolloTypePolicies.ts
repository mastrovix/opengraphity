/**
 * Le regole della cache di Apollo per tipo, in un file loro (così un test le
 * usa senza tirarsi dietro Keycloak e il resto del client).
 */
import type { TypePolicies } from '@apollo/client'

export const APOLLO_TYPE_POLICIES: TypePolicies = {
  /*
    `slaReport(windowDays)` lo leggono DUE pagine con campi diversi: l'SLA
    Report chiede `sla`, l'OLA / UC Report chiede `ola`. L'oggetto non ha un id,
    e senza questa regola la seconda risposta SOSTITUIVA la prima nella cache:
    tornando all'altra pagina `report.ola` (o `report.sla`) era undefined e la
    pagina cadeva con «Unexpected error». `merge: true` unisce i campi.
  */
  SLAReport: { merge: true },
}
