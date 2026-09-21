/**
 * IL TIPO DI TEAM DIVENTA UN VOCABOLARIO — e i team che ci sono già lo tengono.
 *
 * Com'era: `owner` e `support` erano due stringhe scritte nella pagina «Team e
 * Utenti» (nelle opzioni del filtro) e nient'altro. `CreateTeamInput` non
 * aveva il campo, `createTeam` scriveva `type: null`, e `type` non era fra i
 * campi filtrabili dell'API — quindi un team creato dall'interfaccia nasceva
 * senza tipo, non c'era nessuna scrittura per dargliene uno, e il filtro che
 * la pagina offriva non filtrava niente. I soli team con un tipo erano quelli
 * del seed.
 *
 * Da adesso `team_type` è un vocabolario spedito come gli altri (vive su
 * `tenant_id = 'system'`, il cliente lo personalizza dal Dizionario), l'API lo
 * valida in scrittura e l'interfaccia offre una tendina.
 *
 * Questa migrazione fa due cose, entrambe conservative:
 *
 *  1. semina il vocabolario (`seedSystemEnumTypes` è idempotente e ora lo
 *     contiene): senza questo, su un'installazione esistente il seed non
 *     rigira e la tendina resterebbe vuota — cioè il difetto di prima con un
 *     vestito nuovo;
 *  2. **non tocca nessun team**. I valori già scritti (`owner`, `support`)
 *     sono esattamente quelli del seme, quindi restano validi. Se un tenant
 *     avesse un valore FUORI vocabolario lo dice in console invece di
 *     riscriverlo: un dato che non conosciamo non lo aggiustiamo a indovinare.
 */
import type { Migration } from '@opengraphity/neo4j'
import { seedSystemEnumTypes, SYSTEM_ENUMS } from '../../lib/seedEnumTypes.js'
import { TEAM_TYPE_VOCABULARY } from '../../lib/teamVocabularies.js'

export const teamTypeVocabolario: Migration = {
  id:          '20260921_1000_team_type_vocabolario',
  description: 'team_type diventa un vocabolario del Dizionario (prima era una lista nella pagina)',

  async up(session) {
    await seedSystemEnumTypes(session)

    const seme = SYSTEM_ENUMS.find((e) => e.name === TEAM_TYPE_VOCABULARY)
    if (!seme) throw new Error(`[20260921_1000] ${TEAM_TYPE_VOCABULARY} non è fra i vocabolari spediti: il seed non lo creerebbe`)
    console.log(`[20260921_1000] vocabolario ${TEAM_TYPE_VOCABULARY} = ${seme.values.join(', ')}`)

    // Solo un referto: i valori fuori vocabolario si guardano, non si toccano.
    const r = await session.run(
      `MATCH (t:Team)
       WHERE t.type IS NOT NULL AND t.type <> '' AND NOT t.type IN $valori
       RETURN t.tenant_id AS tenantId, t.type AS type, count(*) AS quanti`,
      { valori: seme.values },
    )
    for (const rec of r.records) {
      console.warn(
        `[20260921_1000] ${rec.get('tenantId') as string}: ${String(rec.get('quanti'))} team con type `
        + `"${rec.get('type') as string}", che non è nel vocabolario spedito — aggiungilo dal Dizionario `
        + `(Impostazioni → Dizionario → Team Type) oppure cambia il tipo di quei team`,
      )
    }
    if (r.records.length === 0) console.log('[20260921_1000] nessun team con un tipo fuori vocabolario')
  },
}
