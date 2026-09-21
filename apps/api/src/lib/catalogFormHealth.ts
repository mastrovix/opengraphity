/**
 * I MODULI PUBBLICATI CHE NON SI POSSONO COMPILARE.
 *
 * La pubblicazione rifiuta le configurazioni impossibili (un campo che non è
 * in libreria, un obbligatorio che il portale non chiede, una condizione che
 * non potrebbe mai diventare vera). Ma un modulo pubblicato PRIMA che la
 * regola esistesse resta com'è, e un campo cancellato dalla libreria rompe un
 * modulo che ieri andava: il rifiuto arriva allora a chi apre la richiesta —
 * l'unica persona che non può rimediare.
 *
 * Questo controllo guarda i moduli come stanno adesso e dice quali sono da
 * sistemare, così l'amministratore lo scopre dalla diagnostica invece che da
 * un utente che si arrende (revisione del 17 set 2026: «il percorso dei moduli
 * non ha né un log né una metrica», e la diagnostica sapeva solo degli script
 * spenti).
 */
import type { Session } from 'neo4j-driver'
import { runQuery } from '@opengraphity/neo4j'
import { catalogFormFieldNames, type CatalogFormDefinition } from '@opengraphity/types'
import { formFields, parseCatalogForm, type FormFieldDef } from './catalogForm.js'

export interface ModuloDaSistemare {
  /** Il nome della voce di catalogo: è così che l'amministratore la cerca. */
  item:   string
  /** La chiave i18n del motivo, perché la frase la compone il client. */
  reason: 'fieldsMissing' | 'requiredNotForEndUser'
  /** I campi coinvolti, per nome interno: sono quelli da toccare nel costruttore. */
  fields: string[]
}

/** Il campo è obbligatorio in questo modulo (la voce vince sulla libreria). */
function obbligatorio(voce: { required?: boolean }, campo: FormFieldDef): boolean {
  return voce.required ?? campo.required
}

export async function catalogFormsToFix(session: Session, tenantId: string): Promise<ModuloDaSistemare[]> {
  const righe = await runQuery<{ name: string; form: string | null }>(session, `
    MATCH (i:ServiceCatalogItem {tenant_id: $tenantId})
    WHERE i.form IS NOT NULL AND coalesce(i.active, true) = true
    RETURN i.name AS name, i.form AS form
    ORDER BY toLower(i.name)`, { tenantId })
  if (righe.length === 0) return []

  const libreria = new Map((await formFields(session, tenantId)).map((f) => [f.name, f]))
  const out: ModuloDaSistemare[] = []
  for (const r of righe) {
    let def: CatalogFormDefinition | null
    try {
      def = parseCatalogForm(r.form, `ServiceCatalogItem ${r.name}`)
    } catch {
      // Un documento illeggibile è un'altra faccenda (lo dice `parseCatalogForm`
      // a chi apre il costruttore): qui non si finge di saperlo interpretare.
      continue
    }
    if (!def || def.revision === 0) continue

    const mancanti = catalogFormFieldNames(def).filter((n) => !libreria.has(n))
    if (mancanti.length > 0) out.push({ item: r.name, reason: 'fieldsMissing', fields: mancanti })

    const nonChiesti: string[] = []
    for (const s of def.sections) {
      for (const voce of s.items) {
        const campo = libreria.get(voce.field)
        if (!campo) continue                       // già detto sopra
        if (voce.endUser === false && obbligatorio(voce, campo)) nonChiesti.push(voce.field)
      }
    }
    if (nonChiesti.length > 0) out.push({ item: r.name, reason: 'requiredNotForEndUser', fields: nonChiesti })
  }
  return out
}
