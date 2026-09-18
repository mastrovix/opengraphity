/**
 * LE CHANGE FERME CON LA STRADA APERTA (17 set 2026).
 *
 * Le transizioni automatiche si valutano SOLO dentro una mutation sulla change
 * (`evaluateAutoTransitions`, chiamato da chi chiude un assessment, salva o
 * completa un piano, approva): nessun job periodico le ripassa. Una change che
 * si perde la sua occasione — un errore in quell'istante, un cammino che non
 * chiamava il walker, una condizione che allora non era registrata — resta
 * ferma **per sempre**, anche con tutte le condizioni soddisfatte, e niente lo
 * dice a nessuno.
 *
 * Trovato su `CHG00000003` di `c-one`: ferma in analisi dal 7 settembre con i
 * tre task completati e `all_assessments_complete` VERA. Sarebbe bastato
 * toccarla per sbloccarla, ma nessuno sapeva di doverlo fare.
 *
 * ## Si SEGNALA, non si ripara
 * Far avanzare le change da un controllo di diagnostica vorrebbe dire
 * transizioni che partono da sole, senza un attore e senza una mutation che le
 * abbia chieste: l'audit direbbe «sistema», e il varco delle approvazioni
 * verrebbe attraversato da un percorso in più — il difetto che la terza
 * revisione ha chiuso con fatica. Meglio dirlo a chi può aprire la change e
 * farla camminare.
 *
 * ## La condizione la valuta IL MOTORE
 * Si chiama `workflowEngine.evaluateCondition`, la stessa funzione della
 * transizione vera: rifare qui «tutti gli assessment completi» in Cypher
 * darebbe una seconda copia della regola, e la copia sbaglierebbe da sola.
 */
import type { Session } from 'neo4j-driver'
import { runQuery } from '@opengraphity/neo4j'

/**
 * Il tetto dei candidati da valutare: questo è un controllo di diagnostica, non
 * un lavoro. Se ce ne sono di più il rilievo lo dice col conto, e la cosa da
 * fare non cambia.
 *
 * Si INTERPOLA nella query, come gli altri tetti del codice (`topology.ts`,
 * `services.ts`), e non si passa come parametro: un numero JS arriva a Neo4j
 * come FLOAT, e `LIMIT` vuole un INTEGER. Passandolo come `$max` l'intera
 * diagnostica moriva con «LIMIT: '200.0' is not a valid value» — un errore che
 * nessun test con un driver finto può vedere, perché il tipo lo rifiuta il
 * server (17 set 2026).
 */
export const MAX_CHANGE_DA_VALUTARE = 200

interface Candidato {
  code:       string
  changeId:   string
  instanceId: string
  fromStep:   string
  toStep:     string
  condition:  string | null
  props:      Record<string, unknown>
}

/**
 * I codici delle change il cui arco automatico è già percorribile, nell'ordine
 * in cui la query li restituisce (`ORDER BY c.code`) e senza ripetizioni: una
 * change con due archi aperti è UN rilievo, e la sua condizione si valuta una
 * volta sola.
 */
export async function changesStuckWithOpenPath(session: Session, tenantId: string): Promise<string[]> {
  const candidati = await runQuery<Candidato>(session, `
    MATCH (c:Change {tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId})
    WHERE coalesce(c.deleted, false) = false AND wi.status = 'active'
    MATCH (wi)-[:CURRENT_STEP]->(cur:WorkflowStep)-[tr:TRANSITIONS_TO {trigger: 'automatic'}]->(next:WorkflowStep)
    RETURN c.code AS code, c.id AS changeId, wi.id AS instanceId,
           cur.name AS fromStep, next.name AS toStep, tr.condition AS condition,
           properties(c) AS props
    ORDER BY c.code
    LIMIT ${MAX_CHANGE_DA_VALUTARE}
  `, { tenantId })
  // Nessun candidato, nessun motore da caricare: la strada corta è anche la
  // più comune, perché le change in un passo con un arco automatico sono poche.
  if (candidati.length === 0) return []

  /*
   * Import DINAMICI, e per due ragioni diverse.
   *
   * `workflow/conditions.js` registra le condizioni ITSM sul motore come
   * effetto del caricamento: senza, `evaluateCondition` non le conosce e questo
   * controllo direbbe che nessuna change è ferma.
   *
   * Il motore arriva da qui e non dall'alto del file perché tirarlo dentro
   * all'import fa caricare `engine.ts`, che vuole `toNumber` da
   * `@opengraphity/neo4j`: in un test che quel modulo lo sostituisce con una
   * finta, l'intera suite della diagnostica non si raccoglieva più. Un
   * controllo di diagnostica non deve decidere cosa si può provare altrove.
   */
  const { workflowEngine } = await import('@opengraphity/workflow')
  await import('../workflow/conditions.js')
  /*
   * IL VARCO, e non solo la condizione dell'arco (18 set 2026).
   *
   * Questo controllo guardava la sola condizione, e il 18 set l'ho visto
   * elencare `CHG00000008` fra le change «ferme pur avendo la strada aperta»
   * mentre il varco rifiutava ENTRAMBI i suoi archi automatici. Il consiglio
   * del rilievo — «apri quelle change e fai avanzare il passo: il lavoro è già
   * finito, manca solo il movimento» — su quella change non muove niente: il
   * lavoro NON è finito (mancano approvazioni o valutazioni), e il varco fa
   * bene a tenerla dov'è.
   *
   * Si chiama `automaticTransitionOutcome`, che è la decisione del varco senza
   * log né metrica: `automaticTransitionAllowed` conta un rifiuto ogni volta, e
   * una diagnostica che gira ogni minuto per ogni tenant avrebbe sepolto i
   * rifiuti veri sotto quelli immaginari.
   */
  const { automaticTransitionOutcome } = await import('../graphql/resolvers/change/windowGate.js')

  const ferme = new Set<string>()
  for (const r of candidati) {
    if (ferme.has(r.code)) continue
    // Un arco automatico SENZA condizione doveva scattare all'istante: se la
    // change è ancora qui, l'occasione è stata persa.
    let passa = r.condition === null || r.condition === ''
    if (!passa && r.condition) {
      try {
        passa = await workflowEngine.evaluateCondition(session, r.condition, {
          instanceId: r.instanceId, entityId: r.changeId, entityType: 'change', tenantId,
          fromStepName: r.fromStep, toStepName: r.toStep, triggerType: 'automatic',
          entityData: r.props,
        })
      } catch {
        /*
         * Condizione non registrata: è un workflow mal configurato, e ha già il
         * suo sintomo — il motore rifiuta ogni transizione su quell'arco e lo
         * dice. Non è «ferma con la strada aperta», quindi qui non si conta:
         * segnalarla con questa frase manderebbe ad aprire una change che non
         * si muoverà comunque.
         */
        continue
      }
    }
    if (!passa) continue

    /*
     * La condizione è soddisfatta, ma la strada è davvero aperta solo se lo
     * dice anche il varco: altrimenti la change non è ferma per un'occasione
     * persa — sta aspettando qualcosa di legittimo, e dirlo con questa frase
     * manderebbe a spingere un passo che il prodotto rifiuterà.
     */
    const varco = await automaticTransitionOutcome(session, {
      tenantId,
      changeId:    r.changeId,
      changeType:  String(r.props['change_type'] ?? ''),
      currentStep: r.fromStep,
      toStep:      r.toStep,
    })
    if (varco.allowed) ferme.add(r.code)
  }
  return [...ferme]
}
