/**
 * Il valore di un campo come lo legge chi guarda: l'etichetta del Dizionario
 * per un campo con vocabolario, l'etichetta del passo per lo stato di un
 * ticket. Giro nel browser del 14 set 2026 (#3, #11): widget e report
 * mostravano i valori interni («medium», «closed», «production») mentre il
 * resto del prodotto mostra le etichette.
 *
 * Un valore che il vocabolario non ha (o un campo senza vocabolario) resta
 * com'è: è il dato vero, non un'etichetta inventata.
 */
import { useCallback, useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import { GET_ITIL_TYPES, GET_CI_TYPES } from '@/graphql/queries'
import { isITILEntity } from '@/lib/automationOperators'
import { METAMODEL_FETCH_POLICY } from '@/lib/fetchPolicy'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'

interface TypeDef { name: string; fields: { name: string; enumTypeName?: string | null }[] }

export function useFieldValueLabel(entityType: string | null | undefined, fieldName: string | null | undefined): (value: string) => string {
  const entity = entityType ?? ''
  const isITIL = isITILEntity(entity)
  const { data: itilData } = useQuery<{ itilTypes: TypeDef[] }>(GET_ITIL_TYPES, { skip: !entity || !fieldName || !isITIL, fetchPolicy: METAMODEL_FETCH_POLICY })
  const { data: ciData }   = useQuery<{ ciTypes: TypeDef[] }>(GET_CI_TYPES,   { skip: !entity || !fieldName || isITIL,  fetchPolicy: METAMODEL_FETCH_POLICY })
  const { labelOf } = useDomainVocabularies()
  const { labelFor: stepLabel } = useWorkflowSteps(isITIL ? entity : '')

  const vocabulary = useMemo(() => {
    const types = isITIL ? itilData?.itilTypes : ciData?.ciTypes
    return types?.find((t) => t.name === entity)?.fields.find((f) => f.name === fieldName)?.enumTypeName ?? null
  }, [isITIL, itilData, ciData, entity, fieldName])

  return useCallback((value: string) => {
    if (isITIL && fieldName === 'status') return stepLabel(value) || value
    return (vocabulary && labelOf(vocabulary, value)) || value
  }, [isITIL, fieldName, stepLabel, vocabulary, labelOf])
}
