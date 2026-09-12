/**
 * Il `ci_type` che arriva da una discovery deve essere un tipo che **esiste**
 * (ondata 6 · A-11).
 *
 * ## Il difetto
 * `reconcileOne` faceva `ciTypeToLabel(ci_type)` — PascalCase della stringa — e
 * la scriveva come etichetta Neo4j: `ON CREATE SET ci:${label}`. Niente
 * controllava che quell'etichetta appartenesse a un tipo del metamodello.
 * Conseguenze, tutte silenziose:
 *  - un CSV con `ci_type = "Bilanciatore"` creava `:ConfigurationItem:Bilanciatore`,
 *    e **nessuna pagina** mostrava quei CI (le liste costruiscono il filtro dai
 *    tipi attivi);
 *  - un refuso creava un'etichetta per variante («Bilanciatore», «bilanciatore»,
 *    «Bilanciatoer»), ognuna invisibile;
 *  - `inferCIType` (packages/discovery) restituisce `load_balancer`,
 *    `container`, `network`: tre tipi che il prodotto **non ha**. Il connettore
 *    AWS mappa ogni ELB così;
 *  - la riconciliazione li contava come «creati» e il run finiva «completed».
 *
 * ## La regola
 * Il tipo si risolve contro i tipi **attivi del cliente** — per nome, per
 * etichetta, o per un **alias** dichiarato nelle `mapping_rules` della sorgente
 * (`kind: 'ci_type'`) — e il risultato è l'etichetta di quel tipo. Se non si
 * risolve, il CI **non si crea**: nasce un `SyncConflict` di tipo
 * `unknown_ci_type` che dice cosa fare (creare il tipo, o aggiungere l'alias).
 * Mai un'etichetta inventata.
 */
import { loadMetamodel } from '@opengraphity/schema-generator'
import type { SyncSourceConfig } from '@opengraphity/discovery'
import { ciTypeAliases } from '@opengraphity/discovery'
// ci-labels-ok: seme degli ALIAS storici, non l'elenco delle etichette valide — quelle vengono da loadMetamodel (vedi forSource)
import { TYPE_TO_LABEL } from '../lib/ciLabels.js'

/** Un tipo risolto: nome nel metamodello ed etichetta Neo4j. */
export interface ResolvedCIType {
  name:  string
  label: string
}

/**
 * Come si è risolto (o perché no). `alias` dice quale regola ha deciso: serve
 * al messaggio del conflitto e al log, non alla logica.
 */
export type CITypeResolution =
  | { ok: true;  type: ResolvedCIType; via: 'alias' | 'name' | 'label' }
  | { ok: false; reason: string }

/** `bilanciatore` → `Bilanciatore`; `load_balancer` → `LoadBalancer`. */
export function pascalCaseOf(ciType: string): string {
  return ciType.split(/[_\s-]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')
}

/**
 * Il risolutore per un cliente e una sorgente: i tipi attivi (una lettura del
 * metamodello) più gli alias della sorgente. Si costruisce una volta per lotto.
 */
export class CITypeResolver {
  private constructor(
    private readonly tenantId: string,
    /** nome del tipo (minuscolo) → tipo */
    private readonly byName: ReadonlyMap<string, ResolvedCIType>,
    /** etichetta Neo4j (minuscola) → tipo */
    private readonly byLabel: ReadonlyMap<string, ResolvedCIType>,
    /** alias (minuscolo) → nome del tipo dichiarato nelle mapping_rules */
    private readonly aliases: ReadonlyMap<string, string>,
  ) {}

  static async forSource(tenantId: string, source: Pick<SyncSourceConfig, 'mapping_rules'>): Promise<CITypeResolver> {
    const types = await loadMetamodel(tenantId)
    const byName  = new Map<string, ResolvedCIType>()
    const byLabel = new Map<string, ResolvedCIType>()
    for (const t of types) {
      if (!t.neo4jLabel) continue
      const resolved: ResolvedCIType = { name: t.name, label: t.neo4jLabel }
      byName.set(t.name.toLowerCase(), resolved)
      byLabel.set(t.neo4jLabel.toLowerCase(), resolved)
    }
    // Gli alias REST storici dei tipi spediti (`db_instance` →
    // `DatabaseInstance`) valgono anche qui: sono nomi che il prodotto ha
    // pubblicato, non invenzioni. Non decidono QUALI etichette esistono — le
    // chiavi si scartano se `byLabel` (cioè il metamodello del cliente) non ha
    // quell'etichetta, quindi un tipo del cliente si risolve e un alias
    // storico di un tipo assente no.
    const aliases = new Map<string, string>()
    // ci-labels-ok: la tabella è solo la sorgente degli alias; il tipo deve comunque esistere in `byLabel`
    for (const [alias, label] of Object.entries(TYPE_TO_LABEL)) {
      const t = byLabel.get(label.toLowerCase())
      if (t && !byName.has(alias.toLowerCase())) aliases.set(alias.toLowerCase(), t.name)
    }
    // Gli alias del cliente vincono su quelli storici: li ha scritti lui.
    for (const [alias, typeName] of ciTypeAliases(source.mapping_rules ?? [])) {
      aliases.set(alias.toLowerCase(), typeName)
    }
    return new CITypeResolver(tenantId, byName, byLabel, aliases)
  }

  /** I nomi dei tipi attivi, per il messaggio di un conflitto. */
  get typeNames(): string[] {
    return [...new Set([...this.byName.values()].map((t) => t.name))].sort()
  }

  /**
   * `ci_type` → tipo del cliente. Ordine: alias dichiarato, nome del tipo,
   * etichetta Neo4j (anche nella forma PascalCase del nome, che è quella che i
   * connettori producono).
   */
  resolve(ciType: string): CITypeResolution {
    const raw = ciType.trim()
    if (raw === '') {
      return { ok: false, reason: `il campo "ci_type" è vuoto: il connettore non ha detto di che tipo è questo elemento` }
    }
    const key = raw.toLowerCase()

    const aliasTarget = this.aliases.get(key)
    if (aliasTarget) {
      const t = this.byName.get(aliasTarget.toLowerCase())
      if (t) return { ok: true, type: t, via: 'alias' }
      return {
        ok: false,
        reason:
          `l'alias "${raw}" punta al tipo "${aliasTarget}", che in questo cliente non esiste o non è attivo. ` +
          `Correggi l'alias nelle regole di mappatura della sorgente, oppure crea il tipo "${aliasTarget}".`,
      }
    }

    const byName = this.byName.get(key)
    if (byName) return { ok: true, type: byName, via: 'name' }

    const byLabel = this.byLabel.get(key) ?? this.byLabel.get(pascalCaseOf(raw).toLowerCase())
    if (byLabel) return { ok: true, type: byLabel, via: 'label' }

    return {
      ok: false,
      reason:
        `"${raw}" non è un tipo di CI di questo cliente (${this.tenantId}). ` +
        `Due strade: crea il tipo nel disegnatore dei tipi CI, oppure aggiungi un alias nelle regole di ` +
        `mappatura della sorgente ({"kind":"ci_type","source_field":"${raw}","target_field":"<tipo esistente>"}). ` +
        `Tipi attivi: ${this.typeNames.join(', ')}.`,
    }
  }
}
