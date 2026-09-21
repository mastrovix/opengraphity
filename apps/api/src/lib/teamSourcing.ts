/**
 * INTERNO O ESTERNO: da dove viene un team.
 *
 * È un'informazione diversa dal TIPO (`team_type`: owner / support), che dice
 * che ruolo ha il team rispetto ai CI. Questa dice se le persone del team sono
 * dell'organizzazione o di un fornitore — ed è la distinzione che l'ITIL fa
 * fra un OLA (obiettivo fra team interni) e un UC (contratto con un fornitore
 * esterno).
 *
 * Due soli valori, e NON un vocabolario del Dizionario, di proposito: non è una
 * classificazione che il cliente arricchisce («partner», «consulente»…), è un
 * fatto binario su cui il prodotto può ragionare. Le ETICHETTE a schermo sono
 * chiavi i18n (`pages.teams.sourcing.*`), quindi il testo resta del client.
 *
 * `null` sul nodo vuol dire «non indicato»: è lo stato dei team che esistevano
 * prima di questo campo. Non lo si indovina — la diagnostica della
 * configurazione li elenca finché qualcuno non lo dice (`checkTeamSourcing`).
 * Un team NUOVO invece nasce con il valore: l'API lo pretende.
 */
import type { Session } from 'neo4j-driver'
import { ValidationError } from './errors.js'

export const TEAM_SOURCINGS = ['internal', 'external'] as const
export type TeamSourcing = typeof TEAM_SOURCINGS[number]

export function isTeamSourcing(v: unknown): v is TeamSourcing {
  return typeof v === 'string' && (TEAM_SOURCINGS as readonly string[]).includes(v)
}

/** Il valore, o un rifiuto che dice quali sono ammessi. Assente = rifiuto: non c'è un default. */
export function assertTeamSourcing(v: unknown): TeamSourcing {
  if (isTeamSourcing(v)) return v
  throw new ValidationError(
    `A team must say whether it is internal or external: got ${JSON.stringify(v ?? null)}, allowed ${TEAM_SOURCINGS.join(', ')}`,
    { key: 'errors.team.sourcingRequired', params: { allowed: TEAM_SOURCINGS.join(', ') } },
  )
}

/** Quanti team non dicono ancora se sono interni o esterni, e i primi nomi. */
export async function teamsWithoutSourcing(
  session: Session, tenantId: string, limit = 10,
): Promise<{ count: number; names: string[] }> {
  const r = await session.executeRead((tx) => tx.run(
    `MATCH (t:Team {tenant_id: $tenantId})
     WHERE t.sourcing IS NULL OR NOT t.sourcing IN $valori
     WITH t ORDER BY t.name
     WITH collect(t.name) AS nomi
     RETURN size(nomi) AS count, nomi[0..$limit] AS names`,
    { tenantId, valori: [...TEAM_SOURCINGS], limit },
  ))
  const rec = r.records[0]
  if (!rec) return { count: 0, names: [] }
  const count = rec.get('count') as number | { toNumber(): number }
  return {
    count: typeof count === 'number' ? count : count.toNumber(),
    names: (rec.get('names') as string[] | null) ?? [],
  }
}
