/**
 * PRIMA DI CREARE UN TICKET: una policy SLA lo copre?
 *
 * Non esistono policy SLA di fabbrica: un ticket che nessuna policy del tenant
 * copre nasce senza SLA. Chi lo crea deve saperlo PRIMA, e decidere: tornare
 * indietro (e cambiare categoria, o chiedere una policy) oppure creare il
 * ticket senza SLA. Se accetta, il ticket porta la sua accettazione e la
 * diagnostica di configurazione non lo conta.
 *
 * La risposta viene dall'API (`slaCoverage`), che usa lo stesso selettore del
 * motore SLA: una copia della regola qui potrebbe dire «coperto» a un ticket
 * che poi nasce senza SLA.
 */
import { useApolloClient } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { GET_SLA_COVERAGE } from '@/graphql/queries'
import { useConfirm } from '@/hooks/useConfirm'

export type SlaCoverageDecision =
  /** Una policy copre il ticket: si crea normalmente. */
  | 'covered'
  /** Nessuna policy, e chi crea ha accettato: si crea con `acknowledgeNoSla`. */
  | 'accepted'
  /** Nessuna policy, e chi crea è tornato indietro: non si crea. */
  | 'cancelled'

export interface SlaCoverageInput {
  entityType: 'incident' | 'problem' | 'service_request'
  priority: string
  priorityLabel: string
  category: string | null
  categoryLabel: string | null
  teamId: string | null
  teamName: string | null
}

/** Lancia se la verifica non si può fare: non si crea un ticket «alla cieca». */
export function useSlaCoverageCheck(): (input: SlaCoverageInput) => Promise<SlaCoverageDecision> {
  const client = useApolloClient()
  const confirm = useConfirm()
  const { t } = useTranslation()

  return async (input) => {
    const { data } = await client.query<{ slaCoverage: { policyId: string; policyName: string } | null }>({
      query: GET_SLA_COVERAGE,
      variables: { entityType: input.entityType, priority: input.priority, category: input.category, teamId: input.teamId },
      fetchPolicy: 'network-only',
    })
    if (!data) throw new Error('slaCoverage: no data')
    if (data.slaCoverage) return 'covered'

    const params = {
      priority: input.priorityLabel,
      category: input.categoryLabel ?? t('pages.createTicket.noSla.anyCategory'),
      team: input.teamName ?? '',
    }
    // Chiavi letterali per tipo (il guardiano delle traduzioni le verifica così):
    // articolo e genere cambiano fra «questo incident» e «questa service request».
    const testi = {
      incident: {
        title: t('pages.createTicket.noSla.incident.title'),
        body: input.teamName ? t('pages.createTicket.noSla.incident.bodyTeam', params) : t('pages.createTicket.noSla.incident.body', params),
        hint: t('pages.createTicket.noSla.incident.hint'),
      },
      problem: {
        title: t('pages.createTicket.noSla.problem.title'),
        body: input.teamName ? t('pages.createTicket.noSla.problem.bodyTeam', params) : t('pages.createTicket.noSla.problem.body', params),
        hint: t('pages.createTicket.noSla.problem.hint'),
      },
      service_request: {
        title: t('pages.createTicket.noSla.service_request.title'),
        body: t('pages.createTicket.noSla.service_request.body', params),
        hint: t('pages.createTicket.noSla.service_request.hint'),
      },
    }[input.entityType]
    const ok = await confirm({
      title: testi.title,
      body: (
        <>
          <p style={{ margin: '0 0 8px' }}>{testi.body}</p>
          <p style={{ margin: 0 }}>{testi.hint}</p>
        </>
      ),
      confirmLabel: t('pages.createTicket.noSla.confirm'),
      cancelLabel: t('pages.createTicket.noSla.cancel'),
    })
    return ok ? 'accepted' : 'cancelled'
  }
}
