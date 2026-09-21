/**
 * LA STORIA DELLE ASSEGNAZIONI DI UN TICKET A UN TEAM (secondo giro UI del 15
 * set 2026, decisione del proprietario: un OLA misura «il tempo del team»).
 *
 * Sul ticket c'era solo il team di adesso (`ASSIGNED_TO_TEAM`): da quando lo
 * aveva e chi lo aveva avuto prima non si sapeva, quindi un OLA poteva solo
 * contare dall'apertura del ticket, e un team pagava anche il tempo in cui il
 * ticket era di altri. Qui ogni cambio di team scrive un tratto:
 *
 *   (ticket)-[:TEAM_SEGMENT]->(:TicketTeamSegment {team_id, started_at, ended_at})
 *
 * `ended_at` null = il team ce l'ha adesso. Rimettere lo stesso team non apre un
 * tratto nuovo. `inferred: true` = un tratto ricostruito per un ticket che c'era
 * già (inizio = apertura del ticket): la migrazione 20260930_1030 e l'import
 * storico, dove il vero inizio non si sa.
 *
 * Vale anche per i task della change che hanno un team (assessment, piano di
 * deploy): anche su di loro un OLA misura il tempo del team.
 *
 * È L'UNICO modo di cambiare il team di un ticket o di un task: il test
 * `ticketTeamWrites.test.ts` rifiuta un `ASSIGNED_TO_TEAM` scritto altrove.
 * Prima i posti erano cinque, e uno (l'azione «Assegna a» dei passi del
 * workflow) aggiungeva il team nuovo senza togliere quello vecchio.
 */

/** Il parametro con l'istante del cambio, da passare insieme al frammento. */
export const TEAM_NOW_PARAM = '__teamNow'

/**
 * Il frammento Cypher che assegna il ticket `e` al team `t` (entrambi già nel
 * `MATCH`): toglie il team di prima, crea quello nuovo, chiude il tratto aperto
 * di un altro team e ne apre uno se il team nuovo non ce l'ha già. Dopo il
 * frammento restano in scope `e`, `t` e ciò che è stato dichiarato in `carry`.
 * Serve il parametro `$__teamNow`.
 *
 * `startedAt`: l'espressione Cypher dell'inizio del tratto (default l'istante
 * del cambio); `inferred` per i tratti ricostruiti.
 *
 * `carry`: LE VARIABILI DA PORTARE DALL'ALTRA PARTE (20 set 2026).
 *
 * Il frammento comincia con un `WITH ${e}, ${t}`, e un `WITH` non elenca: taglia.
 * Qualunque variabile letta PRIMA — e leggere prima è obbligatorio per il team
 * di partenza, visto che qui dentro viene cancellato — moriva sulla prima riga
 * del frammento, e la query falliva a tempo di esecuzione con «Variable ... not
 * defined». Trovato assegnando un team dal browser: il guardiano delle query
 * non lo vede, perché questa è una delle query COMPOSTE che non manda in
 * EXPLAIN. Chi ha bisogno di un valore di prima lo dichiara qui, e il frammento
 * lo ripete in ogni `WITH`.
 */
export function assignTeamCypher(
  e: string, t: string,
  opts: { startedAt?: string; inferred?: boolean; carry?: string[] } = {},
): string {
  const start = opts.startedAt ?? `$${TEAM_NOW_PARAM}`
  const anche = (opts.carry ?? []).map((v) => `, ${v}`).join('')
  return `
    WITH ${e}, ${t}${anche}
    OPTIONAL MATCH (${e})-[__oldTeam:ASSIGNED_TO_TEAM]->(:Team)
    DELETE __oldTeam
    WITH DISTINCT ${e}, ${t}${anche}
    CREATE (${e})-[:ASSIGNED_TO_TEAM]->(${t})
    WITH ${e}, ${t}${anche}
    OPTIONAL MATCH (${e})-[:TEAM_SEGMENT]->(__openSeg:TicketTeamSegment)
      WHERE __openSeg.ended_at IS NULL AND __openSeg.team_id <> ${t}.id
    SET __openSeg.ended_at = $${TEAM_NOW_PARAM}
    WITH DISTINCT ${e}, ${t}${anche}
    OPTIONAL MATCH (${e})-[:TEAM_SEGMENT]->(__sameSeg:TicketTeamSegment {team_id: ${t}.id})
      WHERE __sameSeg.ended_at IS NULL
    WITH ${e}, ${t}${anche}, count(__sameSeg) AS __hasOpenSeg
    FOREACH (_ IN CASE WHEN __hasOpenSeg = 0 THEN [1] ELSE [] END |
      CREATE (${e})-[:TEAM_SEGMENT]->(:TicketTeamSegment {
        id: randomUUID(), tenant_id: ${e}.tenant_id, team_id: ${t}.id,
        started_at: ${start}, ended_at: null, inferred: ${opts.inferred === true}
      })
    )
    WITH ${e}, ${t}${anche}`
}

/**
 * Il PRIMO team di un nodo appena creato (i task di una change nascono col team
 * del CI): se `e` non ha ancora un team, lo assegna a `t` e apre il tratto da
 * `startedAt` (un'espressione Cypher). Se ce l'ha già non tocca niente: rimettere
 * un CI in una change non deve aggiungere un secondo team al task che esisteva.
 * Non cambia lo scope delle variabili.
 */
export function firstTeamCypher(e: string, t: string, startedAt: string): string {
  return `
    FOREACH (__firstTeam IN CASE WHEN NOT EXISTS { (${e})-[:ASSIGNED_TO_TEAM]->(:Team) } THEN [1] ELSE [] END |
      CREATE (${e})-[:ASSIGNED_TO_TEAM]->(${t})
      CREATE (${e})-[:TEAM_SEGMENT]->(:TicketTeamSegment {
        id: randomUUID(), tenant_id: ${e}.tenant_id, team_id: ${t}.id, started_at: ${startedAt}, ended_at: null, inferred: false
      })
    )`
}
