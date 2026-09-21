/**
 * Revisione totale del 16 set 2026 · C-8: `SLAStatus.breached` diceva CHE la
 * violazione è avvenuta, non QUANDO. Il riquadro «SLA violati» del digest
 * giornaliero contava gli SLA *iniziati* nelle ultime 24 ore che risultano
 * violati: un numero sbagliato in entrambe le direzioni.
 *
 * Da qui in avanti `markBreached` scrive `breached_at`. Per le violazioni
 * già avvenute l'istante si ricava dalla scadenza di risoluzione, che è il
 * momento in cui la violazione si è prodotta (la pausa già scontata è dentro
 * la scadenza). Dove non c'è nemmeno quella resta `null`: meglio un buco
 * dichiarato di una data inventata. Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'

export const slaBreachedAt: Migration = {
  id:          '20261002_1000_sla_breached_at',
  description: 'breached_at sugli SLAStatus già violati (dalla scadenza di risoluzione): il digest conta le violazioni avvenute',

  async up(session) {
    const res = await session.run(`
      MATCH (s:SLAStatus)
      WHERE s.breached = true AND s.breached_at IS NULL AND s.resolve_deadline IS NOT NULL
      SET s.breached_at = s.resolve_deadline
      RETURN count(s) AS n`)
    const left = await session.run(`
      MATCH (s:SLAStatus)
      WHERE s.breached = true AND s.breached_at IS NULL
      RETURN count(s) AS n`)
    console.log(`[${slaBreachedAt.id}] violazioni datate dalla scadenza: ${String(res.records[0]?.get('n'))}, senza data (nessuna scadenza di risoluzione): ${String(left.records[0]?.get('n'))}`)
  },
}
