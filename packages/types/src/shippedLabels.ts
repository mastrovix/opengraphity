/**
 * LE ETICHETTE CHE IL PRODOTTO SPEDISCE, in un posto solo (20 set 2026,
 * decisione del proprietario).
 *
 * ## Il difetto
 * Un campo, una relazione o un tipo del metamodello nasce con la sua etichetta
 * INGLESE scritta nel grafo («Title», «Business Application»). Tradurla è del
 * prodotto, non del cliente, e la traduzione stava nei locale del web: cioè
 * in un posto che il SERVER non può leggere. Risultato visto nel browser: la
 * stessa tabella di report aveva le colonne «Titolo» e «Numero» nel
 * costruttore — che è web — e «TITLE» e «NUMBER» nel risultato, nel PDF e nel
 * foglio Excel, che vengono dal server.
 *
 * Qui c'è la sorgente unica: la leggono il web (`lib/shippedLabel.ts`) e
 * l'API (`lib/reportFieldLabels.ts`). Nei locale non c'è più una copia, e un
 * guardiano impedisce che ne ricompaia una.
 *
 * ## La regola
 * Alcune etichette sono UGUALI nelle due lingue di proposito: «Server»,
 * «Database», «Incident», «Problem», «Change» nominano la cosa, e sono le
 * parole che chi fa ITSM usa parlando italiano — tradurle («Banca dati»,
 * «Cambiamento») darebbe un prodotto che nessuno riconosce. È la regola delle
 * parole tecniche, non una traduzione dimenticata.
 *
 * Si traduce solo finché l'etichetta è ANCORA quella spedita, cioè uguale
 * all'inglese qui sotto. Appena il cliente la rinomina, l'etichetta è sua e
 * resta com'è in ogni lingua: il disegnatore vince sempre sul prodotto
 * (F-22). Un nome che qui non c'è è del cliente per definizione.
 */

/** Le lingue in cui il prodotto spedisce le sue etichette. */
export type LinguaSpedita = 'en' | 'it'

export type GenereEtichettaSpedita = 'field' | 'relation' | 'type'

type Voci = Readonly<Record<string, Readonly<Record<LinguaSpedita, string>>>>

export const SHIPPED_LABELS: Readonly<Record<GenereEtichettaSpedita, Voci>> = {
  field: {
    title: { en: 'Title', it: 'Titolo' },
    description: { en: 'Description', it: 'Descrizione' },
    status: { en: 'Status', it: 'Stato' },
    severity: { en: 'Severity', it: 'Severità' },
    category: { en: 'Category', it: 'Categoria' },
    created_at: { en: 'Created at', it: 'Creato il' },
    updated_at: { en: 'Updated at', it: 'Aggiornato il' },
    resolved_at: { en: 'Resolved at', it: 'Risolto il' },
    impact: { en: 'Impact', it: 'Impatto' },
    urgency: { en: 'Urgency', it: 'Urgenza' },
    priority: { en: 'Priority', it: 'Priorità' },
    type: { en: 'Type', it: 'Tipo' },
    risk: { en: 'Risk', it: 'Rischio' },
    scheduled_start: { en: 'Scheduled start', it: 'Inizio previsto' },
    scheduled_end: { en: 'Scheduled end', it: 'Fine prevista' },
    name: { en: 'Name', it: 'Nome' },
    environment: { en: 'Environment', it: 'Ambiente' },
    notes: { en: 'Notes', it: 'Note' },
    createdAt: { en: 'Created at', it: 'Creato il' },
    updatedAt: { en: 'Updated at', it: 'Aggiornato il' },
    certificateType: { en: 'Type', it: 'Tipo' },
    expiresAt: { en: 'Expires at', it: 'Scadenza' },
    port: { en: 'Port', it: 'Porta' },
    serialNumber: { en: 'Serial number', it: 'Numero seriale' },
    version: { en: 'Version', it: 'Versione' },
    businessOwner: { en: 'Business Owner', it: 'Responsabile di business' },
    criticality: { en: 'Criticality', it: 'Criticità' },
    businessUnit: { en: 'Business Unit', it: 'Unità di business' },
    costCenter: { en: 'Cost Center', it: 'Centro di costo' },
    userBase: { en: 'User Base', it: 'Utenti serviti' },
    maturity: { en: 'Maturity', it: 'Maturità' },
    strategicPriority: { en: 'Strategic Priority', it: 'Priorità strategica' },
    hierarchyLevel: { en: 'Hierarchy Level', it: 'Livello gerarchico' },
    capabilityOwner: { en: 'Capability Owner', it: 'Responsabile della capability' },
    criteriaNameContains: { en: 'Criteria: Name Contains', it: 'Criterio: il nome contiene' },
    criteriaStatus: { en: 'Criteria: Status', it: 'Criterio: stato' },
    criteriaEnvironment: { en: 'Criteria: Environment', it: 'Criterio: ambiente' },
    criteriaCiTypes: { en: 'Criteria: CI Types', it: 'Criterio: tipi di CI' },
    membershipType: { en: 'Membership Type', it: 'Tipo di appartenenza' },
    vendor: { en: 'Vendor', it: 'Fornitore' },
    location: { en: 'Location', it: 'Posizione' },
    ipAddress: { en: 'IP Address', it: 'Indirizzo IP' },
    instanceType: { en: 'Instance Type', it: 'Tipo di istanza' },
  },
  relation: {
    dependencies: { en: 'Dependencies', it: 'Dipendenze' },
    dependents: { en: 'Dependents', it: 'Dipendenti' },
  },
  type: {
    application: { en: 'Application', it: 'Applicazione' },
    business_application: { en: 'Business Application', it: 'Applicazione di business' },
    business_capability: { en: 'Business Capability', it: 'Capacità di business' },
    certificate: { en: 'Certificate', it: 'Certificato' },
    change: { en: 'Change', it: 'Change' },
    database: { en: 'Database', it: 'Database' },
    database_instance: { en: 'Database Instance', it: 'Istanza di database' },
    dynamic_ci_group: { en: 'Dynamic CI Group', it: 'Gruppo dinamico di CI' },
    incident: { en: 'Incident', it: 'Incident' },
    problem: { en: 'Problem', it: 'Problem' },
    server: { en: 'Server', it: 'Server' },
    service_request: { en: 'Service Request', it: 'Richiesta di servizio' },
  },
}

/**
 * L'etichetta da mostrare, nella lingua chiesta.
 *
 * `label` è quella che sta nel grafo. Torna sempre qualcosa: senza etichetta
 * e senza traduzione, il nome interno.
 */
export function shippedLabelIn(
  kind: GenereEtichettaSpedita,
  name: string,
  label: string | null | undefined,
  lingua: string | null | undefined,
): string {
  const corrente = label || name
  const voce = SHIPPED_LABELS[kind][name]
  if (!voce) return corrente
  // Rinominata dal cliente: è sua, in qualunque lingua.
  if (voce.en !== corrente) return corrente
  const tradotta = voce[(lingua ?? '') as LinguaSpedita]
  return tradotta || corrente
}
