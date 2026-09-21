/**
 * QUANTO COSTA L'AI A UN CLIENTE (20 set 2026, ondata 4).
 *
 * ## Il buco
 * `ai_tokens_total{feature, kind}` conta i gettoni per FUNZIONE. Non per
 * cliente: in tutto `metrics.ts` l'unica famiglia con l'etichetta `tenant` è
 * quella del provisioning. Quindi «quanto ci costa questo cliente» non era
 * una domanda rispondibile — nemmeno approssimativamente, nemmeno in memoria.
 * Con l'ondata 4 arriva la prima funzione che gira da sola, di notte, senza
 * che nessuno clicchi: è il momento sbagliato per non saperlo.
 *
 * ## Perché nel grafo e non in una metrica
 * Una metrica Prometheus con l'etichetta `tenant` moltiplica la cardinalità
 * per il numero di clienti su OGNI serie, e Prometheus qui ha una retention
 * corta: fra due mesi la domanda «quanto è costato marzo» non avrebbe più una
 * risposta. Un nodo per (tenant, mese, funzione) è una riga che si somma, si
 * conserva, e si legge con una query.
 *
 * ## Il registro serve a SAPERE, non a bloccare
 * Il progetto è esplicito: il tetto si decide quando il registro avrà un mese
 * di dati, e sarà un campo dell'amministratore, non un limite di piano. Qui
 * non c'è nessun blocco — mettere un tetto su numeri che nessuno ha ancora
 * guardato vuol dire scegliere una soglia a caso e spegnere una funzione a
 * qualcuno nel momento peggiore.
 *
 * ## Non può far fallire chi misura
 * Come `registraRisposta` in `aiClient.ts`: una scrittura fallita qui si logga
 * e basta. Una funzione che risponde all'utente non cade perché il contabile
 * ha avuto un problema.
 */
import { getSession, toNumber } from '@opengraphity/neo4j'
import { logger } from './logger.js'
import type { AIFeature } from './aiSettings.js'
import type { RispostaMisurabile } from './aiClient.js'

const log = logger.child({ module: 'ai-cost-ledger' })

export interface GettoniDelMese {
  tenantId: string
  month:    string
  feature:  string
  input:    number
  output:   number
  cacheRead:  number
  cacheWrite: number
  calls:    number
}

/** Il mese di un istante, come `YYYY-MM`. La chiave del registro insieme a tenant e funzione. */
export function meseDi(quando: Date = new Date()): string {
  return quando.toISOString().slice(0, 7)
}

/**
 * Somma i gettoni di una risposta sul contatore del mese.
 *
 * `MERGE` su (tenant, mese, funzione) e `+=` sui contatori: due processi che
 * scrivono insieme sommano, non si sovrascrivono. Il vincolo di unicità in
 * `init.ts` è ciò che rende vero questo `MERGE`.
 */
export const SOMMA_CYPHER = `
  MERGE (u:AIUsage {tenant_id: $tenantId, month: $month, feature: $feature})
    ON CREATE SET u.id = randomUUID(), u.input = 0, u.output = 0,
                  u.cache_read = 0, u.cache_write = 0, u.calls = 0,
                  u.created_at = $now
  SET u.input       = u.input       + $input,
      u.output      = u.output      + $output,
      u.cache_read  = u.cache_read  + $cacheRead,
      u.cache_write = u.cache_write + $cacheWrite,
      u.calls       = u.calls       + 1,
      u.updated_at  = $now
`

/**
 * Quel che si sa dei gettoni di una risposta, senza pretendere il tipo
 * dell'SDK: l'assistente usa l'anello degli strumenti e riceve tipi `Beta*`,
 * che hanno lo stesso `usage` ma non lo stesso nome.
 */
export function gettoniDi(risposta: RispostaMisurabile): Omit<GettoniDelMese, 'tenantId' | 'month' | 'feature' | 'calls'> {
  const u = risposta.usage as Partial<RispostaMisurabile['usage']> | undefined
  return {
    input:      u?.input_tokens ?? 0,
    output:     u?.output_tokens ?? 0,
    cacheRead:  u?.cache_read_input_tokens ?? 0,
    cacheWrite: u?.cache_creation_input_tokens ?? 0,
  }
}

/** Scrive una chiamata nel registro. Non alza mai. */
export async function registraCosto(
  tenantId: string, feature: AIFeature, risposta: RispostaMisurabile, quando: Date = new Date(),
): Promise<void> {
  const session = getSession(undefined, 'WRITE')
  try {
    await session.run(SOMMA_CYPHER, {
      tenantId, month: meseDi(quando), feature, now: quando.toISOString(), ...gettoniDi(risposta),
    })
  } catch (err) {
    log.warn({ tenantId, feature, err: err instanceof Error ? err.message : String(err) },
      'ai-cost-ledger: write failed, this call is not counted')
  } finally {
    await session.close()
  }
}

/** Il consumo di un cliente, un mese per riga, dal più recente. */
export async function consumoDi(tenantId: string, mesi = 12): Promise<GettoniDelMese[]> {
  const session = getSession()
  try {
    const r = await session.run(`
      MATCH (u:AIUsage {tenant_id: $tenantId})
      RETURN u.month AS month, u.feature AS feature, u.input AS input, u.output AS output,
             u.cache_read AS cacheRead, u.cache_write AS cacheWrite, u.calls AS calls
      ORDER BY u.month DESC, u.feature
      LIMIT toInteger($limite)
    `, { tenantId, limite: mesi * 12 })
    return r.records.map((rec) => ({
      tenantId,
      month:   rec.get('month') as string,
      feature: rec.get('feature') as string,
      input:      toNumber(rec.get('input')),
      output:     toNumber(rec.get('output')),
      cacheRead:  toNumber(rec.get('cacheRead')),
      cacheWrite: toNumber(rec.get('cacheWrite')),
      calls:      toNumber(rec.get('calls')),
    }))
  } finally {
    await session.close()
  }
}
