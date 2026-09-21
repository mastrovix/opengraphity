/**
 * Personalizzazioni, ondata 7 — correzione del seme della matrice
 * `change_priority`, e semina della matrice `change_priority_initial`.
 *
 * ## Cosa è andato storto
 * Il seme della matrice «tipo di change × fascia di rischio» era stato
 * **scritto a intuito** invece che trascritto da `deriveChangePriority`, e due
 * celle su nove non corrispondevano al codice che sostituiva:
 *
 *   - `emergency|medium`: seminata `critical`, il codice dava `high`;
 *   - `normal|low`:       seminata `medium`,   il codice dava `low`.
 *
 * E la regola «rischio non ancora valutato» era stata collassata nella fascia
 * più bassa, mentre il codice la teneva distinta (una change `normal` appena
 * creata era `medium`, una con rischio basso misurato era `low`).
 *
 * Il codice è stato corretto, ma **il dato seminato prima della correzione
 * resta sbagliato**: questa migrazione lo sistema.
 *
 * ## Perché non riscrive tutto
 * Solo le matrici **mai modificate dal cliente**, riconosciute perché il loro
 * contenuto è esattamente il seme sbagliato. Se un amministratore ha già
 * corretto o personalizzato una cella, la sua scelta vale più di questa
 * migrazione: in quel caso non si tocca niente e si stampa il tenant, così la
 * cosa resta visibile.
 */
import type { Migration } from '@opengraphity/neo4j'
import { DOMAIN_MATRIX_SEEDS } from '../../lib/domainMatrix.js'

/** Il seme sbagliato, come è stato scritto sul grafo. */
const WRONG_CHANGE_PRIORITY: Readonly<Record<string, string>> = {
  'emergency|high': 'critical', 'emergency|medium': 'critical', 'emergency|low': 'high',
  'normal|high':    'high',     'normal|medium':    'medium',   'normal|low':    'medium',
  'standard|high':  'medium',   'standard|medium':  'low',      'standard|low':  'low',
}

function sameEntries(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort()
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false
  return ka.every((k) => a[k] === b[k])
}

export const changePrioritySeedFix: Migration = {
  id: '20260917_1820_change_priority_seed_fix',
  description: 'DomainMatrix: corregge le due celle del seme change_priority che non trascrivevano deriveChangePriority (emergency|medium, normal|low) e semina change_priority_initial',
  async up(session) {
    const now = new Date().toISOString()

    // 1. Le matrici `change_priority` ancora identiche al seme sbagliato.
    const existing = await session.run(`
      MATCH (m:DomainMatrix {kind: 'change_priority'})
      RETURN m.tenant_id AS tenantId, m.entries AS entries
      ORDER BY tenantId
    `)
    let fixed = 0, keptCustom = 0
    for (const rec of existing.records) {
      const tenantId = String(rec.get('tenantId'))
      const raw = rec.get('entries')
      let parsed: Record<string, string>
      try { parsed = typeof raw === 'string' ? JSON.parse(raw) as Record<string, string> : raw as Record<string, string> }
      catch { console.log(`[${changePrioritySeedFix.id}] ${tenantId}: entries illeggibili, non toccate`); continue }

      if (!sameEntries(parsed, WRONG_CHANGE_PRIORITY as Record<string, string>)) {
        keptCustom++
        console.log(`[${changePrioritySeedFix.id}] ${tenantId}: matrice già modificata, lasciata com'è (verifica a mano emergency|medium e normal|low)`)
        continue
      }
      await session.run(
        `MATCH (m:DomainMatrix {tenant_id: $tenantId, kind: 'change_priority'})
         SET m.entries = $entries, m.updated_at = $now`,
        { tenantId, entries: JSON.stringify(DOMAIN_MATRIX_SEEDS.change_priority), now },
      )
      fixed++
      console.log(`[${changePrioritySeedFix.id}] ${tenantId}: emergency|medium critical→high, normal|low medium→low`)
    }

    // 2. La matrice della priorità di PARTENZA, che prima non esisteva: si
    //    semina per ogni tenant che ha già le altre (idempotente: `MERGE` +
    //    scrittura solo se assente).
    const seeded = await session.run(
      `MATCH (other:DomainMatrix {kind: 'change_priority'})
       WITH DISTINCT other.tenant_id AS tenantId
       MERGE (m:DomainMatrix {tenant_id: tenantId, kind: 'change_priority_initial'})
       ON CREATE SET m.entries = $entries, m.updated_at = $now, m.created_at = $now
       RETURN tenantId, m.updated_at = $now AS created`,
      { entries: JSON.stringify(DOMAIN_MATRIX_SEEDS.change_priority_initial), now },
    )
    const created = seeded.records.filter((r) => r.get('created') === true).length
    console.log(
      `[${changePrioritySeedFix.id}] ${String(fixed)} matrici corrette, ${String(keptCustom)} lasciate (personalizzate), ` +
      `${String(created)} matrici "priorità di partenza" create su ${String(seeded.records.length)} tenant.`,
    )
  },
}
