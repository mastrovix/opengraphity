/**
 * Cosa può fare nel portale chi è collegato (ondata 7 di «Nulla cablato»): i
 * permessi del suo ruolo, non il nome del ruolo. `portal.read` apre il portale
 * (i propri ticket, il catalogo, la knowledge base), `portal.submit` apre ticket
 * e richieste, risponde, riapre. Finché `me` non risponde non si nasconde e non
 * si nega niente (`loading`).
 */
import { useQuery } from '@apollo/client/react'
import { GET_ME } from '@/graphql/queries'

interface MeData { me: { id: string; permissions: string[] } | null }

export function usePortalAccess() {
  const { data, loading } = useQuery<MeData>(GET_ME)
  const permissions = data?.me?.permissions ?? []
  return {
    loading:   loading && !data,
    canRead:   permissions.includes('portal.read'),
    canSubmit: permissions.includes('portal.submit'),
  }
}
