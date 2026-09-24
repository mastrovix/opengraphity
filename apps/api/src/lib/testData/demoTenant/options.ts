/**
 * WHAT A DEMO TENANT CONTAINS, AND HOW MUCH (23 Sep 2026).
 *
 * The defaults are the tenant the owner of the product asked for on
 * `demo-opengrafo`: three years of operation of a large company. Every number
 * can be changed, so the same generator builds a small tenant for a quick look
 * or a test — but the RATIOS stay the owner's (75% of CIs active, 20% of
 * tickets open, 90% of teams internal, …): they are what makes the tenant look
 * lived in, and they live in `DEMO_RATIOS`, not in the counts.
 */
import { CAPABILITY_CAPACITY } from './names.js'

export interface DemoCounts {
  users: number
  ownerTeams: number
  supportTeams: number
  businessApplications: number
  applications: number
  capabilities: number
  servers: number
  databaseInstances: number
  databases: number
  certificates: number
  incidents: number
  problems: number
  changes: number
  serviceRequests: number
  catalogItems: number
  reports: number
  /** Browser logs (`:LogEntry`), what the Logs page shows. */
  clientLogs: number
  /** Monitoring alarms (`:Event`) over the period, on top of the certificate ones. */
  monitoringEvents: number
  /** Business applications put under watch, with their service map. */
  monitoredServices: number
}

export const DEFAULT_DEMO_COUNTS: Readonly<DemoCounts> = {
  users: 3000,
  ownerTeams: 200,
  supportTeams: 300,
  businessApplications: 1500,
  applications: 2000,
  capabilities: 300,
  servers: 15000,
  databaseInstances: 2000,
  databases: 3000,
  certificates: 3000,
  incidents: 50000,
  /*
   * 800 problem, non 10.000 (22 set 2026). Diecimila su tre anni sono nove al
   * giorno, e un problem al giorno ogni cinque incident: in un'organizzazione
   * vera il rapporto è uno ogni cinquanta-cento incident, perché un problem è
   * un'indagine su una causa che si ripete, non un doppione del ticket. Con
   * 50.000 incident, 800 problem è la misura giusta.
   */
  problems: 800,
  changes: 15000,
  /*
   * 120.000 richieste, non 15.000 (22 set 2026). In un'organizzazione vera le
   * richieste di servizio sono DUE-QUATTRO VOLTE gli incident — password,
   * accessi, dotazioni, ambienti — e qui erano un terzo: il catalogo sembrava
   * un accessorio invece che il canale su cui passa la maggior parte del
   * lavoro del service desk. Con 50.000 incident, 120.000 richieste sono 110
   * al giorno per 3.000 persone: una richiesta a testa ogni tre settimane.
   */
  serviceRequests: 120000,
  catalogItems: 50,
  reports: 20,
  clientLogs: 6000,
  /*
   * Gli allarmi: 120.000 su tre anni sono ~110 al giorno per 15.000 server,
   * 2.000 istanze, 3.000 database e 2.000 applicazioni — un parco monitorato
   * e curato. A questi si aggiungono quelli dei CERTIFICATI, che non si
   * contano qui perché non si inventano: li decide la data di scadenza del
   * certificato nel CMDB.
   */
  monitoringEvents: 120000,
  /*
   * I servizi sotto osservazione: non tutte le 1.500 business application —
   * un'azienda ne mette sotto controllo qualche decina, quelle che reggono il
   * mestiere. Trenta mappe sono abbastanza da riempire la pagina e da far
   * vedere l'albero d'impatto senza inventare una vigilanza che nessuno ha.
   */
  monitoredServices: 30,
}

/**
 * The counts of a smaller tenant: every volume times `scale`, never below one
 * — five for the teams, which the ratios split between owners and support.
 * The catalog and the reports keep their size: they are content, not volume.
 * The generator's command (`--scale`) and the integration suite against a
 * real Neo4j use the same numbers.
 */
