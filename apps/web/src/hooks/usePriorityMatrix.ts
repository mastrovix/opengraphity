/**
 * La matrice della priorità **del cliente** (revisione delle otto ondate ·
 * C·N-3).
 *
 * Il web teneva una copia della matrice 3×3 in `lib/priority.ts`, con i valori
 * di impatto e urgenza scritti a mano. Ma la matrice è dato del cliente
 * dall'ondata 7, e i vocabolari si possono rinominare: chi lo faceva vedeva nel
 * form i tre bottoni vecchi e ogni invio veniva rifiutato dal server. La query
 * `domainMatrices` esisteva già e restituisce sia le celle sia i valori
 * ammessi: qui si usa quella.
 *
 * `fetchPolicy: 'cache-first'` come per gli altri metamodelli: la matrice
 * cambia raramente e la pagina delle Matrici di dominio la riscrive quando
 * serve.
 */
import { useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import { GET_DOMAIN_MATRICES } from '@/graphql/queries'
import type { PriorityMatrix } from '@/lib/priority'

interface MatrixOut {
  kind:         string
  inputs:       string[]
  output:       string
  inputValues:  string[][]
  outputValues: string[]
  cells:        { key: string; inputs: string[]; value: string | null }[]
}

export function usePriorityMatrix(): { matrix: PriorityMatrix | null; loading: boolean; error: Error | null } {
  const { data, loading, error } = useQuery(GET_DOMAIN_MATRICES, { fetchPolicy: 'cache-first' })

  const matrix = useMemo<PriorityMatrix | null>(() => {
    const all = (data as { domainMatrices?: MatrixOut[] } | undefined)?.domainMatrices
    const m = all?.find((x) => x.kind === 'priority')
    if (!m) return null
    return {
      impacts:    m.inputValues[0] ?? [],
      urgencies:  m.inputValues[1] ?? [],
      priorities: m.outputValues,
      cells:      m.cells,
    }
  }, [data])

  return { matrix, loading, error: error ?? null }
}
