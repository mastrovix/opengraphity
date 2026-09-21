/**
 * Il valore di un campo come lo legge chi guarda: l'etichetta del Dizionario
 * per un campo con vocabolario, l'etichetta del passo per lo stato di un
 * ticket. Giro nel browser del 14 set 2026 (#3, #11): widget e report
 * mostravano i valori interni («medium», «closed», «production») mentre il
 * resto del prodotto mostra le etichette.
 *
 * Un valore che il vocabolario non ha (o un campo senza vocabolario) resta
 * com'è: è il dato vero, non un'etichetta inventata.
 *
 * Il vocabolario si cerca in DUE posti (moduli del catalogo, ondata 5): il
 * metamodello, e — se lì non c'è — il catalogo dei widget, che porta anche i
 * campi della libreria dei moduli. Senza il secondo, un widget raggruppato su
 * «Ambiente» diceva «production» mentre la colonna della lista, due pagine più
 * in là, diceva «Produzione».
 */
import { useCallback, useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import { GET_ITIL_TYPES, GET_CI_TYPES, GET_WIDGET_CATALOG } from '@/graphql/queries'
import { isITILEntity } from '@/lib/automationOperators'
import { METAMODEL_FETCH_POLICY } from '@/lib/fetchPolicy'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'

interface TypeDef { name: string; fields: { name: string; enumTypeName?: string | null }[] }
/** Il catalogo dei widget chiama `entityType` quello che il metamodello chiama `name`. */
interface CatalogEntity { entityType: string; fields: { name: string; enumTypeName?: string | null }[] }

export function useFieldValueLabel(entityType: string | null | undefined, fieldName: string | null | undefined): (value: string) => string {
  const entity = entityType ?? ''
  const isITIL = isITILEntity(entity)
  const { data: itilData } = useQuery<{ itilTypes: TypeDef[] }>(GET_ITIL_TYPES, { skip: !entity || !fieldName || !isITIL, fetchPolicy: METAMODEL_FETCH_POLICY })
  const { data: ciData }   = useQuery<{ ciTypes: TypeDef[] }>(GET_CI_TYPES,   { skip: !entity || !fieldName || isITIL,  fetchPolicy: METAMODEL_FETCH_POLICY })
  const { data: catalogData } = useQuery<{ widgetCatalog: CatalogEntity[] }>(GET_WIDGET_CATALOG, { skip: !entity || !fieldName, fetchPolicy: METAMODEL_FETCH_POLICY })
  const { labelOf } = useDomainVocabularies()
  const { labelFor: stepLabel } = useWorkflowSteps(isITIL ? entity : '')

  const vocabulary = useMemo(() => {
    const types = isITIL ? itilData?.itilTypes : ciData?.ciTypes
    const dalMetamodello = types?.find((t) => t.name === entity)?.fields.find((f) => f.name === fieldName)?.enumTypeName
    if (dalMetamodello) return dalMetamodello
    // Il catalogo dei widget: ci sono anche i campi dei moduli del catalogo.
    return catalogData?.widgetCatalog.find((t) => t.entityType === entity)?.fields.find((f) => f.name === fieldName)?.enumTypeName ?? null
  }, [isITIL, itilData, ciData, catalogData, entity, fieldName])

  return useCallback((value: string) => {
    if (isITIL && fieldName === 'status') return stepLabel(value) || value
    return (vocabulary && labelOf(vocabulary, value)) || value
  }, [isITIL, fieldName, stepLabel, vocabulary, labelOf])
}
