/**
 * CHI HA FATTO QUESTA COSA: una persona o il prodotto? (20 set 2026)
 *
 * Programma «Miglioramento continuo», ondata 2 — la strumentazione.
 *
 * ## Perché serve, e perché è la prima cosa dell'ondata
 * L'analista del lavoro quotidiano deve trovare LA FATICA RIPETUTA, cioè
 * quello che una persona rifà a mano. Ma nel registro l'80% delle voci non è
 * lavoro umano, e non c'è un campo che lo dica: `:AuditEntry` ha `user_id` e
 * `user_email`, e basta.
 *
 * I numeri, letti sul grafo il 20 set 2026: su 2.200 voci, 1.051 sono di
 * `monitoring` (il correlatore degli eventi), 148 di `e2e` (i test
 * automatici), 35 di `automation`. Un analista che non distinguesse
 * proporrebbe di automatizzare cose che sono GIÀ automatiche — e lo farebbe
 * con l'aria della statistica.
 *
 * ## Perché un predicato e non un elenco copiato
 * La tentazione è scrivere `WHERE user_id IN ['system','monitoring',…]` in
 * ogni query degli aggregati. Quell'elenco poi vive in cinque posti, e al
 * primo attore sintetico nuovo si rompe in silenzio: le query continuano a
 * girare, i numeri diventano sbagliati, e nessuno se ne accorge perché non
 * c'è niente che fallisca.
 *
 * Qui c'è UNA lista e UN predicato, con un test che li tiene fermi. Chi
 * aggiunge un attore sintetico nel codice lo aggiunge anche qui, o il
 * guardiano cade.
 */

/**
 * Gli attori che NON sono persone. Accanto a ciascuno, chi lo scrive: senza
 * quel riferimento, fra un anno nessuno saprà se una voce si può togliere.
 */
export const SYNTHETIC_ACTORS: Readonly<Record<string, string>> = {
  /** Escalation da SLA, transizioni di workflow fatte dal prodotto. */
  system:      'consumers/escalationConsumer.ts, jobs/workflowJobWorker.ts, change/helpers.ts',
  /** Il correlatore degli eventi che apre e muove gli incident di monitoraggio. */
  monitoring:  'services/events/incidentWorkflow.ts',
  /** Le business rule e i trigger. */
  automation:  'lib/automationEngine.ts',
  /** Le scadenze sui passi del workflow. */
  step_deadline: 'lib/stepDeadlines.ts',
  /** Il motore SLA. */
  'sla-engine': 'packages/sla',
  /** I test end-to-end: girano su tenant veri e lasciano voci vere. */
  e2e:         'e2e/tests',
  /** Gli script di manutenzione lanciati a mano. */
  script:      'apps/api/src/scripts',
}

/**
 * Vero quando la voce è di una persona.
 *
 * Si guarda `user_id`, non `user_email`: l'e-mail di un attore sintetico
 * cambia da un punto all'altro del codice — `automation` scrive ora
 * `userEmail: 'system'` ora `'automation'` — mentre l'id è quello che il
 * chiamante ha deciso di mettere.
 *
 * Un `user_id` vuoto NON è una persona: è una voce scritta da un cammino che
 * non aveva un attore, e contarla come lavoro umano sarebbe peggio che
 * ignorarla.
 */
export function isHumanActor(userId: string | null | undefined): boolean {
  if (userId == null) return false
  const id = userId.trim()
  if (id === '') return false
  return !(id in SYNTHETIC_ACTORS)
}

/**
 * La clausola Cypher che tiene fuori gli attori sintetici.
 *
 * È una funzione e non una costante perché la lista è una sola: se domani se
 * ne aggiunge uno, cambia qui e cambia ovunque. Il nome del parametro è
 * dichiarato, così chi compone la query sa cosa deve passare.
 */
export const SYNTHETIC_ACTORS_PARAM = '__attoriSintetici'

export function humanActorClause(variabile = 'a'): string {
  return `${variabile}.user_id IS NOT NULL AND ${variabile}.user_id <> '' AND NOT ${variabile}.user_id IN $${SYNTHETIC_ACTORS_PARAM}`
}

export function syntheticActorIds(): string[] {
  return Object.keys(SYNTHETIC_ACTORS)
}
