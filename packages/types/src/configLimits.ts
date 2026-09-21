/**
 * Gli INTERVALLI della configurazione, in un posto solo per API e interfaccia.
 *
 * Revisione totale · G-25: gli stessi numeri erano copiati a mano nel web
 * («gli stessi intervalli dell'API», diceva il commento) e nell'API. Due
 * elenchi che devono restare uguali per sempre e nessuno che se ne accorge:
 * se l'API alzasse il tetto, il web continuerebbe a bloccare al vecchio, e il
 * cliente vedrebbe un campo che rifiuta un valore che il server accetta.
 * Qui sono dichiarati una volta e importati da entrambe le parti.
 */

/** Un peso dell'analisi d'impatto è una percentuale; una finestra, giorni. */
export const MAX_IMPACT_WEIGHT = 100
export const MAX_IMPACT_WINDOW_DAYS = 365
export const MIN_IMPACT_WINDOW_DAYS = 1

export const IMPACT_WEIGHT_KEYS = [
  'productionCI', 'blastRadiusCI', 'blastRadiusCap', 'openIncident', 'failedChange', 'ongoingChange',
] as const
export const IMPACT_WINDOW_KEYS = ['recentChangesDays', 'recentIncidentsDays'] as const
export type ImpactWeightKey = (typeof IMPACT_WEIGHT_KEYS)[number]
export type ImpactWindowKey = (typeof IMPACT_WINDOW_KEYS)[number]

/** `{min, max}` per ogni chiave: i pesi 0..100, le finestre 1..365. */
export const IMPACT_LIMITS: Readonly<Record<ImpactWeightKey | ImpactWindowKey, { min: number; max: number }>> = {
  ...Object.fromEntries(IMPACT_WEIGHT_KEYS.map((k) => [k, { min: 0, max: MAX_IMPACT_WEIGHT }])),
  ...Object.fromEntries(IMPACT_WINDOW_KEYS.map((k) => [k, { min: MIN_IMPACT_WINDOW_DAYS, max: MAX_IMPACT_WINDOW_DAYS }])),
} as Record<ImpactWeightKey | ImpactWindowKey, { min: number; max: number }>

/** Il peso dell'ambiente nel rischio delle change. */
export const MAX_ENVIRONMENT_WEIGHT = 20

/** Le regole delle password che la pagina «Accesso» governa nel realm. */
export const PASSWORD_RULE_RANGES = {
  minLength: [6, 128], uppercase: [0, 10], lowercase: [0, 10], digits: [0, 10], special: [0, 10],
  history: [0, 24], expireDays: [0, 3650], lockoutFailures: [3, 30], lockoutMinutes: [1, 1440],
} as const satisfies Record<string, readonly [number, number]>
