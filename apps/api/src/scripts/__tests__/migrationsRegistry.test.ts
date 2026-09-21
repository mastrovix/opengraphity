import { describe, it, expect } from 'vitest'
import { validateMigrations, migrationChecksum } from '@opengraphity/neo4j'
import { MIGRATIONS } from '../migrations/index.js'

/** Le proprietà che descrivono uno STATO: cambiano nel tempo, quindi non identificano. */
const STATO = ['scope', 'active', 'is_default', 'status', 'enabled', 'revision']

/**
 * I `MERGE` che tengono una proprietà di stato nella chiave di match. Esportata
 * come funzione perché il test qui sotto pretende che riconosca il caso storico:
 * un guardiano che non vede il proprio difetto è un guardiano muto.
 */
function mergeConStatoNellaChiave(src: string): string[] {
  const out: string[] = []
  const righe = src.split('\n')
  righe.forEach((riga, i) => {
    const merge = /MERGE \(.*?\{([^}]*)\}/.exec(riga)
    if (!merge) return
    if (/merge-key-ok/.test(riga) || /merge-key-ok/.test(righe[i - 1] ?? '')) return
    for (const prop of STATO) {
      if (new RegExp(`(^|[^\\w.])${prop}\\s*:`).test(merge[1] ?? '')) {
        out.push(`MERGE con "${prop}" nella chiave — ${riga.trim().slice(0, 90)}`)
      }
    }
  })
  return out
}

describe('scripts/migrations registry', () => {
  it('every migration has a valid, unique id, a description and an up()', () => {
    const sorted = validateMigrations(MIGRATIONS)
    expect(sorted.length).toBe(MIGRATIONS.length)
    for (const m of sorted) {
      expect(m.description.length).toBeGreaterThan(10)
      expect(migrationChecksum(m)).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('the CALL … IN TRANSACTIONS migration is declared autocommit (it cannot run in an explicit transaction)', () => {
    for (const m of MIGRATIONS) {
      const src = m.up.toString()
      if (/IN TRANSACTIONS/i.test(src)) expect(m.autocommit, `${m.id} must set autocommit: true`).toBe(true)
    }
  })

  /**
   * ANCHE I VINCOLI E GLI INDICI vogliono `autocommit` (revisione del 17 set
   * 2026). Neo4j rifiuta `CREATE CONSTRAINT`/`CREATE INDEX` dentro la
   * transazione del marcatore di migrazione: è il motivo per cui
   * `20261003_1010_catalog_form_schema` lo dichiara, e la regola non era
   * scritta da nessuna parte. La prossima migrazione che aggiunge un vincolo
   * senza dichiararlo fallirebbe AL DEPLOY — non in CI — e a metà catena, cioè
   * su un database migrato a metà.
   */
  it('le migrazioni che creano vincoli o indici sono dichiarate autocommit', () => {
    for (const m of MIGRATIONS) {
      const src = m.up.toString()
      if (/CREATE\s+(CONSTRAINT|INDEX)/i.test(src)) {
        expect(m.autocommit, `${m.id} crea un vincolo o un indice: serve autocommit: true`).toBe(true)
      }
    }
  })

  /**
   * LA CHIAVE DI UN `MERGE` NON PORTA UNA PROPRIETÀ CHE ALTRI RISCRIVONO.
   *
   * È il difetto che ha creato cinque campi duplicati nel metamodello
   * (`20260920_1720`, che teneva `scope` nella chiave): appena un'altra
   * migrazione ha toccato quei nodi il MERGE non li ha più riconosciuti come
   * suoi e ne ha creati altri accanto. Le proprietà ammesse nella chiave sono
   * quelle che IDENTIFICANO il nodo — `id`, `tenant_id`, `name`, la chiave
   * naturale — non quelle che descrivono uno stato (`scope`, `active`,
   * `is_default`, `status`), che cambiano nel tempo.
   *
   * Un caso legittimo si marca con `// merge-key-ok` nella riga sopra, dicendo
   * perché quella proprietà è parte dell'identità.
   */
  it('nessun MERGE tiene nella chiave una proprietà di stato', () => {
    const colpevoli = MIGRATIONS.flatMap((m) => mergeConStatoNellaChiave(m.up.toString()).map((r) => `${m.id}: ${r}`))
    expect(colpevoli).toEqual([])
  })

  /* Il guardiano deve VEDERE il caso che lo motiva, altrimenti è muto. */
  it('la regola riconosce il MERGE che ha creato i doppioni del metamodello', () => {
    const rotto = [
      'MATCH (t:CITypeDefinition {id: $tipoId})',
      "MERGE (t)-[:HAS_FIELD]->(f:CIFieldDefinition {name: $nome, tenant_id: $tenant, scope: 'itil'})",
      'ON CREATE SET f.id = $id',
    ].join('\n')
    expect(mergeConStatoNellaChiave(rotto)).toHaveLength(1)
    // Con `scope` fuori dalla chiave (come è adesso) non è più un rilievo.
    expect(mergeConStatoNellaChiave(rotto.replace(", scope: 'itil'", ''))).toEqual([])
    // E il marcatore dichiara un caso legittimo.
    expect(mergeConStatoNellaChiave(rotto.replace('MERGE (t)', '// merge-key-ok: qui è identità\nMERGE (t)'))).toEqual([])
  })
})
