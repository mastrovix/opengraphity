/**
 * Le severità che l'utente può scegliere aprendo un ticket: quelle che
 * l'amministratore offre nel portale, con le sue parole, nella lingua attiva
 * (verifica «Cosa resta cablato», ondata 1). Prima erano `low / medium / high`
 * scritti nella pagina, con `medium` già selezionato.
 */
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { GET_PORTAL_SEVERITY_CHOICES } from '@/graphql/queries'

export interface PortalSeverityChoice { value: string; label: string; color: string | null }

export function usePortalSeverityChoices() {
  const { i18n } = useTranslation()
  const { data, loading, error } = useQuery<{ portalSeverityChoices: PortalSeverityChoice[] }>(GET_PORTAL_SEVERITY_CHOICES, {
    variables: { language: i18n.resolvedLanguage ?? i18n.language },
  })
  return { choices: data?.portalSeverityChoices ?? [], loading, error }
}
