/**
 * Le etichette dei tipi ITIL (incident, problem, change, service_request) come
 * le ha il cliente nel metamodello.
 *
 * Revisione del 14 set 2026 · F16: sei pagine avevano la loro tabella scritta a
 * mano («Service Request», «Problem»…), quindi un tipo rinominato nel designer
 * dei tipi ITIL restava col nome di fabbrica nelle automazioni, nelle policy
 * SLA, nei contratti OLA, nei workflow e nelle approvazioni.
 *
 * Un tipo che il metamodello non conosce si mostra col nome interno: è
 * riconoscibile come tale, e non si inventa un'etichetta. Finché il
 * metamodello non è arrivato (`ready` falso) vale lo stesso.
 */
import { useCallback, useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import { GET_ITIL_TYPES } from '@/graphql/queries'
import { METAMODEL_FETCH_POLICY } from '@/lib/fetchPolicy'

interface ItilTypeLabelRow { name: string; label: string | null }

export function useItilTypeLabels(): { labelOf: (entityType: string) => string; ready: boolean } {
  const { data } = useQuery<{ itilTypes: ItilTypeLabelRow[] }>(GET_ITIL_TYPES, { fetchPolicy: METAMODEL_FETCH_POLICY })
  const labels = useMemo(() => new Map((data?.itilTypes ?? []).map((t) => [t.name, t.label || t.name])), [data])
  const labelOf = useCallback((entityType: string) => labels.get(entityType) ?? entityType, [labels])
  return { labelOf, ready: data !== undefined }
}
