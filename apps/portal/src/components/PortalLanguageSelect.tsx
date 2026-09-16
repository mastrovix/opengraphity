/**
 * La lingua della persona dal portale (secondo giro UI del 15 set 2026). Chi apre
 * il portale non ha il Profilo del web, e la scelta non aveva un posto: si
 * leggeva la lingua dell'organizzazione e basta. La scelta si salva sulla
 * persona (`setMyLanguage`), la stessa che legge il web. I nomi delle lingue
 * sono scritti ciascuno nella propria lingua, come si usa nei selettori.
 */
import { useId } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n/i18n'
import { GET_ME, GET_TENANT_LANGUAGE_SETTINGS } from '@/graphql/queries'
import { SET_MY_LANGUAGE } from '@/graphql/mutations'
import { colors } from '@/lib/tokens'

const ORGANIZATION = 'organization'

export function PortalLanguageSelect() {
  const { t } = useTranslation()
  const id = useId()
  const { data: meData } = useQuery<{ me: { language: string | null } | null }>(GET_ME)
  const { data: settings } = useQuery<{ tenantLanguageSettings: { available: string[]; defaultLanguage: string | null } }>(GET_TENANT_LANGUAGE_SETTINGS, { fetchPolicy: 'cache-first' })
  const [save, { error }] = useMutation(SET_MY_LANGUAGE, { refetchQueries: [GET_ME] })
  /**
   * Le lingue le decide l'ORGANIZZAZIONE (revisione totale · H-40): qui c'era
   * un ripiego `['en', 'it']` che, finche la query non rispondeva, offriva
   * lingue che l'organizzazione potrebbe non aver abilitato — un fallback
   * silenzioso, contro la regola. Senza risposta il menu offre solo «lingua
   * dell'organizzazione», che e sempre vera.
   */
  const available = settings?.tenantLanguageSettings.available ?? []
  const current = meData?.me?.language ?? ORGANIZATION

  const onChange = async (value: string) => {
    const language = value === ORGANIZATION ? null : value
    try {
      await save({ variables: { language } })
    } catch { return }
    const next = language ?? settings?.tenantLanguageSettings.defaultLanguage ?? null
    if (next && i18n.language !== next) await i18n.changeLanguage(next)
  }

  return (
    <div style={{ padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label htmlFor={id} style={{ fontSize: 10, color: colors.slate }}>{t('portal.language')}</label>
      <select id={id} value={current} onChange={(e) => void onChange(e.target.value)} style={{ fontSize: 12, padding: '4px 6px', border: `1px solid ${colors.border}`, borderRadius: 6 }}>
        <option value={ORGANIZATION}>{t('portal.languageOrganization')}</option>
        {available.map((l) => <option key={l} value={l}>{t(`portal.languageName.${l}`, { defaultValue: l })}</option>)}
      </select>
      {error && <span role="alert" style={{ fontSize: 10, color: colors.danger }}>{t('portal.languageSaveFailed', { error: error.message })}</span>}
    </div>
  )
}
