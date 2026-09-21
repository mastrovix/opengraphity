/**
 * DATI DI TEST — I TEAM (17 set 2026, primo seme del pacchetto).
 *
 * Questo è dato di ESERCIZIO, non di fabbrica: non entra nel provisioning e un
 * cliente vero non lo vede mai nascere addosso. Si chiama alla bisogna — dal
 * pulsante della console e dalla riga di comando — e le due strade passano da
 * qui, perché due generatori di dati finti divergono al primo campo nuovo.
 *
 * ## Un team seminato è identico a un team creato dall'interfaccia
 * Stesse proprietà della mutation `createTeam` (`id`, `tenant_id`, `name`,
 * `description`, `type`, `sourcing`, `created_at`, `updated_at`). Un solo
 * campo mancante e il dato di test smette di provare qualcosa: i 70 team di
 * `c-one` seminati da vecchi script non hanno `sourcing`, e in lista
 * compaiono senza provenienza — un difetto che nessun cliente ha mai avuto,
 * cioè rumore.
 *
 * ## Il tipo passa dal vocabolario del cliente
 * `owner` non si scrive a mano nel nodo: si valida con `assertDomainValue`,
 * la stessa funzione della mutation. Se un cliente ha rinominato quel valore,
 * il seme si FERMA e lo dice invece di scrivere un tipo che nessuna pastiglia
 * e nessun filtro riconoscono.
 *
 * ## Ripetibile
 * `MERGE` su (tenant_id, name): premere il pulsante due volte non raddoppia i
 * team. Un team già presente non viene toccato — nemmeno se qualcuno ne ha
 * cambiato il tipo a mano, perché da quel momento è una scelta di chi
 * amministra e non un dato di test da riallineare.
 */
import { v4 as uuidv4 } from 'uuid'
import type { Queryable } from '@opengraphity/neo4j'
import { runQuery } from '@opengraphity/neo4j'
import { assertDomainValue } from '../domainMatrix.js'
import { TEAM_TYPE_VOCABULARY } from '../teamVocabularies.js'
import { TEST_TEAM_NAMES, TEST_TEAM_PREFIX } from './teamNames.js'

export interface EsitoSeedTeam {
  /** Quanti team esistono ora col prefisso dei dati di test. */
  totale: number
  /** Quanti sono nati in questa chiamata (gli altri c'erano già). */
  creati: number
  /** Il tipo scritto, come lo chiama il vocabolario del cliente. */
  tipo: string
}

/**
 * I team di esercizio, tutti di tipo `owner` e `internal`.
 *
 * `quanti` serve a chi vuole un tenant piccolo: prende i primi N dell'elenco,
 * che è ordinato per area — quindi un sottoinsieme resta verosimile e non
 * diventa «tutte reti e niente applicazioni».
 */
export async function seedTestTeams(
  session: Queryable,
  tenantId: string,
  opts: { quanti?: number } = {},
): Promise<EsitoSeedTeam> {
  const quanti = Math.min(opts.quanti ?? TEST_TEAM_NAMES.length, TEST_TEAM_NAMES.length)
  if (quanti < 1) throw new Error('seedTestTeams: "quanti" must be at least 1')

  // La stessa validazione della mutation: il tipo è un valore del vocabolario
  // del cliente, non una parola scritta nel codice.
  const tipo = await assertDomainValue(tenantId, TEAM_TYPE_VOCABULARY, 'owner')

  const now = new Date().toISOString()
  let creati = 0
  for (const nome of TEST_TEAM_NAMES.slice(0, quanti)) {
    const righe = await runQuery<{ nato: boolean }>(session, `
      MERGE (t:Team {tenant_id: $tenantId, name: $name})
      ON CREATE SET
        t.id          = $id,
        t.description = $description,
        t.type        = $tipo,
        t.sourcing    = 'internal',
        t.created_at  = $now,
        t.updated_at  = $now
      RETURN t.created_at = $now AS nato
    `, {
      tenantId,
      name: `${TEST_TEAM_PREFIX}${nome}`,
      id: uuidv4(),
      // La descrizione dice che è un dato di esercizio: chi lo trova in un
      // ambiente sbagliato deve capirlo dal nodo, non dal nome del tenant.
      description: 'Test data',
      tipo,
      now,
    })
    if (righe[0]?.nato === true) creati += 1
  }

  const conteggio = await runQuery<{ totale: unknown }>(session, `
    MATCH (t:Team {tenant_id: $tenantId})
    WHERE t.name STARTS WITH $prefisso
    RETURN count(t) AS totale
  `, { tenantId, prefisso: TEST_TEAM_PREFIX })

  return { totale: Number(conteggio[0]?.totale ?? 0), creati, tipo }
}