export function scaledDemoCounts(scale: number): DemoCounts {
  if (!(scale > 0 && scale <= 1)) throw new Error(`the scale of a demo tenant is a number in (0, 1] (got ${String(scale)})`)
  return Object.fromEntries(Object.entries(DEFAULT_DEMO_COUNTS).map(([k, v]) => {
    if (k === 'catalogItems' || k === 'reports') return [k, v]
    return [k, Math.max(k.endsWith('Teams') ? 5 : 1, Math.round(v * scale))]
  })) as unknown as DemoCounts
}

/** The shares the owner of the product fixed. Changing them is changing the request. */
export const DEMO_RATIOS = {
  /** Of the teams, the internal ones (the rest are external suppliers). */
  internalTeams: 0.9,
  /** Of the CIs, the ones in status `active`. */
  activeCIs: 0.75,
  /**
   * QUANTI RESTANO APERTI, per tipo (rivisto il 22 set 2026).
   *
   * Il proprietario aveva chiesto il 20% per tutti. Facendolo girare è venuta
   * fuori l'aritmetica che c'è dietro: 50.000 incident in tre anni sono 46 al
   * giorno, e il 20% aperti vuol dire diecimila incident fermi in coda —
   * duecento giorni di arrivi. Per farceli stare il generatore doveva tenere
   * aperto TUTTO quello che era arrivato negli ultimi mesi, e si vedeva: né
   * la coda né il grafico somigliavano a un service desk.
   *
   * Messo davanti al conto, il proprietario ha scelto le quote vere: un
   * incident si chiude in giornata e quelli aperti sono pochi; un problem
   * dura, e una change aspetta il CAB e la sua finestra.
   */
  /**
   * QUANTO DURA UN TICKET (22 set 2026). Da qui escono gli aperti.
   *
   * Il proprietario aveva chiesto «il 20% ancora aperti». Facendolo girare si
   * è visto che non è un parametro: con 50.000 incident in tre anni sono 46
   * al giorno, e il 20% aperti vorrebbe dire diecimila incident fermi in
   * coda, cioè duecento giorni di arrivi. Vale la legge di Little — aperti ≈
   * arrivi al giorno × durata — e la cosa che si conosce di un processo è la
   * DURATA. Dichiarata quella, gli aperti vengono da sé: giusti di numero,
   * giusti di età, e senza scalini nel grafico dei mesi.
   *
   * `stuckShare` è la coda che si incaglia: il ticket fermo in attesa di un
   * fornitore, la change che aspetta la finestra del trimestre. È la parte
   * che una dimostrazione deve far vedere, e sta scritta qui invece di
   * nascondersi dentro una percentuale tonda.
   */
  lifetimes: {
    /*
     * I numeri escono dal conto, non dal gusto. Arrivi al giorno = totale / 1095;
     * durata media di una log-normale = mediana × e^(σ²/2); aperti = arrivi × durata.
     *
     *   incident   45,7/g × 3,3 g  ≈ 150-200 aperti (15 dei quali incagliati)
     *   problem     9,1/g × 33 g   ≈ 300 aperti
     *   change     13,7/g × 30 g   ≈ 400-450 aperte — abbastanza per i conflitti del CAB
     *
     * Le richieste non sono qui: dal 23 set 2026 durano quanto dice la loro
     * voce di catalogo (`fulfilHours`, serviceRequests.ts), ~110/g × ~1,1 g
     * ≈ 120 aperte, e la verifica usa `requestMeanOpenDays` dello stesso modello.
     */
    incident: { medianHours: 40, spread: 1.1, stuckShare: 0.02, stuckMedianDays: 12 },
    problem: { medianHours: 18 * 24, spread: 0.9, stuckShare: 0.08, stuckMedianDays: 75 },
    change: { medianHours: 16 * 24, spread: 0.8, stuckShare: 0.12, stuckMedianDays: 60 },
  },

  /** Of the changes, those whose deploy the CAB sees in conflict with another change. */
  conflictingChanges: 0.15,
  /**
   * Of the incidents, those the MONITORING ENGINE opened from a critical alarm
   * (22-23 Sep 2026). In a mature organisation a quarter to a third of the
   * incidents come from monitoring, the rest from people; they are part of
   * the incident count, not added to it.
   */
  incidentsFromMonitoring: 0.25,
  /** Of the other incidents on a monitored CI, those that had a critical alarm attached. */
  alarmsOnPeoplesIncidents: 0.2,
  /** Of the changes, those linked as the resolution of an incident or a problem. */
  resolvingChanges: 0.1,
  /** Of the users, by role (they add up to the whole). */
  roles: { operator: 0.4, end_user: 1700 / 3000, viewer: 80 / 3000, admin: 20 / 3000 },
  /**
   * CMDB HEALTH, FED ON PURPOSE (owner, 24 Sep 2026): «alcuni CI devono fare
   * in modo di alimentare la CMDB Health, non più di 50 tra tutte le
   * casistiche». The plan is otherwise clean — every check reads zero on it —
   * so the cards show exactly these (healthFindings.ts, `expectedHealthCards`
   * for what each one reads: a certificate with no relation is also outside
   * every chain, an application without CIs also an incomplete chain).
   */
  healthFindings: {
    unflaggedInfrastructure: 4, databasesWithoutInstance: 3, relationsNotAdmitted: 3, withoutOwner: 4, withoutSupport: 4,
    unrelatedCertificates: 3, applicationsWithoutCis: 3, expiredInUse: 4, duplicatePairs: 2, requiredFieldEmpty: 4,
  },
} as const

