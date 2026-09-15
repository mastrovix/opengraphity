/**
 * I campi del cliente che il portale offre all'utente finale (verifica «Cosa
 * resta cablato», ondata 4): solo quelli che l'amministratore ha marcato
 * «Offrilo nel portale», con le etichette nella lingua attiva.
 */
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { GET_PORTAL_CUSTOM_FIELDS } from '@/graphql/queries'

export interface PortalCustomField {
  name: string; label: string; fieldType: string; required: boolean
  options: { value: string; label: string }[]
}

/**
 * `category`: la categoria scelta nel modulo. I campi offerti sono quelli che si
 * modificano nella fase iniziale del workflow di quella categoria, la stessa
 * regola con cui l'API poi li accetta (secondo giro UI del 15 set 2026).
 */
export function usePortalCustomFields(entityType: 'incident' | 'service_request', category: string | null = null) {
  const { i18n } = useTranslation()
  const { data, loading, error, previousData } = useQuery<{ portalCustomFields: PortalCustomField[] }>(GET_PORTAL_CUSTOM_FIELDS, {
    variables: { entityType, category: category || null, language: i18n.resolvedLanguage ?? i18n.language },
  })
  // Mentre la categoria cambia, il modulo tiene i campi di prima invece di svuotarsi.
  const shown = data ?? previousData
  return { fields: shown?.portalCustomFields ?? [], loading, error }
}

/** Da `{nome: valore}` a quello che l'API vuole: tutti i campi offerti, il vuoto come null. */
export function portalCustomFieldsInput(fields: readonly PortalCustomField[], values: Record<string, string>) {
  return fields.map((f) => ({ name: f.name, value: (values[f.name] ?? '').trim() === '' ? null : (values[f.name] ?? '').trim() }))
}

/** I campi obbligatori senza valore. */
export function portalMissingCustomFields(fields: readonly PortalCustomField[], values: Record<string, string>): string[] {
  return fields.filter((f) => f.required && (values[f.name] ?? '').trim() === '').map((f) => f.name)
}
