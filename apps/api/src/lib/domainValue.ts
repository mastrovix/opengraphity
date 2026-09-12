/**
 * Tradurre **e** controllare il risultato (ondata 7).
 *
 * ## Il buco che questo chiude
 * `resolveDomainMatrix` (nucleo) valida la **chiave**: una combinazione che la
 * matrice non copre è un errore che la nomina. Ma il **valore** salvato nella
 * cella non lo controlla nessuno, e dal vivo (12 set 2026, su `c-two`) si vede
 * cosa vuol dire: rinominati i valori di `impact` in `basso/medio/alto`, la
 * matrice `service_impact` continua a contenere `high` — la chiave
 * (`mission_critical`) è ancora buona, il valore no — e `serviceImpactOf`
 * restituiva `high`, un impatto che il Dizionario di quel cliente non ha più.
 *
 * Sul cammino dell'incident il guasto poi emerge (chi scrive l'impatto lo
 * valida), ma sull'**import dei ticket** no: la severità tradotta finisce nel
 * Cypher senza passare da nessuna validazione, e un import di mille righe
 * scriverebbe mille ticket con una severità fantasma — in silenzio, che è
 * esattamente il difetto dell'ondata.
 *
 * Quindi: chi usa una matrice per scrivere passa da qui, non da
 * `resolveDomainMatrix` diretto. Il costo è zero (il vocabolario è già in
 * cache) e il messaggio dice quale cella è da correggere, con la strada.
 */
import { ValidationError } from './errors.js'
import {
  DOMAIN_MATRIX_KINDS, assertDomainValue, domainVocabulary, matrixKey,
  resolveDomainMatrix, type DomainMatrixKind,
} from './domainMatrix.js'

/**
 * Come `resolveDomainMatrix`, ma il valore d'uscita è controllato contro il
 * vocabolario che il tipo di matrice dichiara. Una cella rimasta su un valore
 * vecchio dopo una rinomina è un errore che nomina la cella.
 */
export async function resolveDomainValue(
  tenantId: string, kind: DomainMatrixKind, ...values: readonly string[]
): Promise<string> {
  const out  = await resolveDomainMatrix(tenantId, kind, ...values)
  const spec = DOMAIN_MATRIX_KINDS[kind]
  const allowed = await domainVocabulary(tenantId, spec.output)
  if (!allowed.includes(out)) {
    throw new ValidationError(
      `Matrice "${kind}", cella "${matrixKey(...values)}": il valore salvato "${out}" non è (più) nel vocabolario ` +
      `"${spec.output}" di questo cliente. Ammessi: ${allowed.join(', ')}. ` +
      `Succede quando si rinomina un valore del vocabolario senza aggiornare la matrice: ` +
      `correggila in Impostazioni → Matrici di dominio.`,
    )
  }
  return out
}

/** Riesportato per chi ha bisogno della sola validazione di un valore. */
export { assertDomainValue }