export interface DemoOptions {
  tenantId: string
  /** Same seed, same tenant (up to "now", which moves). */
  seed: string
  /** The end of the simulated period; the start is `years` before. */
  nowMs: number
  years: number
  counts: DemoCounts
}

export function assertDemoCounts(counts: DemoCounts): void {
  for (const [key, value] of Object.entries(counts)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Demo tenant: "${key}" must be a non-negative integer (got ${String(value)})`)
    }
  }
  // The shapes the owner asked for need these minimums to exist at all.
  const need = (ok: boolean, why: string): void => { if (!ok) throw new Error(`Demo tenant: ${why}`) }
  need(counts.ownerTeams >= 1 && counts.supportTeams >= 1, 'at least one owner team and one support team are needed')
  // Teams are made of operators (40% of the users): a manager and a member each, plus the change-manager team.
  need(Math.round(counts.users * DEMO_RATIOS.roles.operator) >= (counts.ownerTeams + counts.supportTeams + 1) * 2,
    'there must be at least two operators per team (a manager and a member), and operators are 40% of the users')
  need(counts.applications === 0 || counts.businessApplications >= 1, 'applications need at least one business application')
  need(counts.applications === 0 || counts.servers >= 1, 'applications need at least one server to be installed on')
  need(counts.databaseInstances === 0 || counts.servers >= 1, 'database instances need at least one server')
  need(counts.databases === 0 || (counts.databaseInstances >= 1 && counts.applications >= 1),
    'databases need at least one database instance and one application')
  // An instance no application uses is in no valid chain (owner, 24 Sep 2026): each hosts a database.
  need(counts.databases >= counts.databaseInstances, 'every database instance hosts at least one database: there must be at least as many databases as instances')
  need(counts.serviceRequests === 0 || counts.catalogItems >= 1, 'service requests need at least one catalog item')
  // A capability is enabled by business applications, and named from the capability tree (cmdb.ts).
  need(counts.capabilities === 0 || counts.businessApplications >= 1, 'capabilities need at least one business application to enable them')
  need(counts.capabilities <= CAPABILITY_CAPACITY, `the capability tree has names for ${String(CAPABILITY_CAPACITY)} capabilities, ${String(counts.capabilities)} asked`)
}
